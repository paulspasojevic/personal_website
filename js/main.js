const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

function entry(item) {
  const li = el("li");

  const head = el("div", "entry-head");
  const title = el("span", "entry-title");

  if (item.url) {
    const a = el("a", null, item.title);
    a.href = item.url;
    title.append(a);
  } else {
    title.textContent = item.title;
  }

  head.append(title);
  if (item.meta) head.append(el("span", "entry-meta", item.meta));
  li.append(head);

  if (item.note) li.append(el("p", "entry-note", item.note));
  if (item.tags?.length) li.append(el("div", "entry-tags", item.tags.join(" / ")));

  return li;
}

async function render(file, targetId, shape) {
  const target = document.getElementById(targetId);
  try {
    const res = await fetch(file);
    if (!res.ok) throw new Error(res.status);
    const items = await res.json();
    // Entries are shown unless explicitly switched off with "visible": false.
    const shown = items.filter((item) => item.visible !== false);
    target.append(...shown.map((item) => entry(shape(item))));
  } catch (err) {
    target.append(el("li", "entry-note", "Couldn't load this section."));
    console.error(`Failed loading ${file}:`, err);
  }
}

render("data/jobs.json", "jobs", (job) => ({
  title: job.role,
  url: job.url,
  meta: [job.start, job.end].filter(Boolean).join("–"),
  note: [job.company, job.note].filter(Boolean).join(" — "),
}));

render("data/projects.json", "projects", (project) => ({
  title: project.name,
  url: project.url,
  meta: project.year,
  note: project.note,
  tags: project.tags,
}));

render("data/education.json", "education", (edu) => ({
  title: edu.degree,
  url: edu.url,
  meta: [edu.start, edu.end].filter(Boolean).join("–"),
  note: [edu.institution, edu.note].filter(Boolean).join(" — "),
}));
