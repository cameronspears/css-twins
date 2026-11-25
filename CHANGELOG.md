# Changelog

## 0.1.0 (2026-11-24)

First release.

- `css-twins [paths or globs...]` scans `.css` files and CSS modules and prints a short report.
- Finds components that are almost the same (buttons, cards, headings, inputs, chips, menus, labels), animations that do the same thing, stray timings, easings that are nearly the same curve, and states with more than one look.
- Points each group at the shared class it could become. Shared files are the ones with `:root` tokens, or whatever `--shared` names.
- `--json`, `--threshold`, `--scale`, `--shared`, `--config` and `css-twins.config.json`.
- `--fail-on` and `--baseline` for CI, with exit codes 0, 1 and 2.
- Colour in a terminal, off with `NO_COLOR` or `--no-color`, on with `FORCE_COLOR`.
- Library: `analyze`, `analyzeFiles`, `formatReport`, `compare` and friends, with types and docs.
- A browser playground in `demo/`.
