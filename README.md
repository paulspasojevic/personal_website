# personal site

Static HTML/CSS/JS. No build step, no dependencies.

## Editing content

Everything you'd normally update lives in `data/` — you shouldn't need to touch
the HTML:

| file                  | shows up under |
| --------------------- | -------------- |
| `data/projects.json`  | Projects       |
| `data/jobs.json`      | Work           |
| `data/education.json` | Education      |

Entries render in file order. Add `"visible": false` to hide one without
deleting it (see the Optus entry in `jobs.json`).

Optional fields just don't render if you leave them out: `url` makes the title
a link, `tags` adds the slash-separated line, `note` adds the description.

## Previewing

The page fetches the JSON, and browsers block `fetch` on `file://`, so
**opening `index.html` directly won't work**. Serve it:

```sh
python3 -m http.server
# then open http://localhost:8000
```

## Layout

Above `68rem`:

```
~/ Paul Spasojevic ▐        <- h1 spans both columns
──────────────┬──────────────
intro         │ // Projects
links         │ // Work
(sticky)      │ // Education
```

One column below that, which is what phones get.

The `<h1>` sits **outside `<header>`** in the markup so the grid can span it
across both columns — that's the one structural requirement. Source order is
h1, header, sections, which is also the reading order, so screen readers agree
with what's on screen.

`--sidebar` sets the left column; the 22rem floor is about keeping the intro
readable.

The layout block lives at the **end** of `style.css` on purpose. Media queries
add no specificity, so a base rule further down the file beats them — which
already happened once: `section { margin-top: var(--gap) }` silently overrode
the `margin-top: 0` in the media query, and the first section carried a phantom
40px margin that knocked `// Projects` out of line with the intro.

## Theme

One theme: OLED black with amber, for everyone, regardless of their OS
setting. Colours live in one `:root` block at the top of `css/style.css`, one
final value each. There is no toggle and no second palette.

Amber tokens (`--amber #ffb000`, `--amber-hi #ffc940`) come from
`r_projects/dwelling_job_access/quarto/css/styles.css`, so this matches the
thesis and the Quarto reports.

There was a light mode. It went because amber is only legible on black —
`#ffb000` on white is 1.7:1 — so light mode had to substitute a deepened
`#8f5600` for every amber on the page. That is not the same design with
different values in it, it is a second palette sharing only the layout, and
it was carrying a toggle, a `localStorage` round trip, an inline pre-paint
script and a `light-dark()` pair on every colour to stay alive. Contrast
floors are still commented per line.

## Fonts

Geist Mono (variable, one file, weights 100–900) for everything except the name,
which is **Geist Pixel Circle**. Both are preloaded in `index.html`.

Geist Pixel has **no weight axis** (no `fvar`, `usWeightClass` 400), so
`font-weight` does nothing to the name — asking for a bold makes the browser
synthesise one, which thickens the dots and fills in the pixel forms. It's
pinned to 400 deliberately.

Also shipped but unused: Geist Sans and the other four Pixel styles (Line,
Square, Grid, Triangle). They're declared in `@font-face` but nothing on the
page uses them, and a browser won't download a font it doesn't render — so they
cost visitors nothing and are there to swap in. **Don't preload them**: an
earlier preload of Geist Sans pulled 68KB on every visit for a font that
renders nothing.

Not every glyph exists in every face — `⧉` and `⤴` are absent from Geist Mono,
for instance, and would fall back silently. Check before using one:

```sh
python3 -c "from fontTools.ttLib import TTFont; \
print(0x2197 in TTFont('fonts/geist-mono-variable.woff2').getBestCmap())"
```

OFL 1.1: `fonts/OFL.txt` must ship with them.

## Deploying

```sh
./deploy.sh --dry    # list what would upload, touch nothing
./deploy.sh          # upload
```

Goes to `public_html` on paulspasojevic.com over SFTP, key-based, no password.

Connection details are in `~/.ssh/config` under the alias
`paulspasojevic-deploy`, and the key is `~/.ssh/id_ed25519_website`. Neither is
in this repo — the script has no secrets in it, so it's safe to make public.
On a new machine, recreate both; the key must be re-authorized in cPanel
(SSH Access → Manage SSH Keys → Import, then **Authorize** — importing alone
does nothing).

### Why SFTP and not rsync

Shell access is disabled on the cPanel account. rsync needs a remote shell, so
it can't run; SFTP is a separate subsystem and still works. The catch: this
**adds and overwrites, never deletes**. Delete a file locally and it stays live
on the server until you remove it by hand. If you ever get shell access enabled,
switch to `rsync -av --delete` and this stops being a footgun.

### The old site

The webroot held a decade of accumulated work — a 10.9 MB Quarto "Tree Data"
page as `index.html`, plus `model.html`, `ptv/`, `memdb/`, a 35 MB `.mbtiles`,
and folders back to 2019. None of it was deleted: it's preserved server-side in
an archive directory under `public_html`, with an `.htaccess` that blocks
directory listings and asks search engines not to index it.

The directory name is deliberately not written down here. It's in
`NOTES.local.md`, which is gitignored, and you can always `ls public_html` over
SFTP to find it.

Left alone in the webroot, because moving them breaks things:

- `.well-known/` — SSL certificate validation. Moving it breaks HTTPS renewal.
- `.htaccess` — cPanel's PHP handler, marked "do not edit".
- `cgi-bin/` — cPanel expects it.

A partial local backup is in `../personal_website_backup_20260716/` (the old
`index.html`, `main.css`, and a few small files). It is **not** a full backup —
the bulk is only on the server.
