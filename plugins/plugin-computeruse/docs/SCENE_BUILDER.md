# Scene Builder (WS6)

The scene-builder produces a single compact `Scene` JSON object per turn that
captures the agent's full visual + structural context. WS7's Brain consumes
this contract to ground every coordinate-bearing action.

## Public surface

```ts
import {
  SceneBuilder,
  type Scene,
  type SceneUpdateEvent,
  serializeSceneForPrompt,
} from "@elizaos/plugin-computeruse";

// Via the service (preferred — service owns one builder per process):
const service = runtime.getService("computeruse");
const scene = await service.refreshScene("agent-turn");
const scene2 = service.getCurrentScene();
const unsub = service.subscribeToSceneUpdates((event) => { /* ... */ });

// Direct construction (mostly for tests):
const builder = new SceneBuilder({
  captureAll, captureOne, listDisplays, enumerateApps,
  accessibilityProvider, runOcrOnFrame, log,
});
const scene3 = await builder.tick("active");
```

## Pipeline

1. `listDisplays()` — WS5 enumerator (X11/xrandr, Wayland compositor IPC,
   macOS system_profiler, Windows `[Screen]::AllScreens`).
2. `captureAllDisplays()` — WS5 per-display PNG capture.
3. Whole-frame **dHash** per display. Hamming distance < 5 means "no
   change"; scene cache (TTL 30s) is reused.
4. **Block grid** (16×16) dirty-block diff. Active-mode ticks re-OCR only
   when blocks change.
5. **OCR** via the `OcrProvider` chain registered in
   `mobile/ocr-provider.ts`. plugin-computeruse stays dep-free; integrators
   register a vision-backed provider at startup (`registerOcrProvider(...)`).
   When no provider is registered the scene's `ocr` field is `[]`.
6. **Accessibility** snapshot via `AccessibilityProvider`:
   - Linux: AT-SPI (python3-atspi) → Hyprland/Sway IPC fallback.
   - macOS: AppleScript via `osascript -l JavaScript`.
   - Windows: PowerShell UIAutomation.
   - Android: `setAccessibilityProvider(nativeAdapter)` — WS8 plugs this in.
7. **App enumeration** = process list joined with window list.
   - Linux: `wmctrl -l -p` for pid resolution, `/proc/<pid>/comm` for names.
   - macOS: BSD `ps -axco`, name-based join with AppleScript windows.
   - Windows: `Get-Process` (pid already in window id).
8. Scene assembled with display-local bbox coordinates and `t<displayId>-<seq>`
   / `a<displayId>-<seq>` stable ids per display.

## Throttling policy

| Mode         | Trigger                          | Capture | OCR              | AX  |
| ------------ | -------------------------------- | ------- | ---------------- | --- |
| `idle`       | 1 Hz poll, no change > 2s        | yes     | reuse cache      | reuse cache |
| `active`     | 4 Hz poll, recent change         | yes     | full or block-dirty | refresh |
| `agent-turn` | `onAgentTurn()` from WS7         | yes     | always (full)    | refresh |

Agent turns always re-OCR even if the frame hash is identical — blinking
cursors and short-lived modal animations are common cases where pixel-equal
frames carry different semantic content.

## Coordinate contract for WS7

All bbox coordinates emitted in a Scene (`ocr[].bbox`, `ax[].bbox`,
`apps[].windows[].bounds`, `vlm_elements[].bbox`) are **display-local** —
they reference the display identified by the sibling `displayId` field. WS5's
`localToGlobal({ displayId, x, y })` translates to OS-global pixel space
before the input driver fires. The model never sees OS-global coords.

WS7 consumes the Scene by:
1. Reading `scene.focused_window` to default a target display.
2. Picking an OCR / AX / VLM element by stable id (`t0-12`, `a0-3`, etc.).
3. Computing a click point inside the element's bbox.
4. Issuing a `COMPUTER_USE click` with `{ displayId, coordinate }`.

The id format guarantees that "click element a47" means the same logical
target across consecutive turns within a single scene-builder lifetime
(the per-display sequence counter is monotonic; AX providers preserve
ordering across snapshots when AT-SPI / UIA tree shape is stable).

## Hand-offs

- **WS7 (Brain)**: consumes `Scene` via `service.getCurrentScene()` or
  `service.refreshScene("agent-turn")`. Sets `scene.vlm_scene` /
  `vlm_elements` after running the VLM. The scene-builder NEVER calls the
  VLM — that's WS7's responsibility.
- **WS8 (Android)**: implements `AccessibilityProvider` from
  `AccessibilityService` JNI and calls `setAccessibilityProvider(adapter)`
  during native init. The TS scene-builder will pick it up without code
  changes here.
- **WS10 (test matrix)**: can now fill in the **OCR row** (Linux Rapid via
  vision adapter), the **a11y row** (AT-SPI fixture + Wayland parsers), and
  the **app-enumeration row** (live `/proc` walk validated by
  `process-list.test.ts`).

## What ships vs what's stubbed

| Component                | Status on Linux host       |
| ------------------------ | -------------------------- |
| dHash + block grid       | Live, deterministic tests  |
| Process list             | Live (/proc), 8 tests      |
| Window list (X11)        | Live via existing wmctrl   |
| AT-SPI AX                | Live (python3-atspi)       |
| Wayland compositor IPC   | Parser tests only          |
| macOS AX (AppleScript)   | Parser path only           |
| Windows UIA              | Parser path only           |
| OCR adapter              | Chain in place, no provider registered by default |
| VLM hook                 | `onAgentTurn()` entry — WS7 fills `vlm_*` fields |

## Files

- `src/scene/scene-types.ts` — type contract
- `src/scene/scene-builder.ts` — pipeline + caches + subscribe
- `src/scene/dhash.ts` — pure dHash + block-grid diff
- `src/scene/apps.ts` — process+window join
- `src/scene/a11y-provider.ts` — AccessibilityProvider chain
- `src/scene/ocr-adapter.ts` — bridge to mobile/ocr-provider registry
- `src/scene/serialize.ts` — token-efficient prompt serializer
- `src/platform/process-list.ts` — cross-platform process enumeration
- `src/providers/scene.ts` — `scene` provider for the agent prompt
- `src/services/computer-use-service.ts` — `getCurrentScene` /
  `refreshScene` / `subscribeToSceneUpdates`
