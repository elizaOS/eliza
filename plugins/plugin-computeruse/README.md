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

The Linux X11 release-evidence path is executable with
`bun run capture:linux-desktop-evidence`; it uses a disposable controlled xterm
and emits a strict-validator-compatible evidence bundle. The lane requires
`xdotool`, `scrot`, `wmctrl`, `xclip`, `xrandr`, and `xterm`.

The Windows release-evidence path is executable with
`bun run capture:windows-desktop-evidence`; it confines synthetic input to a
fresh Notepad process, serves the browser fixture from a disposable loopback
origin, and emits a strict-validator-compatible evidence bundle.

The local browser-only safety path is executable with
`bun run test:e2e:browser-fixture`. It launches an isolated headless browser
against an ephemeral loopback page, captures a real screenshot, binds the
authorized click to that observation, verifies the page transition, and proves
that the consumed frame cannot authorize a repeated action. It never drives the
host cursor or an existing browser profile.

The protected multimodal acceptance path is
`bun run test:live:cerebras-browser-fixture`. It skips explicitly unless
`CEREBRAS_API_KEY` is injected through a protected environment, then makes two
bounded `gemma-4-31b` image-description calls: one to plan the allowlisted
fixture click despite hostile on-screen instructions, and one on a fresh frame
to verify completion. It uses the same isolated headless browser and ephemeral
loopback fixture; it never opens an existing profile or logs the credential.

## Surface

- **Actions** — `COMPUTER_USE` (canonical screenshot / click / key /
  scroll / etc.), `WINDOW` (list / focus / arrange / move /...), and
  `COMPUTER_USE_AGENT` (high-level goal-driven autonomous desktop loop:
  Brain → Cascade → dispatch up to `maxSteps` iterations).
  Subactions of `COMPUTER_USE` and `WINDOW` are promoted to virtual
  top-level actions (e.g. `COMPUTER_USE_CLICK`, `WINDOW_FOCUS`) so the
  planner picks a specific verb directly from the catalogue.
- **Services** — `ComputerUseService` (`serviceType = "computeruse"`)
  owns platform dispatch, approvals, and isolated sessions;
  `VisionContextProvider` exposes scene context.
- **Providers** — `computerStateProvider`, `sceneProvider`.
- **Routes** — approval inbox + SSE stream + approval-mode toggle under
  `/api/computer-use/...`.
- **Sessions** — authenticated `/api/computer-use/sessions` CRUD, action,
  read-only frame, lease-renewal, pause/resume/stop, and SSE routes expose
  exclusive physical-host ownership plus concurrent
  browser/sandbox/remote-guest targets. The compatibility DTO now projects the
  core v2 interaction semantics: canonical state/isolation/generation,
  screenshot observation IDs and SHA-256 provenance, typed outcomes, and
  metadata-only events. Before dispatch, the DTO is translated into a canonical
  core session/surface/action and passes the shared atomic
  `authorizeInteractionDispatch` boundary. Every consequential action binds to
  the latest unconsumed observation; stale, wrong-target, duplicate, busy, and
  repeated unchanged-screen attempts fail closed. Cursor state remains virtual
  per session. A desktop still has one physical mouse and keyboard.
- **Safety** — secure accessibility fields and overlapping OCR are structurally
  redacted before model prompting. Screenshot/OCR/page text is explicitly
  untrusted, the autonomous loop has owner cancellation plus a repeated-action
  guard, and the existing approval manager remains the authority for
  consequential dispatch. The session monitor shows capture/input/browser/
  vision readiness, approval mode, provenance, outcomes, history, and
  pause/resume/stop controls.

## File operations + shell

File operations live on the FILE action; shell / terminal access lives
on the SHELL action. They are **not** exposed by this plugin.

## Further reading

- [`docs/MULTI_MONITOR.md`](./docs/MULTI_MONITOR.md) — multi-display
  capture and coordinate translation.
- Scene composition — how windows, a11y, screen, and OCR are composed into a
  single `Scene` (the separate design note was never committed).
- [`docs/IOS_CONSTRAINTS.md`](./docs/IOS_CONSTRAINTS.md) /
  [`docs/ANDROID_CONSTRAINTS.md`](./docs/ANDROID_CONSTRAINTS.md) —
  honest scope on mobile.
- [`docs/MOBILE_ASSISTANT_ROUTING.md`](./docs/MOBILE_ASSISTANT_ROUTING.md)
  — mobile request routing.
- [`docs/AOSP_SYSTEM_APP.md`](./docs/AOSP_SYSTEM_APP.md) — AOSP
  system-app deployment notes.
