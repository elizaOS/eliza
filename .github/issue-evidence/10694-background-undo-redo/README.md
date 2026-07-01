# #10694 (slice) — background versioned undo/redo: on-device before/after

`ondevice-undo-redo.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`):

- **BEFORE** — undo only: green → crimson → undo → green, and the undone
  crimson config was discarded (no way forward).
- **AFTER (#10694)** — undo ⇄ redo: …→ green → **redo** → crimson back. The
  forward step re-applies the last undone config; a fresh edit clears the redo
  future.

Root capability is in `useDisplayPreferences` (a bounded in-memory redo stack +
`redoBackgroundConfig` + `canRedoBackground`), threaded through
`state/types.ts` → `AppContext` → `useBackgroundConfig`, and given a real trigger
via a `redo` op on the agent's `background:apply` rail (`useBackgroundApplyChannel`,
symmetric with `undo`). 8/8 unit tests; typecheck 0 errors.
