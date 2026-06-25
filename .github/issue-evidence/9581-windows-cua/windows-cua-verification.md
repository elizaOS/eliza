# Windows on-device CUA × Vision verification (#9581)

Host: Windows 11 Pro (build box), interactive RDP session, primary display 1728×1052.
Driver/shell: PowerShell + WinRT. Date: 2026-06-25.

## Verified ✅
| Check | Method | Result |
|---|---|---|
| Screen capture | `System.Windows.Forms.Screen.PrimaryScreen` + `CopyFromScreen` (platform/screenshot.ts path) | real desktop PNG **1728×1052, 2.4 MB**, dims match display |
| Coord-OCR (controlled) | `Windows.Media.Ocr` WinRT (plugin-vision `WindowsMediaOcrService`) | **5/5 lines + every word bbox** exact: `ELIZA CUA VISION`, `Order #4815 Total: $11.34` ($11.34@239,84), `The quick brown fox`, `Settings File Edit View`, `Date: 2026-06-25` |
| Coord-OCR (real desktop) | same, on the live screenshot | **66 lines / 344 words**, each with bbox — read real UI: `Recycle Bin`@(8,60), `Microsoft Edge`@(12,159), `Docker`@(19,453), `+ New session`@(289,214), `Cowork`@(396,172), `Libelizainference pipeline review`@(311,365), taskbar `Mostly cloudy`@(50,1031). This is the grounding data the CUA agent clicks against. |
| Vision VLM describe | fused `libelizainference` ABI v13 `describe_image_stream` + eliza-1-0_8b + published mmproj | streamed token-by-token, accurate OCR-in-describe (verified under #9105) |
| Clipboard round-trip | `Set-Clipboard` / `Get-Clipboard -Raw` (platform/clipboard.ts) | wrote == read (match) |
| Displays | `listDisplays` / `isHeadless` | 1 display, `headless=false` |

`Windows.Media.Ocr` engine: **English (United States)**, 0 tokens, NPU-where-available.

## Findings / constraints ⚠️
1. **PowerShell spawn latency under bun ≈ 11.6 s on this box** (Defender real-time scan of each fresh `powershell.exe` 5.1). This exceeds the platform spawn timeouts (`clipboard.ts` `CLIPBOARD_TIMEOUT_MS=5s`, `capture.ts`/`screenshot.ts` `15s`), so driving these primitives through bun's `execSync`/`spawnSync` **flakes with `ETIMEDOUT`** on slow/Defender-heavy Windows hosts. The capabilities themselves work (verified via a warm PowerShell). **Recommendation:** raise these timeouts (or use a persistent PowerShell session / nutjs for capture+input) so Defender-heavy hosts don't false-fail.
2. **`listWindows()` returned 0 via the bun spawn path** even though the desktop is interactive (real windows visible in the capture) — likely the same spawn-timeout truncating the enumeration; worth a follow-up (clean re-verify once #1 is addressed).
3. **Input (mouse/keyboard) effect** not exercised here to avoid disrupting the live session; the documented Session-0/non-interactive gotcha (`docs/TEST_LANES_COMPUTERUSE_VISION.md`) still applies for service-session hosts.

## Net
The Windows **capture → coord-OCR → describe** CUA×Vision pipeline is **device-verified working** on Windows (read path). The robustness gap is the PowerShell-spawn timeout tuning for Defender-heavy hosts (#1), not the capability.
