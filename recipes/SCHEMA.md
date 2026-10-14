# Recipe format

One recipe per file in `recipes/data/`, named by its slug:
`slow-cooker-japanese-beef-curry.json`. The filename is the recipe's URL
(`?r=slow-cooker-japanese-beef-curry`), so lowercase, hyphens, no spaces —
and don't rename a file once it's live, or old links break.

`slow-cooker-japanese-beef-curry.json` is the reference example. When in
doubt, copy its shape.

To convert a recipe with Claude, paste this whole file and say: *"Convert
this recipe to this format. Output only the JSON."*

## Fields

| field           | type             | required | notes |
| --------------- | ---------------- | -------- | ----- |
| `title`         | string           | yes      | |
| `description`   | string           |          | One or two sentences. Shown in the index. |
| `cuisine`       | string           |          | e.g. `"Japanese"` |
| `course`        | string           |          | e.g. `"Main"`, `"Side"`, `"Dessert"`, `"Baking"` |
| `servings`      | number           | yes      | What the amounts below make. Scaling starts here. |
| `prep_time_min` | number           |          | Minutes. |
| `cook_time_min` | number           |          | Minutes. |
| `tags`          | string[]         |          | Lowercase, hyphenated: `"slow-cooker"`. |
| `source`        | string           |          | Where it came from: a URL, a book, a person, `"Developed with Claude"`. |
| `added`         | string           |          | `YYYY-MM-DD`, when it went in here. |
| `ingredients`   | section[]        | yes      | See below. |
| `method`        | step[]           | yes      | See below. In order — there are no step numbers. |
| `extras`        | extra[]          |          | Side processes that aren't part of the method. See below. |
| `notes`         | string[]         |          | Tips, swaps, what to change next time. |

### Ingredient sections

```json
{ "section": "Curry", "items": [ ...ingredients ] }
```

`section` is a sub-heading. A recipe with no sub-headings still has one
section; set `"section": null` and no heading is drawn.

### Ingredients

```json
{ "amount": 500, "unit": "g", "name": "waxy potatoes", "prep": "cut into large chunks" }
```

| field        | type            | notes |
| ------------ | --------------- | ----- |
| `amount`     | number or null  | **A number, never a string.** `1.5`, not `"1 1/2"` or `"1-2"`. Null for "to taste" items. Ranges: pick one and put the range in `prep`. |
| `unit`       | string or null  | `g`, `kg`, `ml`, `l`, `tsp`, `tbsp`, `cup`, … Null for counted things (`2` onions). Only the unit — nothing like `"g per person"`. |
| `name`       | string          | The ingredient. |
| `prep`       | string or null  | How it's cut, alternatives, "optional". Never scaled. |
| `per_person` | true            | Optional. The amount is per serving, so the page multiplies by the servings shown instead of scaling it. |

Metric is preferred: weights in `g`/`kg`, liquids in `ml`, spoons for small
amounts.

### Method steps

```json
{ "title": "Brown the beef", "instruction": "Pat the beef dry…", "time_min": 20 }
```

`title` is short; `instruction` is the full text. `time_min` is optional or
null — set it only when the step has a real duration worth a timer.

### Extras

For anything that sits beside the method rather than in it: rice, a sauce, a
side, a make-ahead note. Each is a title and a list of labelled lines,
shown in the order written.

```json
{
  "title": "Rice",
  "details": {
    "Appliance": "Tiger IH rice cooker",
    "Ratio": "1 cup rice to 1.25 cups water"
  }
}
```

Don't add new top-level keys for one recipe. The page doesn't know about
them and won't show them — put it in `extras` or `notes` instead.

## Checking

```sh
python3 recipes/build_index.py
```

Validates every file against this format and rebuilds `data/index.json`.
`./deploy.sh --recipes` runs it before uploading and stops on an error.
