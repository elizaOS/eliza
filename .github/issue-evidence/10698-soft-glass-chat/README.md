# #10698 — soft glass chat panel: on-device before/after

`ondevice-before-after.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`):

- **BEFORE** — a stack of individually-scrimmed bubbles (assistant `bg-black`,
  user `bg-black/30`) on a transparent panel, plus a GPU backdrop blur that had
  turned the #9141 battery gate RED on develop.
- **AFTER (#10698)** — one soft-glass panel surface (dark translucent tint + a
  faint top-sheen gradient, NO GPU backdrop blur) with the message text floating
  transparently on it; a text-shadow keeps it legible.

Also fixes the #9141 develop-red (removed the reintroduced backdrop blur from the
panel SURFACE + FirstRunRuntimeChooser). Verified: no-backdrop-blur-gate 1/1
(green), ContinuousChatOverlay 93/93 + fuzz 113/113, typecheck 0 errors.
