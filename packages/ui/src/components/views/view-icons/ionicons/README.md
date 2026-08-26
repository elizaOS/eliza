# Ionicons launcher assets

These SVGs are the filled/default variants vendored from `ionicons@8.1.0`
(`dist/svg`) for Eliza's launcher icon system.

- Source: https://github.com/ionic-team/ionicons/tree/v8.1.0
- License: MIT, reproduced in `LICENSE`
- Update rule: keep the set scoped to names referenced by
  `../../launcher-ionicons.ts`

The official SVG files are used instead of the package's data-URI exports so
stroke-based symbols retain their explicit fill, stroke, and width attributes
without requiring the `ion-icon` web component runtime.
