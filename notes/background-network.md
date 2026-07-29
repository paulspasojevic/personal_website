# Background network — assumptions, limitations, lessons

Written 2026-07-29, alongside commits `19983c7` and `5be67df`.

The background map is built by `tools/build-network.py` into
`data/melbourne-network.json` and drawn by `js/network.js`. Sources are the
copies in the thesis repo:

    ps_thesis/spatial_data/tr_road/Order_I2F4YY/.../TR_ROAD_ALL.shp
    ps_thesis/spatial_data/gtfs/gtfs/2/google_transit/   (Metro Train)
    ps_thesis/spatial_data/gtfs/gtfs/3/google_transit/   (Metro Tram)

Regenerate with `python3 tools/build-network.py`, then commit the JSON. The
script is not deployed — `deploy.sh` only uploads `index.html`, `css/`,
`js/`, `data/` and `fonts/`.

Both sources are CC-BY 4.0. The footer credit is a licence condition, not a
courtesy. It has to stay as long as the background does.

---

## Assumptions baked into the data

These are decisions, not facts. Any of them could be revisited.

**One shape per route+direction.** GTFS carries a separate shape for every
trip variant — thousands per route. `build_transit` picks the one with the
most points, on the theory that the longest variant is the most complete.
Consequence: **branches and short workings are not drawn at all.** A route
that splits has only one arm on the map.

**Headway = median gap per hour.** `headway_bands` buckets consecutive
departures by the hour they start in, takes the median gap, and merges
adjacent hours that agree. A route with genuinely irregular service gets
smoothed into something more regular than it is.

**Hours with no departures produce no band.** This is what makes 3am empty
rather than needing a rule for it. It also means a route with a single
overnight trip in an hour produces no band for that hour, because one
departure yields no gap.

**Times past 24:00:00 are wrapped mod 1440.** A 25:30 departure becomes
01:30 and stays attached to the *originating* service day. In practice this
puts the Friday Night Network on Friday's band set at 01:00–05:00, which
displays on a Friday. Real Friday-night services run into Saturday morning.
The visual result is roughly right but the day attribution is off by one for
post-midnight trips.

**Canonical service = widest date range.** `canonical_services` picks, for
each weekday, the `calendar.txt` row covering that day with the largest
`end_date - start_date`. PTV emits dozens of near-duplicate calendars for
one- and two-week windows; this grabs the ongoing timetable and ignores the
short-lived variations.

**`calendar_dates.txt` is ignored entirely.** No public holidays, no service
exceptions. Christmas Day renders as an ordinary weekday.

**Rail replacement buses are filtered by name** — `route_short_name !=
"Replacement Bus"`. If PTV renames them, they'll reappear as spurious "train
lines" running along ordinary roads. Worth re-checking after any feed update.

**`direction_id` is assumed meaningful.** Both feeds populate it. If a future
feed doesn't, every route collapses to one direction.

**One speed profile per route+direction**, lifted from a single
representative trip's `stop_times` via `shape_dist_traveled`, and applied to
every vehicle on that route regardless of time of day. Real dwell times and
running times vary between peak and off-peak; this doesn't.

**Roads: `CLASS_CODE` 0–4, 12km of Flinders Street.** Class 5 is local
streets — 220k of them, illegible at this scale and ~10x the payload.
`RADIUS` and `MAX_CLASS` are both consts at the top of the script.

---

## Assumptions in the renderer

**Vehicles are evenly spaced within the current band.** `drawVehicles`
computes `count = ceil(runtime / headway)` and tiles ages across that
window, offset by a golden-ratio phase per route. It does **not** use real
departure times — vehicles are not on the timetable individually, only in
aggregate.

Two consequences:
1. At a band boundary the spacing *snaps*, because in-flight vehicles are
   re-derived from the new headway rather than keeping the departure time
   they actually left at. Visible on the hour if you look for it.
2. The phase offset is arbitrary. Two routes sharing a corridor won't
   interleave the way the real timetable interleaves them.

**`TIME_SCALE = 5`** — five minutes of Melbourne time per real second. At
1 the motion is invisible (a tram crosses the visible band in ~17 minutes).
The clock is anchored to real Melbourne time *on load* and drifts from there,
so a long-open tab is showing a fictional hour.

**Framing comes from the road bounds only.** Transit is deliberately
unclipped so lines reach their termini; letting it widen the bounds would
zoom the map out to fit track nobody can see. See `decode`.

---

## Known limitations

- **Vehicle counts undercount.** ~232 trams at Wednesday 8am against a real
  fleet of roughly 500 in service. One variant per route+direction is most
  of the gap.
- **Roads stop dead at the 12km box edge.** Transit doesn't, so at the
  fringes you get rail lines crossing empty space.
- **No realtime.** This is the published timetable, not what's actually
  running. Disruptions, cancellations and delays are invisible.
- **Payload is 171KB raw / 48KB gzipped.** Verify the host gzips
  `application/json` — that gap is big enough to matter.
- **Nothing renders below 68rem.** Both canvases are `display: none` and the
  JS checks that before doing any work.

---

## If you come back to the headway bands

The bands are the weakest part. In rough order of value:

1. **Store real departure times instead of bands.** Delta-encoded minutes
   per route+direction, maybe 15–30KB gzipped on top of what's there. This
   fixes the band-boundary snap, the arbitrary phase, and the irregular-service
   smoothing all at once, because each vehicle then has an actual departure.
   The renderer change is small: replace the `count`/`age` tiling in
   `drawVehicles` with a search over departures within `[now - runtime, now]`.

2. **If you keep bands, store the first departure per band** and phase off
   that rather than the golden-ratio offset. Cheap, and makes the spacing
   correct at band starts.

3. **Multiple shapes per route** to get branches. Pick the longest shape per
   `(route, direction, headsign)` rather than per `(route, direction)` —
   `trip_headsign` is already in `trips.txt` and is the natural branch key.

4. **`calendar_dates.txt`** for public holidays. Cheap to add, and Melbourne
   holiday timetables are visibly different.

5. **Per-band speed profiles** so peak running times differ from off-peak.
   Probably not worth it at this visual scale.

### Validate any change against these numbers

The current build produces, with `active() = runtime / headway`:

| | 03:00 | 08:00 | 12:00 | 17:00 | 22:00 |
|---|---|---|---|---|---|
| Wed trains | 6 | 192 | 87 | 188 | 65 |
| Wed trams | 0 | 232 | 204 | 227 | 96 |
| Sun trains | 24 | 60 | 84 | 83 | 65 |
| Sun trams | 20 | 95 | 174 | 157 | 70 |

The load-bearing checks are: **zero trams at 3am midweek**, **nonzero on
Sunday morning** (Night Network), and a **visible midday dip** in trains.
If a change breaks any of those, the band extraction is wrong.

Tram headways should come out 4–21 minutes on a weekday. If the minimum
drifts far below 4 you're probably counting the same departure twice; far
above 6 and you've lost the high-frequency routes.

---

## Lessons learned (process)

**Benchmark with the paint outside the timed region.** I measured the
halftone at 267ms and told Paul it was a visible hitch. It wasn't — canvas
defers stroking until something forces rasterisation, so `getImageData` was
being billed for work the stroke had queued. Isolated properly, the sampling
step was 4.7ms per layer, and the "optimisation" I'd already shipped took it
to 1.0ms. Real, but a tenth of the problem I'd claimed. Draw once outside the
loop, then time only the step you're interested in.

**A shrinking PNG is a rendering regression.** Twice I broke `network.js`
and the tell was the screenshot file getting *smaller* — less detail, fewer
bytes. Worth watching as a cheap canary.

**Syntax-check after every comment edit.** I broke both `style.css` and
`network.js` the same way: replacing a paragraph inside a block comment,
closing it with `*/`, and leaving the original terminator behind as stray
code. Neither failed loudly. `node --check` on every JS edit caught the
second one immediately.

**Headless Chrome clamps the viewport to 500px minimum.** A "mobile
horizontal overflow" I spent a diagnostic on was the screenshot being
cropped to the requested 420px while the page laid out at 500. Measure
`innerWidth` before diagnosing a layout bug from a screenshot.

**`cd` inside a chained bash command persists for the rest of it.** A
light-mode screenshot silently captured a 404 page because `sed` ran from
the scratchpad. Use absolute paths in multi-step shell commands.

**Custom properties don't resolve `light-dark()`.** `getComputedStyle`
returns the literal token, so a JS-read colour has to either ride in on a
real property like `color` (which *does* resolve) or be declared per theme
by hand. The three `--net-*` colours take the second approach.

**Deep blue on OLED black needs far more alpha than green.** Blue
contributes 0.0722 of luminance against green's 0.7152. Going from a pale
blue to lapis at the same alpha nearly erased the train layer. `--net-train`
carries 0.58 where `--net-tram` carries 0.34, and they read level.

**Contrast wasn't the binding constraint for text over the map.** I assumed
it would be. Measured: the worst case (a freeway under body text at
`--network-dim: 0.5`) takes text from 20.1:1 to 17.8:1. What degrades first
is visual noise — lines pulling the eye across the prose. Worth measuring
before designing around a constraint that isn't there.

**The content column isn't centred.** `main` is 82rem and centred, but the
grid tracks only sum to 69rem and pack left, so text runs from `50% - 41rem`
to `50% + 28rem`. The first version of the background mask was keyed to the
viewport centre and sat ~80px off. Any future full-bleed element needs the
asymmetric stops, see `--network-mask`.

**`linemerge` per class is not a graph.** Merging within each `CLASS_CODE`
means a polyline runs straight through junctions with roads of a different
class. Good for drawing — long smooth arterials — but if you ever want the
Dijkstra idea, the road layer needs a splitting pass first: hash every
vertex, split where one appears in 2+ polylines. They're all on the same 10m
grid so shared vertices coincide exactly.

**GTFS shapes are far denser than anything visible.** Simplifying them to
the same 20m tolerance as the roads roughly halved the payload. Easy to
forget, because the road path already simplifies and the transit path
originally didn't.

### Verification recipes that actually caught things

- **Sanity-check aggregates in Python before touching the renderer.** The
  3am/8am/Sunday table above is what gave confidence the bands were right.
- **Diff two frames to prove motion.** Render at two `--virtual-time-budget`
  values, compare with PIL. 2,120 differing pixels with the static layer
  pixel-identical proved both that vehicles moved and that the map wasn't
  being needlessly redrawn.
- **Check silent fallbacks explicitly.** `DAY_INDEX[parts.weekday] ?? 0`
  would have rendered every day as Monday if the `Intl` short weekday string
  didn't match. One `node -e` confirmed `"Wed"` → `2`.
