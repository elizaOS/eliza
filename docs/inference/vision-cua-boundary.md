# Vision ↔ Computer-Use Plugin Boundary

This document is the source of truth for what `@elizaos/plugin-vision`
and `@elizaos/plugin-computeruse` each own, how they depend on one
another at runtime, and the seams that keep that dependency one-way.

If a future change conflicts with this doc, fix the code or update this
doc — do not introduce a parallel ownership story.

## Ownership

### `@elizaos/plugin-computeruse` owns

- **Screen / display capture** — per-display PNG bytes, primary-display
  capture, region capture. All multi-monitor enumeration.
  - `plugins/plugin-computeruse/src/platform/capture.ts`
    (`captureDisplay`, `captureAllDisplays`, `capturePrimaryDisplay`,
    `captureDisplayRegion`).
  - `plugins/plugin-computeruse/src/platform/displays.ts`
    (`listDisplays`, `getPrimaryDisplay`, `findDisplay`, `DisplayInfo`).
  - `ComputerUseService.captureScreen(): Promise<Buffer>` —
    primary-display PNG, the public surface other services consume.
- **Raw input + OS surfaces** — mouse, keyboard, scroll, clipboard,
  window list / focus / arrange, accessibility tree, app enumeration.
  - `plugins/plugin-computeruse/src/services/desktop-control.ts`,
    `plugins/plugin-computeruse/src/platform/clipboard.ts`,
    `plugins/plugin-computeruse/src/scene/a11y-provider.ts`,
    `plugins/plugin-computeruse/src/scene/apps.ts`.
- **Scene assembly** — windows + a11y + screen + OCR composed into a
  single `Scene` consumed by the autonomous loop.
  - `plugins/plugin-computeruse/src/scene/scene-builder.ts`,
    `plugins/plugin-computeruse/src/scene/scene-types.ts`.
- **OCR provider registries** — both line-level and hierarchical
  (block / line / word + absolute coords). Plugin-computeruse owns the
  *registry seams*; the implementations are contributed by other
  plugins (iOS Apple Vision, plugin-vision's RapidOCR adapter, the
  future native doctr-cpp).
  - `plugins/plugin-computeruse/src/mobile/ocr-provider.ts`
    (`registerOcrProvider`, `selectOcrProvider`,
    `registerCoordOcrProvider`, `getCoordOcrProvider`,
    `OcrProvider`, `CoordOcrProvider`).

### `@elizaos/plugin-vision` owns

- **Scene description** via `runtime.useModel(IMAGE_DESCRIPTION)` —
  routed to eliza-1 (Qwen3.5-VL) locally or whichever provider has
  registered the model slot.
  - `plugins/plugin-vision/src/service.ts`
    (`describeSceneWithVLM` and the `VisionService` lifecycle).
- **Camera capture** — laptop / USB / mobile camera frames, the
  detector pipeline that turns them into `SceneDescription`. This is
  the only capture path that does not flow through plugin-computeruse.
  - `plugins/plugin-vision/src/audio-capture*.ts`,
    `plugins/plugin-vision/src/face-recognition.ts`,
    `plugins/plugin-vision/src/face-detector-mediapipe.ts`,
    `plugins/plugin-vision/src/person-detector.ts`,
    `plugins/plugin-vision/src/yolo-detector.ts`.
- **Screen tiling + OCR feature detectors over screen frames** — once a
  screen frame is in hand (camera mode or delegated from
  plugin-computeruse), plugin-vision tiles it for the VLM and runs OCR.
  - `plugins/plugin-vision/src/screen-tiler.ts`,
    `plugins/plugin-vision/src/screen-capture.ts`
    (delegation switch + tiler driver — see "Wiring at boot" below),
    `plugins/plugin-vision/src/ocr-service*.ts`.
- **OCR-with-coords adapter** — the hierarchical provider that
  plugin-computeruse's coord registry consumes.
  - `plugins/plugin-vision/src/ocr-with-coords.ts`
    (`OcrWithCoordsService`, `RapidOcrCoordAdapter`).

## Dependency Direction

The dependency graph is one-way at the package level and one-way at the
runtime level. Neither plugin imports the other's package — both seams
are runtime feature-detected.

```
┌──────────────────────┐     screen capture (delegate)     ┌────────────────────────┐
│ @elizaos/            │ ───────────────────────────────▶ │ @elizaos/              │
│ plugin-vision        │                                   │ plugin-computeruse     │
│                      │                                   │                        │
│ (camera, VLM,        │ ◀─────────────────────────────── │ (OS surfaces, scene,   │
│  detectors, OCR)     │     OCR-with-coords (registry)    │  capture, OCR seam)    │
└──────────────────────┘                                   └────────────────────────┘
```

- **plugin-vision → plugin-computeruse** (capture).
  When `ComputerUseService` is registered on the runtime, plugin-vision
  delegates `ScreenCaptureService.captureScreen()` to it via
  `getComputeruseCapture(runtime)` (a duck-typed lookup of
  `runtime.getService("computeruse")`). When it is not registered
  (camera-only hosts, mobile, headless tests) plugin-vision falls
  through to its own direct-capture path.
- **plugin-computeruse → plugin-vision** (OCR-with-coords).
  plugin-computeruse exposes `registerCoordOcrProvider(...)` /
  `getCoordOcrProvider()` (`mobile/ocr-provider.ts`) as a registry. In
  its `init` hook, plugin-vision dynamically imports
  `@elizaos/plugin-computeruse/mobile/ocr-provider` and registers
  `RapidOcrCoordAdapter`. Import failure (plugin not installed) is a
  clean no-op.

Neither plugin lists the other in its `dependencies`,
`peerDependencies`, or `optionalDependencies`. The seams are
runtime-only by design — both plugins must remain independently
installable.

## Public Types

The two seams live behind these types. Anything else is implementation
detail.

### Capture seam (consumed by plugin-vision)

`getComputeruseCapture(runtime)` returns either `null` or a function
with this signature:

```ts
type ComputeruseCaptureFn = (
  opts?: { displayId?: number },
) => Promise<{
  displayId: string;
  width: number;
  height: number;
  pngBytes: Buffer;
}>;
```

- `displayId` is stringified so opaque platform ids (CGDirectDisplayID,
  Sway output names) round-trip without lossy coercion.
- `pngBytes` is at backing-store resolution — same contract as
  `DisplayCapture.frame` from `platform/capture.ts`.
- `width` / `height` are the decoded PNG dimensions (sharp metadata).

Definition: `plugins/plugin-vision/src/screen-capture.ts`.

### OCR-with-coords seam (consumed by plugin-computeruse)

```ts
interface CoordOcrProvider {
  readonly name: string;
  describe(input: CoordOcrInput): Promise<CoordOcrResult>;
}

interface CoordOcrInput {
  readonly displayId: string;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly pngBytes: Uint8Array;
}

interface CoordOcrResult {
  readonly blocks: ReadonlyArray<CoordOcrBlock>;
}
```

Full definition:
`plugins/plugin-computeruse/src/mobile/ocr-provider.ts`. The matching
provider implementation in plugin-vision is
`plugins/plugin-vision/src/ocr-with-coords.ts`
(`OcrWithCoordsService`, `RapidOcrCoordAdapter`).

The plugin-vision `OcrWithCoordsService` interface is structurally
identical to `CoordOcrProvider` — the adapter passes straight through.
The two interface declarations exist on each side of the boundary so
neither plugin has to import the other's types at the package level.

## Wiring at Boot

### plugin-computeruse

`ComputerUseService` registers itself under
`serviceType = "computeruse"` from
`plugins/plugin-computeruse/src/services/computer-use-service.ts`. It
exposes `captureScreen(): Promise<Buffer>` to any consumer that resolves
the service from the runtime. No additional wiring is required for the
capture seam — the registry seam (`registerCoordOcrProvider`) is a pure
module-level singleton in `mobile/ocr-provider.ts` and is populated by
plugin-vision's `init` hook below.

### plugin-vision

In order, at `init`:

1. `VisionService` constructs `ScreenCaptureService(config, runtime)`.
   The constructor calls `getComputeruseCapture(runtime)` exactly once
   and stores the result. On every `captureScreen()` call:
   - if the delegate exists, call it and emit a `ScreenCapture` whose
     image bytes came from plugin-computeruse;
   - otherwise, run the direct platform capture path
     (`scrot` / `screencapture` / PowerShell).
2. The `init` hook in `plugins/plugin-vision/src/index.ts` dynamically
   imports `@elizaos/plugin-computeruse/mobile/ocr-provider`. If the
   import resolves, it instantiates `RapidOcrCoordAdapter` and calls
   `registerCoordOcrProvider(adapter)`. If the import throws (plugin
   not installed), the hook returns silently — that host has no
   computer-use surface that would consume coord OCR.

Both seams are initialized once per process and are idempotent.

## Anti-Patterns

Do not do any of these. They re-introduce the boundary violations this
document exists to prevent.

- **Do not duplicate screen capture in plugin-vision.** The direct
  capture path in `screen-capture.ts` exists *only* as the
  computeruse-absent fallback. Adding multi-monitor enumeration,
  per-display capture, or DPI handling to plugin-vision is a
  boundary violation — extend `plugins/plugin-computeruse/src/platform/`
  instead.
- **Do not add `@elizaos/plugin-computeruse` to plugin-vision's
  `dependencies` (or vice versa).** The seams are runtime-only on
  purpose. A package-level dep would force both plugins to be
  installed together and break headless / mobile / camera-only hosts.
- **Do not introduce a feature flag for the capture delegation.** It
  is feature-detected via `runtime.getService("computeruse")`. A flag
  would create a second codepath that drifts.
- **Do not register OCR-with-coords providers anywhere except in
  plugin-vision's `init` hook.** plugin-computeruse owns the registry,
  plugin-vision owns the implementation. Other plugins that ship a
  better OCR (native doctr-cpp, Apple Vision, cloud) follow the same
  rule: they register against `registerCoordOcrProvider` from their
  own `init` hook and let priority sort them out.
- **Do not call `tileScreenshot` or any tiler from plugin-computeruse.**
  Tiling is a VLM-prompt concern owned by plugin-vision. computeruse
  hands over raw frames; plugin-vision decides how to slice them.
- **Do not import OCR types across the boundary.** The two
  `CoordOcrProvider` / `OcrWithCoordsService` interfaces are
  structurally identical *by design*. Each side declares its own; the
  adapter satisfies both shapes via structural typing.
