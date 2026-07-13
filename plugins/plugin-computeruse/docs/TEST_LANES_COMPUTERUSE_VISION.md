# Test lanes — computeruse × vision (per-OS)

How the `@elizaos/plugin-computeruse` + `@elizaos/plugin-vision` test surface is
organized across the unit lane and the real-driver lane, what runs where, the
per-OS host requirements, and the **Windows non-interactive-session gotcha** that
makes input-effect tests fail outside a logged-in desktop. Companion to the
CUA × Vision EPIC (#9105) and the trycua/cua parity tracker (#9170).

## Lanes at a glance

| Lane | Selects | Runs the real OS? | Command |
|------|---------|-------------------|---------|
| **Unit / component** | every `*.test.ts` **except** `*.real`/`*.live`/`*.e2e` | No (mocked) — but platform-gated `*.test.ts` self-skip on the wrong OS | `bun run --cwd plugins/plugin-computeruse test` · `bun run --cwd plugins/plugin-vision test` |
| **Real-driver / live** | `*.real.test.ts` / `*.live.test.ts` (repo-wide) | **Yes** — nutjs / PowerShell / WinRT / Apple Vision / xdotool against the host | shared config `packages/test/vitest/real.config.ts` (post-merge lane via `packages/scripts/run-all-tests.mjs`) |
| **Standalone probe** | a hand-written `.mts` importing `src/platform/*.js` | **Yes** — fastest Windows real smoke | `bun plugins/plugin-computeruse/<probe>.mts` |

### Unit lane

Each plugin's `vitest.config.ts` **excludes** `**/*.real.test.{ts,tsx}`,
`**/*.live.test.{ts,tsx}`, and `**/*.e2e.*`. So `bun run --cwd plugins/plugin-computeruse test`
never touches the real OS.

Platform-specific behavior that *can* be exercised without a real desktop still
lives in the unit lane as a regular `*.test.ts` gated with
`it.skipIf(platform() !== "win32")(...)`. These **run on Windows in the normal
lane** and self-skip elsewhere. Examples:

- `plugin-vision/src/ocr-service-windows.test.ts` — renders a PNG and OCRs it
  through the real **`Windows.Media.Ocr`** WinRT engine (works headless).
- `plugin-computeruse/src/__tests__/cua-parity-surface.test.ts` — Windows
  clipboard-write command regression (`Set-Clipboard -Value
  [Console]::In.ReadToEnd()`, not `$input | Set-Clipboard`).

### Real-driver / live lane

`*.real.test.ts` files are **only** picked up by the shared real config
`packages/test/vitest/real.config.ts` (include globs `**/*.real.test.ts`,
`**/*.live.test.ts`). They drive the real input/capture/OCR stack. A
`fail-on-silent-skip` setup (`packages/test/vitest/fail-on-silent-skip.setup.ts`)
**fails any test that silently skips**, so a `.real` test must either run or be
explicitly excluded — it cannot quietly no-op.

Run a single real test against the host (the lane's include globs are repo-wide,
so pass a file path to scope it):

```bash
bunx vitest run plugins/plugin-computeruse/src/__tests__/cua-parity-input.real.test.ts \
  --config packages/test/vitest/real.config.ts
```

The service-level lane captures the display and moves the pointer, then reads
the OS cursor position back to prove the driver effect. Run it only on an
isolated interactive desktop and acknowledge those effects explicitly. A direct
invocation without the acknowledgment fails before the suite starts:

```bash
COMPUTER_USE_REAL_DESKTOP_TESTS=1 bunx vitest run \
  plugins/plugin-computeruse/src/__tests__/service.real.test.ts \
  --config packages/test/vitest/real.config.ts
```

`ELIZA_CI_REAL=1` additionally drops credential/upstream-gated reals
(e.g. `computeruse.real.test.ts`, whose headless-browser path needs a display).

### Standalone probe (proven Windows smoke)

For a fast Windows real-driver check, a standalone `.mts` that imports the
platform modules directly and is run with `bun` beats the vitest real lane
(no config graph, instant feedback). Pattern:

```ts
// parity-probe.mts — bun plugins/plugin-computeruse/parity-probe.mts
import { legacyGetCursorPosition } from "./src/platform/desktop.js";
import { readClipboard, writeClipboard } from "./src/platform/clipboard.js";
console.log(legacyGetCursorPosition());          // live WinForms read
await writeClipboard("hi"); console.log(await readClipboard());
```

Keep probes out of commits (delete after use) — they are smoke checks, not the
suite.

## Input driver selection

`ELIZA_COMPUTERUSE_DRIVER` selects the input backend:

- `nutjs` (default) — `@nut-tree-fork/nut-js` native bindings.
- `legacy` — per-OS shell tools: PowerShell (Windows), `cliclick` (macOS),
  `xdotool` (Linux).

nutjs auto-falls-back to `legacy` when the native module fails to load. Note the
read path is asymmetric on Windows: `driverGetCursorPosition` always uses the
WinForms OS query on Windows because nutjs `mouse.getPosition()` returns a stale
constant there (see #9165).

## Per-OS host requirements

| OS | Capture | Input | OCR | Notes |
|----|---------|-------|-----|-------|
| **Windows** | PowerShell / nutjs | nutjs (SendInput) or legacy PowerShell | **`Windows.Media.Ocr`** (WinRT via `powershell` 5.1, **not** pwsh 7) — 0 tokens | **Input needs an interactive desktop** (see gotcha). Read/clipboard/OCR work headless. |
| **macOS** | `screencapture -D` (retina 2× backing store) | nutjs or `cliclick` | Apple Vision | Needs Accessibility + Screen Recording grants; headful. |
| **Linux** | X11 `import`/`scrot` (Xvfb headful); Wayland `xdg-desktop-portal` screenshot sidecar | nutjs or `xdotool` on X11 | docTR / PaddleOCR | Wayland capture uses `python3` + `gdbus`; Wayland still lacks AT-SPI in many compositors, so grounding can be OCR-only. Clipboard needs `wl-clipboard`/`xclip`. |
| **AOSP** | MediaProjection | privileged input bridge | Paddle-Lite | Emulator + system-app path. See `AOSP_SYSTEM_APP.md`. |

## ⚠️ Windows non-interactive-session gotcha (verified 2026-06-23)

In a **Session-0 / RDP-disconnected / service** Windows session, programmatic
cursor **movement and button/key presses are silent no-ops**, while reads,
clipboard, and OCR work. Verified directly on the Windows backend:

| Operation | Non-interactive session |
|-----------|-------------------------|
| `legacyGetCursorPosition()` (WinForms read) | ✅ live, accurate |
| nutjs `mouse.setPosition` / `mouse.move` | ❌ no-op (cursor unchanged) |
| PowerShell `SetCursorPos` | ❌ no-op |
| nutjs `pressButton`/`releaseButton`, `pressKey`/`releaseKey` (SendInput) | ❌ no-op (no foreground desktop to receive input) |
| clipboard read/write round-trip | ✅ works headless |
| `Windows.Media.Ocr` (rendered PNG → text + word boxes) | ✅ works headless |

**Consequence for the real lane:** any `*.real.test.ts` that asserts an *input
effect* — e.g. `cua-parity-input.real.test.ts`'s `move → get_cursor_position`
round-trip — will **fail** (not skip) on a non-interactive Windows runner. Run
against this backend it produces:

```
× get_cursor_position reflects driverMouseMove
  AssertionError: expected 388 to be less than or equal to 2   # cursor never moved
✓ clipboard write/read round-trips
```

This is an **environment** failure, not a code defect. The Windows real-driver
CI lane therefore MUST run on an **interactive, logged-in desktop** (autologon +
unlocked session; the agent on a real desktop), not as a service / in Session 0.
Read-only reals (cursor read, clipboard, OCR) are safe headless and can run on
any Windows runner.

## What is validated on Windows today

Confirmed working on the Windows backend (2026-06-23):

- **Cursor read** — `driverGetCursorPosition` returns the live position (WinForms).
- **Clipboard** — read/write round-trips a newline/unicode/quote payload
  (the `Set-Clipboard -Value [Console]::In.ReadToEnd()` fix; #9165).
- **OCR** — native `Windows.Media.Ocr` extracts rendered text with per-word boxes
  (`ocr-service-windows.test.ts`, 5/5; #9121 M4a, wired to `COMPUTER_USE ocr` /
  `detect_elements` via #9173 M7).

Input-effect verification (move/click/drag/press fidelity, DPI, multi-monitor)
requires an interactive Windows desktop and is gated to that lane.

## Release evidence

Per-OS evidence manifests live next to this doc
(`windows-desktop-validation.json`, `macos-desktop-validation.json`,
`linux-desktop-validation.json`, `android-*-validation.json`,
`ios-device-validation.json`) and are checked by
`bun run --cwd plugins/plugin-computeruse validate:<os>-desktop-evidence`.
Keep incomplete live-device checks under `requires_device_evidence`; only use
`validate:platform-evidence -- --require-complete` for release gates that truly
have artifacts for every required platform check.
