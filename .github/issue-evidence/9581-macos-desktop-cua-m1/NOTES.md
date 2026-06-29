# Issue #9581 — macOS desktop CUA on Apple **M1** (cross-hardware verification)

Captured on Apple **M1 Pro** (`MacBookPro18,3`, macOS `26.4.1` build `25E253`),
2026-06-29. This complements the existing **M4 Max** evidence in
`../9581-macos-desktop-cua/` — it proves the computer-use × vision stack drives a
real macOS desktop on the **base M-series** silicon, not just the top-end part.

```bash
bun run --cwd plugins/plugin-computeruse capture:macos-desktop-evidence -- \
  --out ../../.github/issue-evidence/9581-macos-desktop-cua-m1
bun run --cwd plugins/plugin-computeruse validate:platform-evidence -- \
  ../../.github/issue-evidence/9581-macos-desktop-cua-m1/macos-desktop-validation.json --require-complete
# → [macos-desktop-evidence] 9 checks validated (passed)
```

## Result: 9/9 — `status: passed`

| check | status | what it proves on M1 |
| --- | --- | --- |
| capabilityProbe | passed | darwin capability probe matches service |
| screenRecordingPermission | passed | Screen Recording (TCC) granted |
| screenshotCapture | passed | real non-blank primary-display capture, dims verified |
| **accessibilityPermission** | **passed** | `AXIsProcessTrusted` true after granting Terminal |
| **mouseKeyboardInput** | **passed** | real input drove a controlled TextEdit window |
| **windowListFocus** | **passed** | `listWindows` + `focusWindow` work via the Swift CGWindowList path |
| browserAutomation | passed | CDP browser automation screenshot |
| clipboardRoundTrip | passed | pbcopy/pbpaste round-trip |
| approvalMode | passed | approval-mode file-write gate |

### Real input (`mouseKeyboardInput`)
The agent drove a controlled TextEdit document — verbatim from `report.json`:
- `mouse_move succeeded at 648,520 on display 0`
- `click succeeded on a controlled TextEdit document`
- `key_combo cmd+a succeeded in the controlled text field`
- `type wrote and verified marker macos-cua-1782719836813` (typed text read back
  from the accessibility tree — exactly what a CUA agent observes on screen)

### Window listing / focus (`windowListFocus`)
- `listWindows returned 11 visible window(s)`
- `focusWindow/switchWindow succeeded for Google Chrome:Main by lalalune · Pull Request #10089 · elizaOS/eliza`

This confirms the macOS window-listing fix (`platform/windows-list.ts`:
`CGWindowListCopyWindowInfo` via Swift, with the two-pass System-Events fallback)
works on M1 — the same fix that took the M4 Max from 6/9 to 9/9.

## TCC note (the only manual step)
On a fresh host the input + window-list + accessibility checks are gated on a
**one-time Accessibility (TCC) grant** for the controlling terminal app
(here, `Terminal.app`; the session was inside `tmux`). Once granted, no
tmux/Terminal restart was needed — each fresh `osascript`/`cliclick`/`bun`
child process picks up the grant at runtime. `AXIsProcessTrusted` flipped to
`true` and the run went straight to 9/9. This is the documented gate, not a code
defect.

## Artifacts
- `macos-desktop-validation.json` / `manifest.json` — validated 9/9 manifest.
- `report.json` — full per-check report (host = `MacBookPro18,3`, arm64, bun 1.4.0).
- `browser-evidence.png` — CDP browser-automation screenshot (safe `data:` page).
- `approval-full-control.txt` — approval-mode file-write proof.
- **`screenshot-primary.png` intentionally withheld.** The primary-display
  capture was taken and verified during the run (see the `screenshotCapture`
  evidence strings in `report.json`), but the full-desktop image of this
  personal machine is **not committed** for privacy. Regenerate it locally with
  the capture command above if a reviewer needs to eyeball it.
