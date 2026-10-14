#!/usr/bin/env python3
"""Validate recipes/data/*.json and write recipes/data/index.json.

A static site can't list a directory, so the index page needs this file to
know what recipes exist. It's generated, so it's gitignored — run this
before previewing locally. ./deploy.sh --recipes runs it for you.

Checks each recipe against SCHEMA.md and stops on the first file with
problems, listing all of them, so a bad recipe never goes live.

    python3 recipes/build_index.py
"""

import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
INDEX = DATA / "index.json"

SLUG = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

TOP_LEVEL = {
    "title", "description", "cuisine", "course", "servings",
    "prep_time_min", "cook_time_min", "tags", "source", "added",
    "ingredients", "method", "extras", "notes",
}
INGREDIENT = {"amount", "unit", "name", "prep", "per_person"}
STEP = {"title", "instruction", "time_min"}


def is_num(v):
    # bool is an int in Python; true is not an amount
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check(r):
    errs = []

    def need(cond, msg):
        if not cond:
            errs.append(msg)

    if not isinstance(r, dict):
        return ["top level must be an object"]

    for k in r.keys() - TOP_LEVEL:
        errs.append(f"unknown field {k!r} — put it in extras or notes (see SCHEMA.md)")

    need(isinstance(r.get("title"), str) and r["title"], "title: required string")
    need(is_num(r.get("servings")) and r["servings"] > 0, "servings: required positive number")
    for k in ("description", "cuisine", "course", "source"):
        need(r.get(k) is None or isinstance(r[k], str), f"{k}: must be a string")
    for k in ("prep_time_min", "cook_time_min"):
        need(r.get(k) is None or is_num(r[k]), f"{k}: must be a number of minutes")
    need(r.get("added") is None or (isinstance(r["added"], str) and DATE.match(r["added"])),
         "added: must be YYYY-MM-DD")
    for k in ("tags", "notes"):
        v = r.get(k)
        need(v is None or (isinstance(v, list) and all(isinstance(x, str) for x in v)),
             f"{k}: must be a list of strings")

    sections = r.get("ingredients")
    if not (isinstance(sections, list) and sections):
        errs.append("ingredients: required, a non-empty list of sections")
        sections = []
    for i, sec in enumerate(sections):
        where = f"ingredients[{i}]"
        if not isinstance(sec, dict) or not isinstance(sec.get("items"), list):
            errs.append(f"{where}: must be {{\"section\": ..., \"items\": [...]}}")
            continue
        need(sec.get("section") is None or isinstance(sec["section"], str),
             f"{where}.section: must be a string or null")
        for j, it in enumerate(sec["items"]):
            w = f"{where}.items[{j}]"
            if not isinstance(it, dict):
                errs.append(f"{w}: must be an object")
                continue
            for k in it.keys() - INGREDIENT:
                errs.append(f"{w}: unknown field {k!r}")
            need(isinstance(it.get("name"), str) and it["name"], f"{w}.name: required string")
            need(it.get("amount") is None or is_num(it["amount"]),
                 f"{w}.amount: must be a number or null, got {it.get('amount')!r}")
            need(it.get("unit") is None or isinstance(it["unit"], str), f"{w}.unit: must be a string or null")
            need(not (isinstance(it.get("unit"), str) and " per " in f" {it['unit']} "),
                 f"{w}.unit: {it.get('unit')!r} — just the unit, and \"per_person\": true")
            need(it.get("prep") is None or isinstance(it["prep"], str), f"{w}.prep: must be a string or null")
            need(it.get("per_person") in (None, True), f"{w}.per_person: true or leave it out")
            if it.get("per_person"):
                need(is_num(it.get("amount")), f"{w}: per_person needs an amount")

    steps = r.get("method")
    if not (isinstance(steps, list) and steps):
        errs.append("method: required, a non-empty list of steps")
        steps = []
    for i, st in enumerate(steps):
        w = f"method[{i}]"
        if not isinstance(st, dict):
            errs.append(f"{w}: must be an object")
            continue
        for k in st.keys() - STEP:
            errs.append(f"{w}: unknown field {k!r}")
        need(isinstance(st.get("instruction"), str) and st["instruction"], f"{w}.instruction: required string")
        need(st.get("title") is None or isinstance(st["title"], str), f"{w}.title: must be a string")
        need(st.get("time_min") is None or is_num(st["time_min"]), f"{w}.time_min: must be a number or null")

    for i, ex in enumerate(r.get("extras") or []):
        w = f"extras[{i}]"
        ok = (isinstance(ex, dict) and isinstance(ex.get("title"), str)
              and isinstance(ex.get("details"), dict)
              and all(isinstance(v, str) for v in ex["details"].values()))
        need(ok, f"{w}: must be {{\"title\": str, \"details\": {{label: str, ...}}}}")

    return errs


def main():
    entries, failed = [], False

    for path in sorted(DATA.glob("*.json")):
        if path == INDEX:
            continue
        slug = path.stem
        try:
            r = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"{path.name}: not valid JSON — {e}", file=sys.stderr)
            failed = True
            continue

        errs = check(r)
        if not SLUG.match(slug):
            errs.insert(0, "filename must be lowercase-hyphenated, e.g. beef-curry.json")
        if errs:
            failed = True
            print(f"{path.name}:", file=sys.stderr)
            for e in errs:
                print(f"  {e}", file=sys.stderr)
            continue

        entries.append({
            "slug": slug,
            "title": r["title"],
            "description": r.get("description"),
            "cuisine": r.get("cuisine"),
            "course": r.get("course"),
            "tags": r.get("tags", []),
            "time_min": (r.get("prep_time_min") or 0) + (r.get("cook_time_min") or 0) or None,
            "added": r.get("added"),
            # so the search box finds "beef" or "miso" without fetching every file
            "ingredients": [it["name"] for sec in r["ingredients"] for it in sec["items"]],
        })

    if failed:
        print("\nindex.json not written — fix the above.", file=sys.stderr)
        sys.exit(1)

    entries.sort(key=lambda e: e["title"].lower())
    INDEX.write_text(json.dumps(entries, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(entries)} recipe{'s' if len(entries) != 1 else ''} -> {INDEX.relative_to(DATA.parent.parent)}")


if __name__ == "__main__":
    main()
