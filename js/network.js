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
  const TIME_SCALE = 10;

  const FPS = 30;

  const LAYERS = [
    {
      key: "road",
      colour: "--net-road",
      widths: [1.4, 1.15, 0.95, 0.8, 0.65],
      alphas: [1.0, 0.82, 0.62, 0.45, 0.34],
    },
    { key: "tram", colour: "--net-tram", widths: [1.1], alphas: [1] },
    /* Narrower than you'd expect for the trunk network, because --net-train
       already carries a high alpha to survive as a deep blue on black. Width
       and alpha both read as weight; raising both would put trains above
       trams rather than level with them. */
    { key: "train", colour: "--net-train", widths: [1.3], alphas: [1] },
  ];

  const MODES = ["tram", "train"];
  const VEHICLE_R = 1.5;
  /* Vehicles have to separate from the line they sit on, and the lines are
     deliberately faint. */
  const VEHICLE_BOOST = 2.6;

  let net = null;
  let view = null;
  let timer = null;
  let lastFrame = 0;

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

  function strokeLines(ctx, lines, style, width) {
    ctx.beginPath();
    for (const { xs, ys } of lines) {
      ctx.moveTo(view.ox + xs[0] * view.scale, view.oy - ys[0] * view.scale);
      for (let i = 1; i < xs.length; i++) {
        ctx.lineTo(view.ox + xs[i] * view.scale, view.oy - ys[i] * view.scale);
      }
    }
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawMap(w, h) {
    mapCtx.clearRect(0, 0, w, h);
    mapCtx.lineCap = "round";
    mapCtx.lineJoin = "round";

    for (const layer of LAYERS) {
      const [r, g, b, a] = colour(layer.colour);
      if (a === 0) continue;

      if (layer.key === "road") {
        // Faintest class first, so freeways end up on top where they cross.
        for (let cls = net.roads.length - 1; cls >= 0; cls--) {
          if (!net.roads[cls]) continue;
          strokeLines(
            mapCtx, net.roads[cls],
            `rgba(${r}, ${g}, ${b}, ${a * layer.alphas[cls]})`,
            layer.widths[cls],
          );
        }
      } else {
        strokeLines(
          mapCtx, net.transit[layer.key],
          `rgba(${r}, ${g}, ${b}, ${a})`, layer.widths[0],
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

          vehCtx.moveTo(px + VEHICLE_R, py);
          vehCtx.arc(px, py, VEHICLE_R, 0, Math.PI * 2);
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
