# Eliza-1 / Computer-Use Test Matrix (WS10)

WS10 prep deliverable (2026-05-13). Companion to
[`05-memory-budgets.md`](05-memory-budgets.md). Each cell below is a
slot the WS10 finalization must fill in once WS2 (vision), WS3
(arbiter), WS5 (image-gen), WS8 (OCR + grounding), and WS9 (camera +
person-detect) land.

## Capabilities (rows)

- **vision-describe** — Qwen3-VL mmproj generates a caption / answer
  for a screenshot or photo.
- **image-gen** — diffusion GGUF emits a PNG for a text prompt.
- **screen-capture** — single-monitor screenshot to `Buffer`.
- **multi-monitor** — multi-display enumeration + per-display capture.
- **OCR** — RapidOCR det+rec returns `{ text, bbox }[]` for an image.
- **AX-fusion** — accessibility-tree annotations merged with OCR/CV
  results into a single `Element[]`.
- **click-grounding** — natural-language target → coordinate using
  vision + AX/OCR fusion.
- **app-enum** — list visible applications with windows + frontmost.
- **camera-capture** — single-frame capture from the system camera.

## Platforms (columns)

| Code | Description |
|---|---|
| mac14 | macOS 14 Sonoma |
| mac15 | macOS 15 Sequoia (Apple Intelligence baseline) |
| linX  | Linux X11 (xdotool / xrandr / scrot path) |
| linW  | Linux Wayland (PipeWire portal + ydotool path) |
| win10 | Windows 10 (PowerShell System.Drawing fallback) |
| win11 | Windows 11 (DirectX desktop duplication path) |
| and14 | Android 14 consumer APK (Activity / MediaProjection) |
| andSys | AOSP system-app build (privileged InputManager) |
| ios17 | iOS 17 (no Foundation Models; on-device VLM via mmproj) |
| ios26 | iOS 26+ Foundation Models (OS-managed text path) |

## Cells

For each `(capability, platform)`: **assertion** (what gets tested) /
**how** (CI / manual) / **gate** (env or device class blocking the
test). `n/a` means the capability does not exist on that platform by
design (e.g. multi-monitor on a phone).

### vision-describe

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | mmproj-2b returns non-empty caption for fixture PNG | same | same | same | same | same | same | same | same | OS Foundation Model returns caption (no mmproj resident) |
| How | `imagegen-prompt.golden` style mock + `golden/vision-describe.live.test.ts` (manual) | same | CI nightly under Xvfb | manual on Wayland-only host | CI under win11 runner | CI under win11 runner | manual (APK on test device) | manual (AOSP build on Pixel 6) | manual (TestFlight build) | manual (TestFlight build, iOS 26) |
| Gate | macOS perms granted | same | `DISPLAY` set | `WAYLAND_DISPLAY` set | win10 runner | win11 runner | adb-attached device | rooted AOSP build | TestFlight | iOS 26 device |

### image-gen

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | sd-1.5 / z-image-turbo emits valid PNG (signature + size) | same | same | same | same | same | sd-1.5 only (RAM gate) | same | sd-1.5 only | sd-1.5 only |
| How | `imagegen-prompt.golden.test.ts` (CI, deterministic stub) + `imagegen-prompt.live.test.ts` (manual on device) | same | CI (stub) + manual on a CUDA host | manual | CI (stub) | CI (stub) + manual on CUDA Win | manual | manual | manual | manual |
| Gate | none for stub; for live: M2 16 GB+ | same | none for stub; for live: 12 GB VRAM CUDA | manual | none for stub; for live: 12 GB VRAM CUDA | same | live-only on Snapdragon 8 Elite | same | live-only on iPhone 17 Pro | same |

### screen-capture

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | non-empty PNG buffer for default display | same | same (scrot) | same (PipeWire portal) | same (System.Drawing) | same (DXGI) | MediaProjection prompt → bytes | InputManager bypass | n/a (sandboxed) | n/a |
| How | `computeruse-cross-platform.e2e.test.ts` | same | CI under Xvfb | manual | CI under win11 | CI under win11 | manual | manual | n/a | n/a |
| Gate | screen-recording perm granted | same | `DISPLAY` | `WAYLAND_DISPLAY` | win10 runner | win11 runner | device | device | n/a | n/a |

### multi-monitor

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | enumerates >=2 displays when attached | same | same | same | same | same | n/a | n/a | n/a | n/a |
| How | manual on dual-display Mac | same | manual | manual | manual | manual | n/a | n/a | n/a | n/a |
| Gate | dual-display rig | same | dual-display rig + xrandr | dual-display rig + Wayland | dual-display rig | dual-display rig | n/a | n/a | n/a | n/a |

### OCR

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | RapidOCR det+rec returns `{ text, bbox }[]` for fixture PNG | same | same | same | same | same | same | same | use Vision framework instead of RapidOCR | same |
| How | `screen-to-click.golden.test.ts` (deterministic stub) + `ocr.live.test.ts` (manual) | same | CI (stub) | CI (stub) | CI (stub) | CI (stub) | manual | manual | manual | manual |
| Gate | none for stub; live needs RapidOCR ONNX present | same | same | same | same | same | device | device | device | device |

### AX-fusion

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | merged element list contains AX nodes + OCR text + CV elements with consistent ids | same | best-effort (atspi optional) | same | UIAutomation path | same | accessibility-service path | privileged InputManager path | accessibility-API path | same |
| How | manual on Mac with AX perms | same | manual | manual | manual | manual | manual | manual | manual | manual |
| Gate | AX perm granted | same | atspi installed | atspi + Wayland portal | UIA | UIA | accessibility-service granted | rooted | accessibility-service | same |

### click-grounding

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | "click the Save button" → coordinate within Save's bbox | same | same | same | same | same | same | same | same | same |
| How | `screen-to-click.golden.test.ts` (deterministic stub) + `click-grounding.live.test.ts` (manual) | same | CI (stub) + manual | manual | CI (stub) + manual | same | manual | manual | manual | manual |
| Gate | none for stub; live needs vision + AX/OCR | same | same | same | same | same | device | device | device | device |

### app-enum

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | lists visible apps with windowTitle + frontmost flag | same | wmctrl path | best-effort under Wayland | Get-Process | same | UsageStatsManager path | privileged | n/a (sandbox) | n/a |
| How | `windows-list.real.test.ts` | same | CI under Xvfb (wmctrl) | manual | CI under win11 | CI under win11 | manual | manual | n/a | n/a |
| Gate | none | same | wmctrl installed | manual | win10 runner | win11 runner | device | device | n/a | n/a |

### camera-capture

| Capability | mac14 | mac15 | linX | linW | win10 | win11 | and14 | andSys | ios17 | ios26 |
|---|---|---|---|---|---|---|---|---|---|---|
| Assertion | single-frame capture returns non-empty image buffer | same | v4l2 path | PipeWire camera portal | DirectShow | MediaFoundation | CameraX path | privileged | AVCaptureSession | same |
| How | `camera-to-reaction.golden.test.ts` (deterministic stub) + `camera-capture.live.test.ts` (manual) | same | CI (stub) + manual | manual | CI (stub) | CI (stub) + manual | manual | manual | manual | manual |
| Gate | camera perm granted | same | v4l2 device present | PipeWire camera portal | win10 runner with cam | win11 runner with cam | device | device | device | device |

## Conventions

- "CI" = runs in unattended CI on a Linux runner (no GPU, no
  GUI session). Almost all CI cells are stub-backed; live cells run
  manually on the listed device.
- "manual" = a human runs the script on the listed device; output
  recorded under
  `eliza/reports/ws10/<capability>/<platform>/<date>.md`.
- "Gate" = the env var / device / permission that blocks the test
  from running. The test must `skip` (not fail) when its gate is
  unmet.
- A cell tagged `n/a` is a deliberate non-target. The matrix entry
  exists to make that explicit so we can tell "not yet tested" apart
  from "intentionally never tested."

## Cross-references

- Per-device-class budget: [`05-memory-budgets.md`](05-memory-budgets.md)
- Bundle plan: [`../ELIZA_1_GGUF_PLATFORM_PLAN.json`](../ELIZA_1_GGUF_PLATFORM_PLAN.json)
- Bundle extras: [`../ELIZA_1_BUNDLE_EXTRAS.json`](../ELIZA_1_BUNDLE_EXTRAS.json)
- Golden tests:
  - `eliza/plugins/plugin-computeruse/test/golden/screen-to-click.golden.test.ts`
  - `eliza/plugins/plugin-computeruse/test/golden/camera-to-reaction.golden.test.ts`
  - `eliza/plugins/plugin-computeruse/test/golden/imagegen-prompt.golden.test.ts`
