#!/usr/bin/env python3
"""Build map/melbourne-network.json — the background map for the test page.

Three layers, all clipped to the same 12 km box around Flinders Street and
quantised onto the same 10 m grid, so they overlay exactly:

  road   Vicmap Transport TR_ROAD_ALL, classes 0-4 (freeway to collector).
         Local streets (class 5) are omitted — 220k of them, illegible at
         this scale and ten times the payload.
  tram   PTV GTFS feed 3, Metropolitan Tram.
  train  PTV GTFS feed 2, Metropolitan Train.

Sources are the copies already in the thesis repo. Both are CC-BY 4.0 and
the page carries the attribution; keep it there.

    ps_thesis/spatial_data/tr_road/Order_I2F4YY/.../TR_ROAD_ALL.shp
    ps_thesis/spatial_data/gtfs/gtfs/{2,3}/google_transit/

One-off: run it, commit the JSON, forget about it. The script itself is
never deployed; its output is, as part of map/.

The background is not on the main site. It lives on the test page under
map/, so the output goes there rather than into data/, which is the site's
own content.

Roads get small by three tricks, in order of how much they matter:

  1. linemerge. Vicmap splits roads at every intersection and attribute
     change, so the raw clip is ~17.9k stubs each paying for an absolute
     start coordinate. Merging runs that meet end-to-end at degree 2, while
     leaving genuine junctions alone, drops it to ~2.7k polylines.
  2. Quantisation to a 10 m grid. The clip renders into a few hundred CSS
     pixels, so a pixel is ~50 m of ground and 10 m is already far finer
     than anything visible. It exists to make the deltas small integers.
  3. Delta encoding — after the first vertex, every coordinate is a step
     from the previous one, so most are single digits.

Transit needs none of that: GTFS ships one shape per trip variant, thousands
of near-identical copies per route, so the win is picking ONE representative
shape per route. The longest, which is the most complete variant. That takes
40 routes down to 40 polylines and the whole layer costs a couple of KB.
"""

import csv
import gzip
import json
import pathlib
import sys
from collections import defaultdict

import numpy as np
import pyogrio
import pyproj
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

THESIS = pathlib.Path("/home/ps/Documents/r_projects/ps_thesis/spatial_data")
ROADS = (
    THESIS / "tr_road/Order_I2F4YY/mga2020_55/esrishape/customised_delivery"
    "/MELBOURNE_WATER-0/VMTRANS/TR_ROAD_ALL.shp"
)
GTFS = THESIS / "gtfs/gtfs"
OUT = pathlib.Path(__file__).resolve().parent.parent / "map" / "melbourne-network.json"

# Flinders Street in MGA2020 zone 55. The Vicmap layer is already projected
# in metres; GTFS is WGS84 and gets reprojected onto the same grid below.
ORIGIN = (321000, 5813000)
RADIUS = 12000
MAX_CLASS = 4
SIMPLIFY = 20
QUANT = 10

# GTFS feed number -> layer name. 2 and 3 are Metro Train and Metro Tram in
# the PTV feed; 1/4/5/6/10/11 are regional and bus, which we don't want.
FEEDS = {"train": "2", "tram": "3"}

to_mga = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:7855", always_xy=True)

BOX = (ORIGIN[0] - RADIUS, ORIGIN[1] - RADIUS, ORIGIN[0] + RADIUS, ORIGIN[1] + RADIUS)


def encode(coords, cls=0):
    """Absolute metre coordinates -> [cls, x0, y0, dx, dy, ...] on the grid."""
    q = np.round((np.asarray(coords) - np.asarray(ORIGIN)) / QUANT).astype(int)
    # Quantising can collapse neighbours onto one cell; drop the duplicates
    # or the deltas come out as meaningless zeros.
    keep = np.concatenate(([True], np.any(np.diff(q, axis=0) != 0, axis=1)))
    q = q[keep]
    if len(q) < 2:
        return None
    return [cls, int(q[0, 0]), int(q[0, 1])] + np.diff(q, axis=0).ravel().tolist()


def build_roads():
    gdf = pyogrio.read_dataframe(ROADS, columns=["CLASS_CODE"], bbox=BOX)
    gdf = gdf[gdf.CLASS_CODE <= MAX_CLASS]
    print(f"road   read {len(gdf):>6} segments")

    lines = []
    # Merge per class so each polyline keeps its road class and the renderer
    # can weight freeways above collectors. A road changing class is a real
    # break, so this costs nothing.
    for cls, group in gdf.groupby("CLASS_CODE"):
        merged = linemerge(MultiLineString(list(group.geometry)))
        parts = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
        for part in parts:
            line = encode(part.simplify(SIMPLIFY).coords, int(cls))
            if line:
                lines.append(line)

    print(f"road   {len(lines):>6} polylines after linemerge")
    return lines


def to_minutes(hhmmss):
    """GTFS clock time -> minutes past midnight, wrapped into a single day.

    Times past 24:00:00 are the tail of a service day (a 25:30 departure is
    1:30am the next morning). Wrapping means Saturday 2am shows the Friday
    Night Network, which is what actually runs.
    """
    h, m, s = (int(p) for p in hhmmss.split(":"))
    return (h * 60 + m + (1 if s >= 30 else 0)) % 1440


def canonical_services(d):
    """Pick one representative service_id per weekday.

    PTV emits dozens of near-duplicate calendars covering a week or two each.
    For each day we want the pattern with the widest date range, which is the
    ongoing timetable rather than a one-off variation.

    Returns a 7-element list, Monday first, to match the order used below.
    """
    DAYS = ["monday", "tuesday", "wednesday", "thursday",
            "friday", "saturday", "sunday"]
    with open(d / "calendar.txt", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))

    picked = []
    for day in DAYS:
        runs = [r for r in rows if r[day] == "1"]
        if not runs:
            picked.append(None)
            continue
        picked.append(
            max(runs, key=lambda r: int(r["end_date"]) - int(r["start_date"]))["service_id"]
        )
    return picked


def headway_bands(departures):
    """Sorted departure minutes -> [[startMin, endMin, headwayMin], ...].

    One band per hour, carrying the median gap between consecutive departures
    starting in that hour, then adjacent hours with the same headway are
    merged. Hours with no service produce no band at all, which is how the
    network empties out overnight.
    """
    if len(departures) < 2:
        return []

    gaps = defaultdict(list)
    for a, b in zip(departures, departures[1:]):
        gap = b - a
        if 0 < gap <= 120:      # ignore the wrap at the end of the day
            gaps[a // 60].append(gap)

    bands = []
    for hour in sorted(gaps):
        g = sorted(gaps[hour])
        headway = max(1, round(g[len(g) // 2]))
        if bands and bands[-1][1] == hour * 60 and bands[-1][2] == headway:
            bands[-1][1] = (hour + 1) * 60      # extend the previous band
        else:
            bands.append([hour * 60, (hour + 1) * 60, headway])
    return bands


def build_transit(name, feed):
    d = GTFS / feed / "google_transit"

    with open(d / "routes.txt", encoding="utf-8-sig") as fh:
        routes = {
            r["route_id"]: r
            for r in csv.DictReader(fh)
            # Rail replacement buses ride under the train feed and would draw
            # as spurious "train lines" along ordinary roads.
            if r.get("route_short_name") != "Replacement Bus"
        }

    services = canonical_services(d)
    keep_services = {s for s in services if s}

    # Group trips by route+direction — a route's two directions get their own
    # geometry and their own timetable, since they're rarely symmetric.
    trips = {}
    variant_shapes = defaultdict(lambda: defaultdict(int))
    with open(d / "trips.txt", encoding="utf-8-sig") as fh:
        for t in csv.DictReader(fh):
            if t["route_id"] not in routes or not t.get("shape_id"):
                continue
            key = (t["route_id"], t.get("direction_id", "0"))
            trips[t["trip_id"]] = (key, t["service_id"], t["shape_id"])
            if t["service_id"] in keep_services:
                variant_shapes[key][t["shape_id"]] += 1

    # Pass 1 over shapes.txt: count points per shape without holding any.
    # The train file is 75 MB, so this stays streaming.
    shape_len = defaultdict(int)
    with open(d / "shapes.txt", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            shape_len[row["shape_id"]] += 1

    # The longest shape is the most complete variant of a route+direction.
    chosen = {
        key: max(shapes, key=lambda s: shape_len.get(s, 0))
        for key, shapes in variant_shapes.items()
        if shapes
    }
    wanted_shapes = set(chosen.values())

    # One representative trip per variant, to lift the speed profile from.
    rep_trip = {}
    for tid, (key, service, shape) in trips.items():
        if key in chosen and shape == chosen[key] and key not in rep_trip:
            rep_trip[key] = tid
    rep_trips = {t: k for k, t in rep_trip.items()}

    # Pass 2: shape geometry for the chosen variants.
    pts = defaultdict(list)
    with open(d / "shapes.txt", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            if row["shape_id"] in wanted_shapes:
                pts[row["shape_id"]].append((
                    int(row["shape_pt_sequence"]),
                    float(row["shape_pt_lon"]),
                    float(row["shape_pt_lat"]),
                ))

    # Single pass over stop_times: first departure of every trip (for the
    # headways) and the full stop list of the representative trips (for the
    # speed profiles). The tram file is 300 MB, so this stays streaming and
    # holds only what it needs.
    first_dep, profiles = {}, defaultdict(list)
    with open(d / "stop_times.txt", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            tid = row["trip_id"]
            if tid not in trips:
                continue
            seq = int(row["stop_sequence"])
            prev = first_dep.get(tid)
            if prev is None or seq < prev[0]:
                first_dep[tid] = (seq, row["departure_time"])
            if tid in rep_trips and row.get("shape_dist_traveled"):
                profiles[rep_trips[tid]].append(
                    (seq, float(row["shape_dist_traveled"]), row["arrival_time"])
                )

    out = []
    for key, shape in chosen.items():
        raw = sorted(pts.get(shape, []))
        if len(raw) < 2:
            continue
        x, y = to_mga.transform([p[1] for p in raw], [p[2] for p in raw])

        # Transit is deliberately NOT clipped to the road box: vehicles need
        # somewhere to run, and it means the lines reach their termini
        # instead of stopping mid-route. Framing comes from the roads alone.
        line = encode(LineString(list(zip(x, y))).simplify(SIMPLIFY).coords)
        if not line:
            continue

        stops = sorted(profiles.get(key, []))
        if len(stops) < 2:
            continue
        total_d = stops[-1][1] - stops[0][1]
        t0 = to_minutes(stops[0][2])
        total_t = (to_minutes(stops[-1][2]) - t0) % 1440
        if total_d <= 0 or total_t <= 0:
            continue

        # Normalised (distance, time) pairs. Both run 0..1, so the renderer
        # interpolates without needing to know the route's real length. This
        # is what makes vehicles crawl through the CBD and open up outside.
        profile = [
            [round((s[1] - stops[0][1]) / total_d, 4),
             round(((to_minutes(s[2]) - t0) % 1440) / total_t, 4)]
            for s in stops
        ]

        # Per weekday: the departure times of that day's canonical service.
        band_sets, day_index = [], []
        for service in services:
            deps = sorted(
                to_minutes(dep)
                for tid, (k, sv, _) in trips.items()
                if k == key and sv == service and tid in first_dep
                for dep in [first_dep[tid][1]]
            )
            bands = headway_bands(deps)
            if bands in band_sets:
                day_index.append(band_sets.index(bands))
            else:
                band_sets.append(bands)
                day_index.append(len(band_sets) - 1)

        out.append({
            "g": line[1:],          # drop the class byte; transit has no classes
            "p": profile,
            "t": total_t,           # end-to-end runtime, minutes
            "b": band_sets,
            "d": day_index,         # weekday (Mon-first) -> index into b
        })

    print(f"{name:<6} {len(routes):>3} routes -> {len(out):>3} directional variants")
    return out


def main():
    if not ROADS.exists():
        sys.exit(f"missing road data: {ROADS}")

    payload = {
        "note": (
            "Vicmap Transport TR_ROAD_ALL and PTV GTFS, "
            "(c) State of Victoria, CC-BY 4.0"
        ),
        "origin": list(ORIGIN),  # MGA2020 zone 55, metres
        "quant": QUANT,          # multiply stored units by this for metres
        # [class, x0, y0, dx, dy, ...] per line, in quantised units. Framing
        # is derived from these alone, so transit can run past the box.
        "roads": build_roads(),
        "transit": {name: build_transit(name, feed) for name, feed in FEEDS.items()},
    }

    raw = json.dumps(payload, separators=(",", ":")).encode()
    OUT.write_bytes(raw)
    print(
        f"wrote  map/{OUT.name}  "
        f"{len(raw)/1024:.0f} KB raw, {len(gzip.compress(raw, 9))/1024:.0f} KB gzipped"
    )


if __name__ == "__main__":
    main()
