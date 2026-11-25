# css-twins

Finds CSS that's almost the same, like a button copied with 2px more padding or a fade-in written
twice under two names, and tells you which shared class to use instead.

[Demo](https://cameronspears.github.io/css-twins/demo/) (edit the CSS and watch the report change)

```bash
npx css-twins
```

It scans every `.css` file under the current folder, CSS modules included, and skips
`node_modules`, `dist`, `build`, `out`, `coverage`, `.git` and `.next`. To scan only some files,
name them: `npx css-twins src "app/**/*.module.css"`. Quote globs so your shell leaves them alone.

Here is the report for the [fixtures](fixtures) in this repo:

```text
$ npx css-twins fixtures
css-twins  4 files scanned

Components that are almost the same  2 groups
  Button  98% alike
    .ctaButton   fixtures/components/Header.module.css
    .buyButton   fixtures/components/Pricing.module.css
    → use .btn   fixtures/styles/tokens.css               98% alike
  Card  94% alike
    .planCard      fixtures/components/Pricing.module.css
    .featureCard   fixtures/components/Pricing.module.css
    → use .card    fixtures/styles/tokens.css               97% alike

Animations that do the same thing  2 groups
  Animation  100% alike
    appear    fixtures/components/Header.module.css
    fade-in   fixtures/styles/tokens.css
  Animation  96% alike
    rise       fixtures/components/Pricing.module.css
    slide-up   fixtures/components/Toast.module.css

Timings  4 in use, 2 used once
  200ms   ×2
  150ms   ×2
  160ms   ×1   used once
  350ms   ×1   used once

Easings  3 in use
  var(--ease-out)                    ×3
  ease-out                           ×2
  cubic-bezier(0.25, 0.8, 0.25, 1)   ×1
  Nearly the same curve: var(--ease-out) and cubic-bezier(0.25, 0.8, 0.25, 1) (0.05 apart)

States with more than one look  3 states
  Press effects
    scale(0.97)   ×2
    scale(0.95)   ×1
  Focus rings
    3px solid #93c5fd   ×1
    2px solid #2563eb   ×1
  Disabled looks
    0.4   ×1
    0.5   ×1

Summary
  Component copies   2
  Animation copies   2
  Stray timings      2
  Similar easings    1
```

## What it looks for

Someone needs a button, can't find the shared one, and writes `.buyButton` with slightly different
padding. Someone else writes a `fade-in` that already exists as `appear`. Linters catch exact
repeats. They don't catch two files doing almost the same thing under different names.

css-twins compares what rules do, not what they're called. It looks for:

- Buttons, cards, headings, inputs, chips, menus, labels and a few other kinds of component whose
  styles differ by a pixel or two.
- `@keyframes` with the same steps under different names, however the steps are written.
- Stray timings: a `160ms` next to a dozen `150ms`, or anything off your timing scale.
- Easings that are nearly the same curve, including ones behind a token.
- More than one press effect, focus ring or disabled look.

When a group is close enough to one of your shared classes, the report says to use that class. By
default, shared classes are the ones in files that set custom properties on `:root`, which is
usually your tokens or base stylesheet. If yours live elsewhere, pass `--shared "styles/kit/*.css"`.

It can't tell a copy from a deliberate variant, so it reports and leaves the fixing to you.

## Options

- `-t, --threshold <n>` (default `0.8`): how alike two things must be to count as copies, from 0
  to 1.
- `--scale <ms,...>`: the timings your system allows. Without it, a timing used only once is
  flagged.
- `--shared <glob>`: files that hold your shared classes. Repeat it for more.
- `--json`: print the full report as JSON.
- `--config <file>` (default `css-twins.config.json`): read options from a file. Flags win over it.
- `--no-color`: plain text. Colour is also off when the output isn't a terminal or `NO_COLOR` is
  set, and `FORCE_COLOR=1` turns it on.

The config file takes the same options, plus `families` to replace the built-in component kinds:

```json
{
  "threshold": 0.8,
  "scale": [80, 120, 150, 200, 350, 500],
  "shared": ["styles/base.css"],
  "families": [{ "family": "Button", "name": "(button|btn|cta)", "needs": ["height", "background"] }]
}
```

Each family has a name for the report, a regex for class names, and the properties a rule must set
at least one of. It can also have its own `threshold` and a `shared` regex for which shared classes
may stand in.

## Using it in CI

Save a report, then fail the build when any count goes up:

```bash
npx css-twins --json > twins.json     # commit this
npx css-twins --baseline twins.json   # in CI
```

Or fail as soon as any twin turns up, with `--fail-on components,animations` (the kinds are
`components`, `animations`, `timings` and `any`).

It exits `0` when all is well, `1` when a `--fail-on` or `--baseline` check fails, and `2` on bad
input.

## In code

```ts
import { analyze, analyzeFiles, formatReport } from 'css-twins';

const report = analyzeFiles(['src'], { scale: [120, 200, 350] });
console.log(formatReport(report));

// Or pass CSS text yourself. Nothing touches the disk.
analyze([{ file: 'a.css', css: '.a { color: red }' }]);
```

`analyze` and `analyzeFiles` take `threshold`, `scale`, `isShared` and `families`. Everything is
typed and documented in your editor.

## How alike is alike

Each plain class rule is boiled down to the properties that shape how it looks: size, padding,
colour, type, border, radius, shadow and gap. Tokens on `:root` are filled in, so `var(--radius)`
and `10px` are the same value.

Two values score 1 if they match, and 0.85 if they have the same shape with numbers a little apart
(within 2px or 15%). Two rules score the average over every property either one sets, so a property
only one side has counts against them. Rules at or above the threshold are grouped. A shared class
is suggested if it scores 0.7 or more against the group.

`@keyframes` are compared the same way, step by step, with `from` and `to` read as `0%` and `100%`.

It only reads CSS. Styles in JavaScript, Tailwind classes and inline styles aren't seen, and rules
inside media queries or with selectors like `.card > .title` are skipped. Run your Sass or Less
build first and point it at the output.

## Why not Stylelint

Keep using [Stylelint](https://stylelint.io). Its duplicate rules catch exact repeats in one file.
css-twins finds near-copies across files under different names, which Stylelint doesn't try to do.

## License

MIT
