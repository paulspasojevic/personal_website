const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const view = document.getElementById("view");

function minutes(m) {
  if (!m) return null;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---- amounts ----------------------------------------------------- */

// Units measured on a scale get decimals; everything else — spoons, cups,
// counted things like "2 onions" — gets kitchen fractions, because nobody
// measures 0.33 tbsp.
const METRIC = new Set(["g", "kg", "ml", "l", "mg"]);

const FRACTIONS = [
  [0, ""], [1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"], [1, ""],
];

function fraction(n) {
  let whole = Math.floor(n);
  const rest = n - whole;
  let [value, glyph] = FRACTIONS[0];
  for (const f of FRACTIONS) {
    if (Math.abs(rest - f[0]) < Math.abs(rest - value)) [value, glyph] = f;
  }
  if (value === 1) whole += 1;
  if (!whole && !glyph) return "¼"; // never round a real amount down to nothing
  return whole ? `${whole}${glyph}` : glyph;
}

function metric(n) {
  if (n >= 100) return String(Math.round(n / 5) * 5);
  if (n >= 10) return String(Math.round(n));
  return String(Math.round(n * 10) / 10);
}

function amount(item, servings, base) {
  if (item.amount == null) return "";
  const n = item.per_person ? item.amount * servings : (item.amount * servings) / base;
  const unit = item.unit ? (item.unit.toLowerCase() === "l" ? "L" : item.unit) : "";
  const num = item.unit && METRIC.has(item.unit.toLowerCase()) ? metric(n) : fraction(n);
  return unit ? `${num} ${unit}` : num;
}

/* ---- index ------------------------------------------------------- */

async function showIndex() {
  document.title = "Recipes";

  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "search — title, tag, ingredient";
  search.setAttribute("aria-label", "Search recipes");

  const list = el("ol", "entries");
  const empty = el("p", "muted", "Nothing matches.");
  empty.hidden = true;
  view.append(search, list, empty);

  let recipes;
  try {
    recipes = await getJSON("data/index.json");
  } catch (err) {
    list.append(el("li", "muted", "Couldn't load the recipe list."));
    console.error(err);
    return;
  }

  const rows = recipes.map((r) => {
    const li = el("li");
    const head = el("div", "entry-head");
    const a = el("a", "entry-title", r.title);
    a.href = `?r=${encodeURIComponent(r.slug)}`;
    head.append(a);
    if (r.time_min) head.append(el("span", "entry-meta", minutes(r.time_min)));
    li.append(head);
    if (r.description) li.append(el("p", "entry-note", r.description));
    const tags = [r.cuisine, r.course, ...r.tags].filter(Boolean);
    if (tags.length) li.append(el("div", "entry-tags", tags.join(" / ")));

    const haystack = [r.title, r.description, r.cuisine, r.course, ...r.tags, ...r.ingredients]
      .filter(Boolean).join(" ").toLowerCase();
    return { li, haystack };
  });

  list.append(...rows.map((row) => row.li));

  // every word has to match somewhere, so "beef slow" narrows rather than widens
  search.addEventListener("input", () => {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const row of rows) {
      const hit = words.every((w) => row.haystack.includes(w));
      row.li.hidden = !hit;
      if (hit) shown++;
    }
    empty.hidden = shown > 0;
  });
}

/* ---- one recipe -------------------------------------------------- */

function wakeLockButton() {
  if (!("wakeLock" in navigator)) return null;

  const btn = el("button", "toggle", "[keep screen on]");
  btn.type = "button";
  btn.setAttribute("aria-pressed", "false");
  let lock = null;
  let wanted = false;

  const acquire = async () => {
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener("release", () => { lock = null; sync(); });
    } catch (err) {
      wanted = false;
      console.error(err);
    }
    sync();
  };
  const sync = () => {
    const on = wanted && lock != null;
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "[screen stays on]" : "[keep screen on]";
  };

  btn.addEventListener("click", () => {
    wanted = !wanted;
    if (wanted) acquire();
    else lock?.release();
    sync();
  });
  // the browser drops the lock whenever the tab is hidden; take it back
  document.addEventListener("visibilitychange", () => {
    if (wanted && !lock && document.visibilityState === "visible") acquire();
  });

  return btn;
}

function servingsControl(base, onChange) {
  const wrap = el("span", "servings");
  const minus = el("button", "step-btn", "−");
  const plus = el("button", "step-btn", "+");
  const value = el("output", null, String(base));
  minus.type = plus.type = "button";
  minus.setAttribute("aria-label", "Fewer servings");
  plus.setAttribute("aria-label", "More servings");
  value.setAttribute("aria-live", "polite");

  let n = base;
  const set = (next) => {
    n = Math.max(1, next);
    value.textContent = String(n);
    minus.disabled = n === 1;
    wrap.classList.toggle("scaled", n !== base);
    onChange(n);
  };
  minus.addEventListener("click", () => set(n - 1));
  plus.addEventListener("click", () => set(n + 1));
  minus.disabled = n === 1;

  wrap.append("serves ", minus, value, plus);
  return wrap;
}

function ingredientsBlock(r) {
  const block = el("section", "ingredients");
  block.append(el("h2", null, "Ingredients"));
  const amounts = [];

  for (const sec of r.ingredients) {
    if (sec.section) block.append(el("h3", null, sec.section));
    const ul = el("ul", "checklist");
    for (const item of sec.items) {
      const li = el("li");
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      const amt = el("span", "amount");
      amounts.push({ node: amt, item });
      const text = el("span", "ingredient");
      text.append(el("span", "name", item.name));
      // the amount shown is already the total; say what it was built from
      if (item.per_person) {
        const each = amount(item, 1, 1);
        text.append(el("span", "prep", ` — ${each} per person`));
      }
      if (item.prep) text.append(el("span", "prep", ` — ${item.prep}`));
      label.append(box, amt, text);
      li.append(label);
      ul.append(li);
    }
    block.append(ul);
  }

  const render = (servings) => {
    for (const { node, item } of amounts) node.textContent = amount(item, servings, r.servings);
  };
  render(r.servings);
  return { block, render };
}

function methodBlock(r) {
  const block = el("section", "method");
  block.append(el("h2", null, "Method"));
  const ol = el("ol", "steps");
  for (const step of r.method) {
    const li = el("li");
    if (step.title || step.time_min) {
      const head = el("div", "step-head");
      head.append(el("span", "step-title", step.title || ""));
      if (step.time_min) head.append(el("span", "entry-meta", minutes(step.time_min)));
      li.append(head);
    }
    li.append(el("p", null, step.instruction));
    ol.append(li);
  }
  block.append(ol);
  return block;
}

function extrasBlock(extra) {
  const block = el("section", "extra");
  block.append(el("h2", null, extra.title));
  const dl = el("dl");
  for (const [label, text] of Object.entries(extra.details)) {
    dl.append(el("dt", null, label), el("dd", null, text));
  }
  block.append(dl);
  return block;
}

function notesBlock(notes) {
  const block = el("section", "notes");
  block.append(el("h2", null, "Notes"));
  const ul = el("ul");
  for (const n of notes) ul.append(el("li", null, n));
  block.append(ul);
  return block;
}

async function showRecipe(slug) {
  let r;
  try {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`bad slug ${slug}`);
    r = await getJSON(`data/${slug}.json`);
  } catch (err) {
    view.append(el("p", "muted", "No recipe here. "), backLink());
    console.error(err);
    return;
  }

  document.title = `${r.title} — Recipes`;

  const head = el("header", "recipe-head");
  head.append(backLink(), el("h2", "recipe-title", r.title));
  if (r.description) head.append(el("p", "muted", r.description));

  const meta = el("p", "recipe-meta");
  const bits = [
    [r.cuisine, r.course].filter(Boolean).join(" / "),
    r.prep_time_min && `prep ${minutes(r.prep_time_min)}`,
    r.cook_time_min && `cook ${minutes(r.cook_time_min)}`,
  ].filter(Boolean);
  meta.append(bits.join(" · "));
  head.append(meta);

  const { block: ingredients, render } = ingredientsBlock(r);

  const controls = el("div", "controls");
  controls.append(servingsControl(r.servings, render));
  const wake = wakeLockButton();
  if (wake) controls.append(wake);
  head.append(controls);

  const body = el("div", "recipe-body");
  const side = el("div", "recipe-side");
  side.append(ingredients);
  const flow = el("div", "recipe-flow");
  flow.append(methodBlock(r));
  for (const extra of r.extras || []) flow.append(extrasBlock(extra));
  if (r.notes?.length) flow.append(notesBlock(r.notes));
  body.append(side, flow);

  const foot = el("footer", "recipe-foot");
  const footBits = [r.source && `source: ${r.source}`, r.added && `added ${r.added}`].filter(Boolean);
  if (r.tags?.length) footBits.push(r.tags.join(" / "));
  foot.textContent = footBits.join(" · ");

  view.append(head, body, foot);
}

function backLink() {
  const a = el("a", "back", "← all recipes");
  a.href = "./";
  return a;
}

const slug = new URLSearchParams(location.search).get("r");
if (slug) showRecipe(slug);
else showIndex();
