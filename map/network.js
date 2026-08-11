/* Decorative background: Melbourne's road, tram and train networks, with
   vehicles running the real published timetable.

   Purely ornamental — both canvases are aria-hidden, pointer-events: none,
   and sit behind everything. If the fetch fails or this file never loads,
   the page is exactly as it was.

   Geometry and timetables are map/melbourne-network.json, built by
   tools/build-network.py from Vicmap Transport TR_ROAD_ALL and the PTV GTFS
   feeds. See that script for how it's derived, and for the CC-BY
   attribution that has to stay on the page.

   Lives under map/ rather than js/ because the main site doesn't load it —
   see map/index.html. The site has to keep working with this whole
   directory deleted, so nothing outside it may reference this file.

   ---- what the vehicles actually are ----

   Not decoration that happens to look transport-shaped. Each route carries
   headway bands lifted from GTFS — "every 6 minutes between 8am and 9am" —
   per weekday, plus a distance/time profile taken from a real trip's stop
   times. So vehicles bunch up through the CBD and open out past the
   terminus end, because that's what the timetable says they do.

   The clock is Melbourne's, whoever is looking. At 8am on a Wednesday
   there are around 190 trains and 230 trams on screen; at 3am there are six
   trains and no trams at all. On Sunday morning at 3am the Night Network is
   running. None of that is authored — it falls out of the bands.

   ---- cost ----

   The map is ~7,000 points and never changes, so it lives on its own canvas
   and is drawn once. Only the vehicle layer repaints, capped at 30fps, and
   it stops entirely when the tab is hidden or the visitor prefers reduced
   motion. Nothing runs on narrow screens, where the canvases are display:none.

   Note this needs to be served over http — fetch() won't read file:// URLs. */

/* Resolved against this script's own URL, not the document's. map/index.html
   sets <base href="../">, so a bare "melbourne-network.json" would be looked
   for at the site root. Read at top level while this script is still the one
   executing — document.currentScript is null once anything async runs. */
const DATA_URL = new URL("melbourne-network.json", document.currentScript.src);

/* How per-cell coverage is measured, and whether to show the readout that
   says what each engine actually did. See coverage() for the techniques.

     ?halftone=exact|cells|clamp|transform|downscale   default exact
     ?debug=1                                          per-layer coverage stats
     ?trail=1..3                                       vehicle trail length,
                                                       1 being no trail
     ?at=HH:MM&day=0..6                                start the clock there
                                                       instead of at Melbourne
                                                       time, 0 being Monday

   Both are here because this page's whole job is being opened on a machine
   that renders it wrong, by someone who then has to say what they saw. */
const PARAMS = new URLSearchParams(location.search);
const REQUESTED = PARAMS.get("halftone");
const TECHNIQUE =
  ["exact", "cells", "clamp", "transform", "downscale"].includes(REQUESTED)
    ? REQUESTED
    : "exact";
const DEBUG = PARAMS.get("debug") === "1";
const TRAIL_PARAM = Number(PARAMS.get("trail"));

/* Start the clock somewhere other than now. The whole point of the vehicle
   layer is that 8am on a Wednesday and 3am on a Sunday look nothing alike,
   and waiting until 3am to check the second one is a poor way to work. It
   also makes a screenshot repeatable, which comparing two renderings
   otherwise isn't — thirty simulated minutes pass while you take them. */
const AT = /^(\d{1,2}):(\d{2})$/.exec(PARAMS.get("at") || "");
const DAY_PARAM = Number(PARAMS.get("day"));

const mapCanvas = document.getElementById("network");
const vehCanvas = document.getElementById("network-vehicles");

if (mapCanvas && vehCanvas && mapCanvas.getContext) {
  const mapCtx = mapCanvas.getContext("2d");
  const vehCtx = vehCanvas.getContext("2d");

  /* ---- the knobs ---- */

  /* How much of the viewport the 24 km road clip spans, as a multiple of the
     larger viewport dimension. Below 1.0 the network is narrower than the
     screen and the margins run off the end of it, so the useful range is
     about 1.0 to 1.4. */
  const FILL = 1.15;
  const FOCUS_X = 0.52;
  const FOCUS_Y = 0.48;

  /* Minutes of Melbourne time per second of real time.

     1 would be honest but invisible: a tram crosses the visible band in
     about 17 minutes, so at real speed it moves roughly one percent of the
     way across in half a minute.

     5 was legible and too busy — a vehicle covered about two and a half
     cells per frame, so every dot jumped a visible distance every frame and
     the whole field crawled. This is background; it should be noticed on
     purpose, not out of the corner of the eye. At 2 a vehicle advances
     roughly one cell per frame, which reads as movement rather than
     flicker, and the clock still only drifts ten simulated minutes over a
     five minute visit. */
  const TIME_SCALE = 2;

  const FPS = 30;

  /* ---- the dot matrix ----

     Everything is rendered as dots on a fixed grid, the way a flip-dot board
     or an LED matrix would: the map is drawn normally to an offscreen
     canvas, then each grid cell is lit in proportion to how much ink landed
     in it. Dots grow with coverage rather than switching hard on and off,
     which is halftone rather than true dithering — a binary threshold throws
     away the road hierarchy entirely.

     PITCH is the thing to tune. It wants to be close to the dot pitch of
     Geist Pixel Circle in the h1 so the background and the wordmark read as
     the same display. Smaller is finer and slower; below ~4 it stops
     reading as dots at all.

     Lines feed this much thicker than they'd be drawn directly — a hairline
     spread across a 6px cell barely registers as coverage and comes out as
     a faint smear of tiny dots. */
  const PITCH = 6;
  const DOT_R = 2.3;        // radius of a fully-lit dot, CSS px
  const DOT_FLOOR = 0.05;   // coverage below this leaves the cell dark
  const DOT_GAMMA = 0.6;    // <1 lifts partial coverage so faint roads survive

  const LAYERS = [
    {
      key: "road",
      colour: "--net-road",
      widths: [3.2, 2.7, 2.2, 1.8, 1.5],
      alphas: [1.0, 0.82, 0.62, 0.45, 0.34],
    },
    { key: "tram", colour: "--net-tram", widths: [2.4], alphas: [1] },
    /* Narrower than you'd expect for the trunk network, because --net-train
       already carries a high alpha to survive as a deep blue on black. Width
       and alpha both read as weight; raising both would put trains above
       trams rather than level with them. */
    { key: "train", colour: "--net-train", widths: [2.8], alphas: [1] },
  ];

  const MODES = ["tram", "train"];
  /* A vehicle is one fully-lit cell, so it matches the largest dot the map
     can produce rather than being its own size. */
  const VEHICLE_R = DOT_R;
  /* Vehicles have to separate from the line they sit on, and the lines are
     deliberately faint. */
  const VEHICLE_BOOST = 2.6;

  /* The trail behind each vehicle: brightness for where it is now, and for
     each cell it occupied before that. A flip-dot board has no persistence,
     so a dot moving across it is a hard on/off at every cell and the eye
     gets no direction out of it — the trail is what turns a jumping dot
     into something travelling, and it costs nothing but alpha.

     No history is kept. The tail is the same vehicle evaluated at earlier
     clock readings, which the timetable already answers exactly, so this
     stays as stateless as the rest of the renderer: nothing to seed, nothing
     to invalidate on resize, and it is correct on the very first frame.

     One frame apart is deliberate — at TIME_SCALE 2 that is about one cell,
     so the trail is the cells actually just vacated. Where a vehicle is
     crawling through the CBD the samples collapse onto one cell and it
     simply has no tail, which is the honest picture. */
  const TRAIL = [1, 0.7, 0.4];
  const TRAIL_STEP = TIME_SCALE / FPS;   // simulated minutes between samples

  // ?trail=1 is the old behaviour, one dot and no tail.
  const TRAIL_LEVELS =
    TRAIL_PARAM >= 1 && TRAIL_PARAM <= TRAIL.length ? TRAIL_PARAM : TRAIL.length;

  let net = null;
  let view = null;
  let timer = null;
  let lastFrame = 0;

  /* Scratch buffer, only allocated for TECHNIQUE "downscale". Kept at
     CSS-pixel size and with no dpr transform: coverage is measured per CSS
     pixel, which is the same space the dot grid is laid out in. Full
     viewport, so ~33MB of backing store on a 4K display — one of several
     reasons the other technique is the default. */
  const off = TECHNIQUE === "downscale" ? document.createElement("canvas") : null;
  const offCtx = off ? off.getContext("2d") : null;

  /* One pixel per dot cell. willReadFrequently because the whole technique
     is getImageData. */
  const cells = document.createElement("canvas");
  const cellCtx = cells.getContext("2d", { willReadFrequently: true });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function colour(prop) {
    const parts = getComputedStyle(mapCanvas).getPropertyValue(prop).match(/-?[\d.]+/g);
    if (!parts) return [255, 176, 0, 0.2];
    const [r, g, b, a] = parts.map(Number);
    return [r, g, b, a === undefined ? 1 : a];
  }

  /* ---- decoding ---- */

  function absolute(line, from) {
    const n = (line.length - from) / 2;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    let x = line[from];
    let y = line[from + 1];
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        x += line[from + i * 2];
        y += line[from + i * 2 + 1];
      }
      xs[i] = x;
      ys[i] = y;
    }
    return { xs, ys };
  }

  /* The profile is (distance, time) pairs, both normalised 0..1 and both
     monotonic. We need the inverse — given elapsed time, how far along? —
     once per vehicle per frame, so it gets resampled into a fixed lookup
     table at load and the hot path becomes an index and a lerp. */
  function buildLut(profile, size) {
    const lut = new Float32Array(size);
    let j = 0;
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      while (j < profile.length - 2 && profile[j + 1][1] < t) j++;
      const [d0, t0] = profile[j];
      const [d1, t1] = profile[j + 1] ?? profile[j];
      const span = t1 - t0;
      lut[i] = span > 0 ? d0 + ((t - t0) / span) * (d1 - d0) : d0;
    }
    return lut;
  }

  function decodeVariant(v, index) {
    const { xs, ys } = absolute(v.g, 0);

    // Cumulative length, so a distance fraction can be turned into a point.
    const cum = new Float64Array(xs.length);
    for (let i = 1; i < xs.length; i++) {
      cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    }

    return {
      xs, ys, cum,
      length: cum[cum.length - 1],
      lut: buildLut(v.p, 96),
      runtime: v.t,
      bands: v.b,
      days: v.d,
      /* Golden-ratio offset so routes don't all dispatch on the same tick and
         march in lockstep — real services aren't phase-locked either. */
      phase: (index * 0.6180339887) % 1,
    };
  }

  function decode(payload) {
    const bounds = {
      minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
    };

    const roads = [];
    for (const line of payload.roads) {
      const { xs, ys } = absolute(line, 1);
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] < bounds.minX) bounds.minX = xs[i];
        if (xs[i] > bounds.maxX) bounds.maxX = xs[i];
        if (ys[i] < bounds.minY) bounds.minY = ys[i];
        if (ys[i] > bounds.maxY) bounds.maxY = ys[i];
      }
      (roads[line[0]] ||= []).push({ xs, ys });
    }

    const transit = {};
    for (const mode of MODES) {
      transit[mode] = (payload.transit[mode] || []).map(decodeVariant);
    }

    /* Framing comes from the roads alone. Transit runs to its termini, well
       past the 12 km road box, and letting it widen the bounds would zoom the
       whole map out to fit track nobody can see. */
    return { roads, transit, ...bounds };
  }

  /* ---- the clock ---- */

  const melbourne = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  const DAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

  /* Melbourne's clock regardless of where the visitor is — it's Melbourne's
     network. Intl handles AEST/AEDT, so this doesn't need a DST table. */
  function melbourneNow() {
    const parts = {};
    for (const p of melbourne.formatToParts(new Date())) parts[p.type] = p.value;
    const now = {
      day: DAY_INDEX[parts.weekday] ?? 0,
      minute: Number(parts.hour) % 24 * 60 + Number(parts.minute),
    };

    // ?at= and ?day= override it; anything unparseable leaves it alone.
    if (AT) now.minute = (Number(AT[1]) % 24) * 60 + (Number(AT[2]) % 60);
    if (DAY_PARAM >= 0 && DAY_PARAM <= 6) now.day = DAY_PARAM;
    return now;
  }

  let clock = null;

  function headwayAt(variant, day, minute) {
    const bands = variant.bands[variant.days[day]];
    if (!bands) return 0;
    for (const [start, end, headway] of bands) {
      if (minute >= start && minute < end) return headway;
    }
    return 0;  // no band means no service — this is how 3am empties out
  }

  /* ---- drawing ---- */

  function project(w, h) {
    const span = Math.max(net.maxX - net.minX, net.maxY - net.minY);
    const scale = (Math.max(w, h) * FILL) / span;
    const cx = (net.minX + net.maxX) / 2;
    const cy = (net.minY + net.maxY) / 2;
    return {
      scale,
      ox: w * FOCUS_X - cx * scale,
      // Northings go up, screen y goes down, hence the negated scale.
      oy: h * FOCUS_Y + cy * scale,
    };
  }

  /* `scale` shrinks the coordinates here, in JS, rather than through a canvas
     transform, and `width` is therefore already in destination pixels. That
     is not a style preference — see coverage(). Gecko does not scale
     lineWidth with a scaled transform the way Blink and WebKit do, so a
     transform-based version of this asks for a 0.53px stroke and gets a
     3.2px one. Doing the arithmetic here leaves nothing to interpret. */
  function strokeLines(ctx, lines, width, scale = 1) {
    ctx.beginPath();
    for (const { xs, ys } of lines) {
      ctx.moveTo(
        (view.ox + xs[0] * view.scale) * scale,
        (view.oy - ys[0] * view.scale) * scale,
      );
      for (let i = 1; i < xs.length; i++) {
        ctx.lineTo(
          (view.ox + xs[i] * view.scale) * scale,
          (view.oy - ys[i] * view.scale) * scale,
        );
      }
    }
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /* Cell centres, so vehicles can land on exactly the same lattice the map
     is halftoned onto. Offset by half a pitch so dots sit in the middle of
     their cell rather than on its corner. */
  const snap = (v) => Math.floor(v / PITCH) * PITCH + PITCH / 2;

  /* How much ink lands in each cell, as one alpha byte per cell. Draw in
     solid white and read the alpha channel back — antialiasing means alpha
     IS coverage, already averaged over the line's soft edges.

     Five ways to get there. The first needs no canvas at all; the other four
     all read pixels back, and are kept only because being able to switch a
     bug on is worth more than a note describing one.

     "exact" (default) never draws the layer to measure it. It walks the
     polylines and adds up ink per cell directly: each step of a segment
     deposits width x length of ink, bilinearly split across the cells it
     falls between, and the total is clamped at 1. Same halftone, same
     numbers, no getImageData anywhere.

     That is not a micro-optimisation, it is the fix. Firefox with
     fingerprinting protection on — ETP Strict, resistFingerprinting, or an
     extension doing the same — does not return canvas contents from
     getImageData. It returns a synthetic pattern: measured on a Mac running
     Firefox 152, eight alpha values repeating on every row, which read back
     as every cell fully covered. Every dot then draws at full radius, the
     road hierarchy the five width classes encode never survives, and the
     background becomes a striped field of colour. No stroke technique can
     fix that, because the measurement channel itself is the thing being
     blocked. Reading pixels back was also always the fingerprinting surface
     that protection exists to close, which is reason enough not to do it in
     a decoration.

     "cells" rasterises the layer straight onto the dot grid. The
     coordinates are divided by PITCH in JS and the stroke is asked for in
     destination pixels: a 3.2px road becomes a 0.53px stroke, and the
     rasteriser answers with about 53% coverage of that cell. Nothing but the
     rasteriser's own antialiasing is involved, and the width is stated in
     the units it is measured in. Agrees in Blink, WebKit and Gecko.

     "transform" is the same idea expressed the way that reads better —
     scale the canvas transform by 1/PITCH and let lineWidth come along.
     Blink and WebKit do scale it. Gecko does not: it strokes 3.2 device
     pixels where 0.53 was meant, roughly 6x too fat, so nearly every cell
     inks up, coverage saturates, every dot draws at full radius and the map
     becomes a solid field of colour with no road hierarchy left in it.
     Measured at 87-100% of cells lit against Blink's ~10%. Kept because a
     switchable version of a bug is worth more than a note about one.

     "clamp" never asks for a sub-pixel stroke at all: it draws one whole
     pixel wide and puts the width it wanted into globalAlpha, so partial
     coverage comes out of a multiply instead of out of the engine's hairline
     handling. Cruder — overlapping strokes compound where a box filter would
     average — but it assumes nothing about thin strokes at all.

     "downscale" is what shipped first: draw at full size, then let drawImage
     average it 6:1 into the cell grid, trusting the image filter to be a box
     filter. probe.html says this behaves the same in all three engines, so
     despite first appearances it was never the bug.

     One readback per layer whichever is used, and only on resize. The
     vehicle layer never does this; it snaps arithmetically. */
  /* Ink dropped at one point, split between the four cells it falls between
     so a line moving across a boundary fades over rather than jumping. Cell
     (cx, cy) has its centre at (cx + 0.5, cy + 0.5). */
  function splat(ink, cols, rows, x, y, amount) {
    const gx = x - 0.5;
    const gy = y - 0.5;
    const cx0 = Math.floor(gx);
    const cy0 = Math.floor(gy);
    const tx = gx - cx0;
    const ty = gy - cy0;

    for (let j = 0; j < 2; j++) {
      const cy = cy0 + j;
      if (cy < 0 || cy >= rows) continue;
      const wy = j ? ty : 1 - ty;
      for (let i = 0; i < 2; i++) {
        const cx = cx0 + i;
        if (cx < 0 || cx >= cols) continue;
        ink[cy * cols + cx] += amount * (i ? tx : 1 - tx) * wy;
      }
    }
  }

  /* Half a cell. Fine enough that a segment never skips a cell it crosses,
     coarse enough that the whole network costs a few milliseconds. */
  const STEP = 0.5;

  function analyticCoverage(lines, width, cols, rows) {
    const ink = new Float32Array(cols * rows);
    const wCells = width / PITCH;
    const s = 1 / PITCH;

    for (const { xs, ys } of lines) {
      let x0 = (view.ox + xs[0] * view.scale) * s;
      let y0 = (view.oy - ys[0] * view.scale) * s;

      for (let i = 1; i < xs.length; i++) {
        const x1 = (view.ox + xs[i] * view.scale) * s;
        const y1 = (view.oy - ys[i] * view.scale) * s;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const steps = Math.max(1, Math.ceil(len / STEP));

        /* Coverage is area. Each step stands for len/steps of the segment,
           and the stroke is wCells wide, so that rectangle of ink is what
           the step deposits — expressed in cells, because that is the unit
           the grid is in. */
        const amount = (wCells * len) / steps;

        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          splat(ink, cols, rows, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, amount);
        }

        x0 = x1;
        y0 = y1;
      }
    }

    // A cell cannot be more than covered, however many roads run through it.
    for (let i = 0; i < ink.length; i++) {
      if (ink[i] > 1) ink[i] = 1;
    }
    return ink;
  }

  function coverage(w, h, lines, width) {
    const cols = cells.width;
    const rows = cells.height;

    if (TECHNIQUE === "exact") return analyticCoverage(lines, width, cols, rows);

    cellCtx.setTransform(1, 0, 0, 1, 0, 0);
    cellCtx.globalAlpha = 1;
    cellCtx.clearRect(0, 0, cols, rows);

    if (TECHNIQUE === "downscale") {
      offCtx.clearRect(0, 0, w, h);
      offCtx.strokeStyle = "#fff";
      offCtx.lineCap = "round";
      offCtx.lineJoin = "round";
      strokeLines(offCtx, lines, width);
      cellCtx.drawImage(off, 0, 0, w, h, 0, 0, cols, rows);
      return readBack(cols, rows);
    }

    cellCtx.strokeStyle = "#fff";
    cellCtx.lineCap = "round";
    cellCtx.lineJoin = "round";

    // What the stroke should measure, in cells.
    const wanted = width / PITCH;

    if (TECHNIQUE === "transform") {
      cellCtx.setTransform(1 / PITCH, 0, 0, 1 / PITCH, 0, 0);
      strokeLines(cellCtx, lines, width);
      cellCtx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      // Both remaining techniques scale the geometry in JS and differ only in
      // who turns a thin line into partial coverage: the rasteriser, or us.
      const drawn = TECHNIQUE === "clamp" ? Math.max(1, wanted) : wanted;
      cellCtx.globalAlpha = wanted / drawn;
      strokeLines(cellCtx, lines, drawn, 1 / PITCH);
      cellCtx.globalAlpha = 1;
    }

    return readBack(cols, rows);
  }

  /* The alpha channel of the cell buffer, as coverage 0..1, so every
     technique hands back the same thing whether it drew anything or not.
     This is the call that a privacy-hardened browser answers with a
     synthetic pattern instead of the canvas — see coverage(). */
  function readBack(cols, rows) {
    const data = cellCtx.getImageData(0, 0, cols, rows).data;
    const out = new Float32Array(cols * rows);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
    return out;
  }

  function halftone(w, h, style, lines, width, label) {
    const cols = cells.width;
    const rows = cells.height;
    const data = coverage(w, h, lines, width);
    if (DEBUG) recordCoverage(label, style, width, data);

    mapCtx.fillStyle = style;
    mapCtx.beginPath();

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cover = data[cy * cols + cx];
        if (cover < DOT_FLOOR) continue;

        const radius = DOT_R * Math.pow(Math.min(1, cover), DOT_GAMMA);
        const px = cx * PITCH + PITCH / 2;
        const py = cy * PITCH + PITCH / 2;
        mapCtx.moveTo(px + radius, py);
        mapCtx.arc(px, py, radius, 0, Math.PI * 2);
      }
    }
    mapCtx.fill();
  }

  function drawMap(w, h) {
    mapCtx.clearRect(0, 0, w, h);
    debugRows.length = 0;
    debugAscii = [];

    for (const layer of LAYERS) {
      const [r, g, b, a] = colour(layer.colour);
      if (a === 0) continue;

      if (layer.key === "road") {
        // Faintest class first, so freeways end up on top where they cross.
        for (let cls = net.roads.length - 1; cls >= 0; cls--) {
          if (!net.roads[cls]) continue;
          halftone(
            w, h,
            `rgba(${r}, ${g}, ${b}, ${a * layer.alphas[cls]})`,
            net.roads[cls], layer.widths[cls], `road c${cls}`,
          );
        }
      } else {
        halftone(
          w, h, `rgba(${r}, ${g}, ${b}, ${a})`,
          net.transit[layer.key], layer.widths[0], layer.key,
        );
      }
    }

    if (DEBUG) showDebug();
  }

  /* ---- debug readout ----

     Only reachable with ?debug=1. It exists because the failure this page is
     for shows up on someone else's machine, and "every dot has colour"
     needs to become a number before it can be fixed. Prints what each layer
     pass actually measured, plus the values the CSS handed over — the two
     places a wrong answer can come from. */

  const debugRows = [];
  let debugAscii = [];
  let lastReadback = 0;

  /* Does this engine turn a thin stroke into partial alpha, or does it round
     the line up to a whole pixel and draw it opaque? Everything the halftone
     does rests on the first answer, and nothing else in the page can tell
     the two apart. Same context options as the real cell buffer, so the
     answer applies to it.

     A correct engine strokes width 0.5 at alpha ~128. An engine with a
     minimum stroke width strokes it at 255 and every cell saturates. */
  /* Does getImageData return this canvas at all? Fill it solid and read it
     straight back. Any answer other than 255 everywhere means the browser is
     substituting something for the canvas — anti-fingerprinting protection
     does exactly this — and every pixel-reading technique below is measuring
     that substitute rather than the map. */
  function readbackSelfTest() {
    const t = document.createElement("canvas");
    t.width = 16;
    t.height = 16;
    const tc = t.getContext("2d", { willReadFrequently: true });
    tc.fillStyle = "#fff";
    tc.fillRect(0, 0, 16, 16);

    const px = tc.getImageData(0, 0, 16, 16).data;
    let min = 255;
    let max = 0;
    const seen = new Set();
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] < min) min = px[i];
      if (px[i] > max) max = px[i];
      seen.add(px[i]);
    }
    const honest = min === 255 && max === 255;
    return `  solid fill reads back alpha ${min}..${max} ` +
      `(${seen.size} distinct)  ->  ${honest ? "canvas readable" : "READBACK BLOCKED"}`;
  }

  function strokeSelfTest() {
    const t = document.createElement("canvas");
    t.width = 24;
    t.height = 24;
    const tc = t.getContext("2d", { willReadFrequently: true });
    const out = [];

    for (const width of [0.25, 0.53, 0.75, 1, 2]) {
      const row = [];
      for (const vertical of [false, true]) {
        tc.setTransform(1, 0, 0, 1, 0, 0);
        tc.globalAlpha = 1;
        tc.clearRect(0, 0, 24, 24);
        tc.strokeStyle = "#fff";
        tc.lineCap = "round";
        tc.lineJoin = "round";
        tc.lineWidth = width;
        tc.beginPath();
        // Centred on a pixel centre, so a correct AA stroke lands in one row.
        if (vertical) {
          tc.moveTo(12.5, 3);
          tc.lineTo(12.5, 21);
        } else {
          tc.moveTo(3, 12.5);
          tc.lineTo(21, 12.5);
        }
        tc.stroke();

        // Cross-section through the middle of the line.
        const px = tc.getImageData(0, 0, 24, 24).data;
        const at = (x, y) => px[(y * 24 + x) * 4 + 3];
        const cut = vertical
          ? [at(11, 12), at(12, 12), at(13, 12)]
          : [at(12, 11), at(12, 12), at(12, 13)];
        row.push(`${vertical ? "vert" : "horiz"} [${cut.join(",")}]`);
      }
      out.push(
        `  width ${String(width).padEnd(5)} expect alpha ~${Math.round(
          Math.min(1, width) * 255,
        )}   ${row.join("   ")}`,
      );
    }
    return out;
  }

  /* A picture of the coverage buffer itself, in text. Whatever pattern is
     visible on screen — stripes, blocks, nothing — either shows up here, in
     which case the measurement is wrong, or it doesn't, in which case the
     painting is. */
  function asciiCoverage(data, cols, rows) {
    const RAMP = " .:-=+*#%@";
    const w = Math.min(72, cols);
    const h = Math.min(18, rows);
    const x0 = Math.max(0, ((cols - w) / 2) | 0);
    const y0 = Math.max(0, ((rows - h) / 2) | 0);
    const out = [];
    for (let y = 0; y < h; y++) {
      let line = "  ";
      for (let x = 0; x < w; x++) {
        const a = data[((y0 + y) * cols) + (x0 + x)];
        line += RAMP[Math.min(RAMP.length - 1, Math.floor(a * RAMP.length))];
      }
      out.push(line);
    }
    return out;
  }

  function recordCoverage(label, style, width, data) {
    let max = 0;
    let sum = 0;
    let lit = 0;
    const hist = new Array(10).fill(0);
    for (let i = 0; i < data.length; i++) {
      const a = data[i];
      if (a > max) max = a;
      sum += a;
      if (a >= DOT_FLOOR) lit++;
      if (a > 0) hist[Math.min(9, Math.floor(a * 10))]++;
    }
    const n = data.length;
    lastReadback = n;
    // The widest road class, drawn first, is the clearest look at the buffer.
    if (!debugAscii.length) {
      debugAscii = asciiCoverage(data, cells.width, cells.height);
    }
    debugRows.push(
      `  ${label.padEnd(8)} width ${width.toFixed(1).padStart(4)}` +
      `  max ${max.toFixed(3)}  mean ${(sum / n).toFixed(4)}` +
      `  lit ${((lit / n) * 100).toFixed(1).padStart(5)}%` +
      `  hist ${hist.join(" ")}`,
    );
  }

  /* This used to beacon the panel below to a map/debug-log.php that appended
     it to a file, because the machine reproducing the bug couldn't easily
     get a screenshot to the machine fixing it. That worked, found the bug,
     and has been removed along with the endpoint — an unauthenticated write
     endpoint is not something to leave on a live domain once it has stopped
     earning its keep. Bring it back the same way if it's ever needed again;
     it was about twenty lines. */
  function showDebug() {
    let pre = document.getElementById("net-debug");
    if (!pre) {
      pre = document.createElement("pre");
      pre.id = "net-debug";
      pre.style.cssText =
        "position:fixed;top:0;left:0;z-index:9999;margin:0;padding:10px;" +
        "max-width:100vw;overflow:auto;background:#000;color:#ffb000;" +
        "border:1px solid #ffb000;font:11px/1.5 monospace;white-space:pre";
      document.body.appendChild(pre);
    }

    /* The raw string beside the parsed result: if an engine serialises the
       custom property differently, colour()'s regex would quietly return the
       wrong alpha and every dot would come out at full strength. */
    const colours = LAYERS.map((l) => {
      const raw = getComputedStyle(mapCanvas).getPropertyValue(l.colour).trim();
      return `  ${l.colour.padEnd(11)} "${raw}"  ->  [${colour(l.colour).join(", ")}]`;
    });

    pre.textContent = [
      `technique ${TECHNIQUE}   dpr ${window.devicePixelRatio}   ` +
      `viewport ${window.innerWidth}x${window.innerHeight}`,
      `cells ${cells.width}x${cells.height}   canvas ${mapCanvas.width}x${mapCanvas.height}   ` +
      `pitch ${PITCH}  dotR ${DOT_R}  floor ${DOT_FLOOR}  gamma ${DOT_GAMMA}`,
      `readback ${lastReadback} px for ${cells.width * cells.height} cells` +
      (lastReadback === cells.width * cells.height ? "  (ok)" : "  (MISMATCH)"),
      "",
      "is the canvas readable at all?",
      readbackSelfTest(),
      "",
      "does a thin stroke come back as partial alpha?",
      ...strokeSelfTest(),
      "",
      "colours read from CSS:",
      ...colours,
      "",
      "coverage per layer pass (hist = 10 buckets, dimmest first):",
      ...debugRows,
      "",
      "the coverage buffer itself, centre of the grid:",
      ...debugAscii,
    ].join("\n");
  }

  // Distance along a polyline -> a point on it.
  function pointAt(v, distance, out) {
    let lo = 0;
    let hi = v.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v.cum[mid] < distance) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const seg = v.cum[i] - v.cum[i - 1];
    const f = seg > 0 ? (distance - v.cum[i - 1]) / seg : 0;
    out.x = v.xs[i - 1] + (v.xs[i] - v.xs[i - 1]) * f;
    out.y = v.ys[i - 1] + (v.ys[i] - v.ys[i - 1]) * f;
  }

  const point = { x: 0, y: 0 };

  /* Every vehicle of one mode at one reading of the clock, added to the
     current path. Called once per trail level per mode, which is why it
     takes the minute rather than reading it: the tail is this same function
     asked about a slightly earlier time. */
  function pathVehicles(mode, minute, w, h) {
    for (const v of net.transit[mode]) {
      const headway = headwayAt(v, clock.day, Math.floor(minute) % 1440);
      if (!headway) continue;

      /* Vehicles currently in service are the ones dispatched within the
         last `runtime` minutes, one every `headway`. Their ages tile that
         window, offset by the route's phase. */
      const count = Math.ceil(v.runtime / headway);
      for (let k = 0; k < count; k++) {
        const age = ((minute + v.phase * headway) % headway) + k * headway;
        if (age >= v.runtime) break;

        const t = age / v.runtime;
        const lut = v.lut;
        const pos = t * (lut.length - 1);
        const i = Math.min(lut.length - 2, Math.floor(pos));
        const dist = (lut[i] + (lut[i + 1] - lut[i]) * (pos - i)) * v.length;

        pointAt(v, dist, point);
        const px = view.ox + point.x * view.scale;
        const py = view.oy - point.y * view.scale;
        // Cheap reject: most vehicles are off-screen at any moment.
        if (px < -8 || py < -8 || px > w + 8 || py > h + 8) continue;

        /* Snapped to the same lattice the map is halftoned onto, so a
           vehicle is one cell of the display flipping on. It also means
           motion is a series of discrete jumps between cells rather than a
           smooth glide, which is how a real flip-dot board behaves. */
        const sx = snap(px);
        const sy = snap(py);
        vehCtx.moveTo(sx + VEHICLE_R, sy);
        vehCtx.arc(sx, sy, VEHICLE_R, 0, Math.PI * 2);
      }
    }
  }

  function drawVehicles(w, h, minute, levels = TRAIL_LEVELS) {
    vehCtx.clearRect(0, 0, w, h);

    for (const mode of MODES) {
      const layer = LAYERS.find((l) => l.key === mode);
      const [r, g, b, a] = colour(layer.colour);
      if (a === 0) continue;

      /* One path and one fill per brightness level — three fills a mode
         rather than three thousand state changes. Dimmest first, so where a
         route doubles back on itself the current position still wins.

         Levels are separate fills rather than one path at varying alpha
         because a 2D context has a single fillStyle per fill; that is the
         whole reason the trail is a small fixed number of steps and not a
         smooth fade. */
      for (let level = levels - 1; level >= 0; level--) {
        vehCtx.beginPath();
        pathVehicles(mode, minute - level * TRAIL_STEP, w, h);
        vehCtx.fillStyle =
          `rgba(${r}, ${g}, ${b}, ${Math.min(1, a * VEHICLE_BOOST * TRAIL[level])})`;
        vehCtx.fill();
      }
    }
  }

  /* ---- loop ---- */

  function currentMinute() {
    return clock.minute + (performance.now() / 1000) * TIME_SCALE;
  }

  function frame(now) {
    timer = requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / FPS) return;
    lastFrame = now;
    drawVehicles(window.innerWidth, window.innerHeight, currentMinute());
  }

  function stop() {
    if (timer !== null) cancelAnimationFrame(timer);
    timer = null;
  }

  function start() {
    stop();
    if (!net || getComputedStyle(mapCanvas).display === "none") return;

    /* One static frame under reduced motion: the density still tells the
       time of day, nothing moves. No trail either — it exists to show
       direction of travel, and on a still frame it would just read as three
       vehicles where there is one. */
    if (reduceMotion.matches) {
      drawVehicles(window.innerWidth, window.innerHeight, clock.minute, 1);
      return;
    }
    if (document.hidden) return;
    timer = requestAnimationFrame(frame);
  }

  /* ---- sizing ---- */

  function fit() {
    stop();
    // Skip everything when CSS has hidden the canvases (narrow screens,
    // where there are no margins to draw into).
    if (getComputedStyle(mapCanvas).display === "none") return;

    /* Capped at 2: past that the backing store grows quadratically for a
       background nobody is meant to look at directly. On a 4K display that's
       a 33 MP canvas versus a 15 MP one. */
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const [canvas, ctx] of [[mapCanvas, mapCtx], [vehCanvas, vehCtx]]) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    if (off) {
      off.width = w;
      off.height = h;
    }
    cells.width = Math.ceil(w / PITCH);
    cells.height = Math.ceil(h / PITCH);
    // Setting width resets context state, so this belongs here, not at init.
    // Only the downscale path reads these; the default never filters an image.
    cellCtx.imageSmoothingEnabled = true;
    cellCtx.imageSmoothingQuality = "high";

    if (!net) return;
    view = project(w, h);
    drawMap(w, h);
    start();
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fit, 150);
  });

  // No point animating into a tab nobody is looking at.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  reduceMotion.addEventListener("change", start);

  /* There used to be a MutationObserver on data-theme here, redrawing the map
     when the palette changed under it. The site has one palette now, so the
     layer colours are read once per resize and never change again. */

  fetch(DATA_URL)
    .then((res) => {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    })
    .then((payload) => {
      net = decode(payload);
      clock = melbourneNow();
      fit();
    })
    .catch((err) => {
      // Background only — log it and leave the page alone.
      console.error("Background network didn't load:", err);
    });
}
