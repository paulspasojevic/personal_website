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

## Theme

Dark by default for everyone; the `[light]` button in the header overrides and
remembers the choice. Colours live in one `:root` block at the top of
`css/style.css`, each written as `light-dark(light, dark)`.

Amber tokens (`--amber #ffb000`, `--amber-hi #ffc940`) come from
`r_projects/dwelling_job_access/quarto/css/styles.css`, so this matches the
thesis and the Quarto reports.

Two coupled things, noted in the code as well:

- `color-scheme` in `style.css` and `DEFAULT_THEME` in `js/main.js` must agree.
- Amber is only legible on black. Light mode deepens it to `#8f5600`, because
  `#ffb000` on white is 1.7:1. Contrast floors are commented per line.

## Fonts

Geist and Geist Mono (variable, one file each covers weights 100–900), plus the
five Geist Pixel styles — unused, but declared, and a browser won't download a
font nothing on the page uses. OFL 1.1: `fonts/OFL.txt` must ship with them.

## Deploying

Static files. Upload the lot, `fonts/` included:

```sh
rsync -av --delete ./ user@host:/path/to/webroot/ --exclude '.git'
```
