# #10715 (part 2) — diagonal conversation-swipe reliability: on-device visual

`ondevice-swipe-cone.png` — rendered on a connected Android instance
(emulator-5556, via the device's own Chrome + `adb reverse`): the horizontal
swipe-acceptance cone before/after the fix, for a deliberate 65px-across ×
75px-vertical diagonal swipe.

- **BEFORE — 45° cone** (`|deltaLeft| <= |deltaUp|`): the diagonal falls
  **outside** → rejected, so the swipe never paged prev/next (the "only registers
  on a strictly horizontal drag" bug).
- **AFTER — ~51° cone** (`HORIZONTAL_DOMINANCE_RATIO = 0.8`): the same diagonal
  falls **inside** → accepted → fires prev/next.

Mostly-vertical drags (e.g. 60/90) are still rejected. Proven by 17/17
`use-pull-gesture` unit tests (the 2 new diagonal cases + the preserved (80,120)/
(70,90) rejections) + `ContinuousChatOverlay` 92/92.

Scope: the swipe-reliability half of #10715. The scrim-passthrough half (letting
launcher-background gestures reach `HomeLauncherSurface` while chat is open) is
DOM/pointer-region + e2e work, tracked as the remaining item.
