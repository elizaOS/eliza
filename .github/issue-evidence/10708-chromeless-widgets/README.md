# #10708 — chromeless home widgets: on-device before/after

`ondevice-before-after.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`), showing the exact
`HomeWidgetCard` container class change on the orange home wallpaper:

- **BEFORE** — the widget ("Calendar · 2 events today · 10:30") in a dark glass
  tile: `rounded-xl border border-white/12 bg-black/55` (rounded corners, border,
  translucent dark fill).
- **AFTER (#10708)** — the same content sitting directly on the wallpaper: no
  border, no background fill, no rounded card. Widgets separate by whitespace.

The synthetic page uses the verbatim before/after container class strings from
the diff (the `stories:dev` catalog is broken on develop by an unrelated stale
`isTruthyEnvValue` shim import, so this renders the exact class delta directly).
Behavior/tests are covered by the new `no-widget-chrome-gate` + the 23 passing
HomeWidgetCard consumer tests.
