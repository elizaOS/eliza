# Issue #9581 — macOS desktop CUA on-device evidence

Real on-device computer-use verification captured with
`bun run --cwd plugins/plugin-computeruse capture:macos-desktop-evidence` on an
Apple **M4 Max** (`Mac16,5`, macOS **26.2** build `25C56`), 2026-06-25.

## Result: 6/9 checks PASS on real hardware; 3 gated on Accessibility (TCC)

| check | status | note |
| --- | --- | --- |
| `capabilityProbe` | ✅ passed | darwin capabilities reported |
| `screenRecordingPermission` | ✅ passed | Screen Recording granted; capture allowed |
| `screenshotCapture` | ✅ passed | primary display PNG captured at backing-store res (artifact withheld — it is the live desktop) |
| `browserAutomation` | ✅ passed | open/get-dom/get-clickables/screenshot/close — see `browser-evidence.png` |
| `clipboardRoundTrip` | ✅ passed | pbcopy/pbpaste round-trip, original restored |
| `approvalMode` | ✅ passed | smart_approve / full_control / approve_all / off policy verified |
| `accessibilityPermission` | ⛔ requires device | terminal/runner not in Accessibility allowlist |
| `mouseKeyboardInput` | ⛔ requires device | blocked by the same Accessibility (TCC) gate |
| `windowListFocus` | ⛔ requires device | list_windows returns placeholder metadata without Accessibility |

The 3 ⛔ checks are **not code failures** — they are blocked by an ungranted host
permission. To complete them, grant the runner Accessibility access in
**System Settings → Privacy & Security → Accessibility**, then re-run the capture;
the harness flips them to `passed` automatically.

## Privacy

The full-desktop `screenshot-primary.png` is intentionally **not committed** (it
is a live capture of the user's screen). Its capture is still proven: the
`screenshotCapture` check records the real byte count + dimensions. The committed
`browser-evidence.png` is a controlled `data:` URL page, safe to publish.

## Artifacts

- `macos-desktop-validation.json` / `manifest.json` — the validated manifest.
- `report.json` — full per-check report (screenshot base64 stripped).
- `browser-evidence.png` — CDP browser-automation screenshot.
- `approval-full-control.txt` — approval-mode file-write proof.

## Validate

```bash
bun run --cwd plugins/plugin-computeruse validate:macos-desktop-evidence
```
