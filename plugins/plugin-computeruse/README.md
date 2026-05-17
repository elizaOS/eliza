# `@elizaos/plugin-computeruse`

Desktop automation plugin for elizaOS agents — screenshots, mouse /
keyboard control, browser CDP automation, window management, clipboard,
and the OCR provider registry that other plugins contribute to.

Ported from
[`coasty-ai/open-computer-use`](https://github.com/coasty-ai/open-computer-use)
(Apache 2.0).

## Boundary with `@elizaos/plugin-vision`

This plugin owns the OS surfaces:

- screen / display capture (`src/platform/capture.ts`,
  `src/platform/displays.ts`,
  `ComputerUseService.captureScreen()`),
- input + windows + clipboard + accessibility,
- the OCR provider registries — `OcrProvider` (line-level) and
  `CoordOcrProvider` (hierarchical with absolute coords), defined in
  `src/mobile/ocr-provider.ts`.

`@elizaos/plugin-vision` owns the camera pipeline, scene description
via `runtime.useModel(IMAGE_DESCRIPTION)`, the screen tiler, the
detector pipeline (faces / people / objects), and the OCR
implementations themselves. plugin-vision *consumes* capture from this
plugin via `runtime.getService("computeruse")` and *contributes* the
hierarchical OCR adapter into this plugin's `registerCoordOcrProvider`
seam at boot.

Both seams are runtime feature-detected — neither package depends on
the other.

See **[`docs/inference/vision-cua-boundary.md`](../../docs/inference/vision-cua-boundary.md)**
for the full ownership map, public types, wiring contract, and the list
of anti-patterns to avoid.

## Enabling

- Config: `features.computeruse: true`
- Env: `COMPUTER_USE_ENABLED=1`

## Platform requirements

| OS | Capture | Input |
|----|---------|-------|
| macOS | `screencapture` (built-in) | `cliclick` (`brew install cliclick`), AppleScript |
| Linux | `import` (ImageMagick) / `scrot` | `xdotool` (`sudo apt install xdotool`) |
| Windows | PowerShell + `System.Drawing` | PowerShell |
| Browser | — | `puppeteer-core` + Chrome / Edge / Brave |

## Surface

- **Actions** — `COMPUTER_USE` (canonical screenshot / click / key /
  scroll / etc.) and `WINDOW` (list / focus / arrange / move /...).
  Subactions are promoted to virtual top-level actions
  (e.g. `COMPUTER_USE_CLICK`, `WINDOW_FOCUS`) so the planner picks a
  specific verb directly from the catalogue.
- **Services** — `ComputerUseService` (`serviceType = "computeruse"`)
  and `VisionContextProvider`.
- **Providers** — `computerStateProvider`, `sceneProvider`.
- **Routes** — approval inbox + SSE stream + approval-mode toggle under
  `/api/computer-use/...`.

## File operations + shell

File operations live on the FILE action; shell / terminal access lives
on the SHELL action. They are **not** exposed by this plugin.

## Further reading

- [`docs/MULTI_MONITOR.md`](./docs/MULTI_MONITOR.md) — multi-display
  capture and coordinate translation.
- [`docs/SCENE_BUILDER.md`](./docs/SCENE_BUILDER.md) — how windows,
  a11y, screen, and OCR are composed into a single `Scene`.
- [`docs/IOS_CONSTRAINTS.md`](./docs/IOS_CONSTRAINTS.md) /
  [`docs/ANDROID_CONSTRAINTS.md`](./docs/ANDROID_CONSTRAINTS.md) —
  honest scope on mobile.
- [`docs/MOBILE_ASSISTANT_ROUTING.md`](./docs/MOBILE_ASSISTANT_ROUTING.md)
  — mobile request routing.
- [`docs/AOSP_SYSTEM_APP.md`](./docs/AOSP_SYSTEM_APP.md) — AOSP
  system-app deployment notes.
