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
and folders back to 2019. It's all preserved, moved server-side into
`public_html/_attic-ba3394a0fc/` with an `.htaccess` that blocks directory
listings and asks search engines not to index it. The old Tree Data page still
works at `/_attic-ba3394a0fc/`.

Left alone in the webroot, because moving them breaks things:

- `.well-known/` — SSL certificate validation. Moving it breaks HTTPS renewal.
- `.htaccess` — cPanel's PHP handler, marked "do not edit".
- `cgi-bin/` — cPanel expects it.

A partial local backup is in `../personal_website_backup_20260716/` (the old
`index.html`, `main.css`, and a few small files). It is **not** a full backup —
the bulk is only on the server.
