/* Decorative background: Melbourne's road, tram and train networks, with
   vehicles running the real published timetable.

   Purely ornamental — both canvases are aria-hidden, pointer-events: none,
   and sit behind everything. If the fetch fails or this file never loads,
   the page is exactly as it was.

   Geometry and timetables are data/melbourne-network.json, built by
   tools/build-network.py from Vicmap Transport TR_ROAD_ALL and the PTV GTFS
   feeds. See that script for how it's derived, and for the CC-BY
   attribution that has to stay on the page.

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
     way across in half a minute. 10 makes the motion legible while keeping
     the clock close enough that a typical visit never drifts noticeably —
     two minutes of looking costs twenty minutes of simulated time. */
  const TIME_SCALE = 5;

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

  let net = null;
  let view = null;
  let timer = null;
  let lastFrame = 0;

  /* Scratch buffer for the halftone pass. Kept at CSS-pixel size and with no
     dpr transform: coverage is measured per CSS pixel, which is the same
     space the dot grid is laid out in. willReadFrequently because the whole
     technique is getImageData. */
  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d");

  /* One pixel per dot cell. The full-size layer is drawn into `off`, then
     scaled down into this — the browser's own filtering does the averaging,
     on the GPU, and the readback shrinks from ~2M pixels to ~58k.

     Averaging the full buffer in JS instead cost 38ms per layer, so ~270ms
     for the seven passes, which is a visible hitch on load and on every
     resize and theme toggle. This way it's a few ms. */
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
    return {
      day: DAY_INDEX[parts.weekday] ?? 0,
      minute: Number(parts.hour) % 24 * 60 + Number(parts.minute),
    };
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

  function strokeLines(ctx, lines, width) {
    ctx.beginPath();
    for (const { xs, ys } of lines) {
      ctx.moveTo(view.ox + xs[0] * view.scale, view.oy - ys[0] * view.scale);
      for (let i = 1; i < xs.length; i++) {
        ctx.lineTo(view.ox + xs[i] * view.scale, view.oy - ys[i] * view.scale);
      }
    }
    ctx.lineWidth = width;
    ctx.stroke();
  }

  /* Cell centres, so vehicles can land on exactly the same lattice the map
     is halftoned onto. Offset by half a pitch so dots sit in the middle of
     their cell rather than on its corner. */
  const snap = (v) => Math.floor(v / PITCH) * PITCH + PITCH / 2;

  /* Draw something to the offscreen canvas in solid white, then read back
     the alpha channel — antialiasing means alpha IS coverage, already
     averaged over the line's soft edges, so no separate sampling is needed.

     One readback per layer, only ever on a resize or theme change. The
     vehicle layer never does this; it snaps to the grid arithmetically. */
  function halftone(w, h, style, drawFn) {
    offCtx.clearRect(0, 0, w, h);
    offCtx.strokeStyle = "#fff";
    offCtx.lineCap = "round";
    offCtx.lineJoin = "round";
    drawFn(offCtx);

    /* Scale the layer down to exactly one pixel per cell. The filtering is
       the averaging, and each resulting alpha byte is that cell's coverage. */
    const cols = cells.width;
    const rows = cells.height;
    cellCtx.clearRect(0, 0, cols, rows);
    cellCtx.drawImage(off, 0, 0, w, h, 0, 0, cols, rows);
    const data = cellCtx.getImageData(0, 0, cols, rows).data;

    mapCtx.fillStyle = style;
    mapCtx.beginPath();

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const cover = data[(cy * cols + cx) * 4 + 3] / 255;
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
            (ctx) => strokeLines(ctx, net.roads[cls], layer.widths[cls]),
          );
        }
      } else {
        halftone(
          w, h, `rgba(${r}, ${g}, ${b}, ${a})`,
          (ctx) => strokeLines(ctx, net.transit[layer.key], layer.widths[0]),
        );
      }
    }
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

  function drawVehicles(w, h, minute) {
    vehCtx.clearRect(0, 0, w, h);

    for (const mode of MODES) {
      const layer = LAYERS.find((l) => l.key === mode);
      const [r, g, b, a] = colour(layer.colour);
      if (a === 0) continue;

      vehCtx.beginPath();
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
      vehCtx.fillStyle =
        `rgba(${r}, ${g}, ${b}, ${Math.min(1, a * VEHICLE_BOOST)})`;
      vehCtx.fill();
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

    // One static frame under reduced motion: the density still tells the
    // time of day, nothing moves.
    if (reduceMotion.matches) {
      drawVehicles(window.innerWidth, window.innerHeight, clock.minute);
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

    off.width = w;
    off.height = h;
    cells.width = Math.ceil(w / PITCH);
    cells.height = Math.ceil(h / PITCH);
    // Setting width resets context state, so this belongs here, not at init.
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

  /* Watching the attribute rather than hooking the toggle keeps this file
     independent of main.js — either can be deleted without touching the
     other. */
  new MutationObserver(fit).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  fetch("data/melbourne-network.json")
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
