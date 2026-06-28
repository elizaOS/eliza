# Issue #9581 — macOS desktop CUA: full on-device input coverage (9/9)

Captured on Apple **M4 Max** (`Mac16,5`, macOS `26.2` build `25C56`), 2026-06-26.

```bash
bun run --cwd plugins/plugin-computeruse capture:macos-desktop-evidence
bun run --cwd plugins/plugin-computeruse validate:platform-evidence -- \
  ../../.github/issue-evidence/9581-macos-desktop-cua/macos-desktop-validation.json --require-complete
# → [macos-desktop-evidence] 9 checks validated (passed)
```

## Result: 9/9 — `status: passed`

| check | status |
| --- | --- |
| capabilityProbe | passed |
| screenRecordingPermission | passed |
| screenshotCapture | passed |
| **accessibilityPermission** | **passed** |
| **mouseKeyboardInput** | **passed** |
| **windowListFocus** | **passed** |
| browserAutomation | passed |
| clipboardRoundTrip | passed |
| approvalMode | passed |

The three bolded checks were previously `requires_device_evidence`. They were
**not** actually blocked on an ungranted permission — Accessibility was granted
the whole time (`AXIsProcessTrusted` / System Events `UI elements enabled` =
`true`). They were blocked by two real macOS bugs in the plugin, fixed in this
change.

## Root-cause fixes (`plugins/plugin-computeruse/src/platform/windows-list.ts`)

1. **macOS window listing was 100% broken.** `listWindowsDarwin` and
   `getActiveWindow` read `(id of w as text)`, but System Events `window`
   elements have **no `id` property** — that throws `-1728`/`-1700` for every
   window, the surrounding `try` swallowed it, and `listWindows()` returned `[]`
   on every macOS host. Window targeting (`get_window_position`,
   `switch_to_window`, …) therefore failed with "Window not found", which the
   evidence harness mis-attributed to a missing Accessibility permission.
   - Fix: enumerate via `CGWindowListCopyWindowInfo` (Swift, ~0.5s incl. compile,
     needs only Screen Recording for titles) with a System Events fallback for
     hosts without the Swift toolchain. Windows are identified by their title
     scoped to the owning app — the only term the process-level AppleScript
     targeting can actually act on.

2. **`runDarwinWindowScript` timed out and was mis-classified.** It walked
   `every window of` **every non-matching process** through the System Events
   accessibility tree before reaching the target. On a busy desktop that blew
   past the 5s `osascript` timeout; the `ETIMEDOUT` string matches the
   accessibility-error classifier, so a slow walk surfaced as a bogus
   "Accessibility denied".
   - Fix: two-pass match — process name first (fast, no AX walk), window title
     only as a fallback — and a more generous timeout for the rare fallback.

## Harness robustness (`scripts/capture-macos-desktop-evidence.mjs`)

Directly after synthetic keyboard input, TextEdit's **application** Apple Event
dispatch (`tell application "TextEdit" to get text of front document`) is
transiently blocked and hangs to its timeout. The input itself works — the typed
text is present immediately in the **accessibility tree**. The input proof now
reads the text area's AX `value` (exactly what a computer-use agent observes on
screen), with the document read kept only as a fallback, and the cleanup close
retries past the same transient block so runs don't leak stale windows.

## Artifacts

- `macos-desktop-validation.json` / `manifest.json` — validated 9/9 manifest.
- `report.json` — full per-check report.
- `input-proof.mp4` — screen recording of the agent driving a controlled
  TextEdit window: `mouse_move → click → key_combo(cmd+a) → type`, AX-verified.
- `input-proof.png` — still of the typed result.
- `screenshot-primary.png` — primary-display capture (full-desktop; sensitive,
  issue-evidence only).
- `browser-evidence.png` — CDP browser-automation screenshot (safe `data:` page).
- `approval-full-control.txt` — approval-mode file-write proof.
