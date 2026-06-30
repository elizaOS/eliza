# #9581 — Windows non-disruptive mouse/keyboard *effect* screen recording

The capture harness (`capture-windows-desktop-evidence.mjs`) proves Windows CUA
input lands by reading the typed marker back through the clipboard. This is the
moving-picture companion the issue's remaining item asks for — a real screen
**recording** of CUA mouse + keyboard input taking effect on a controlled,
maximized Notepad window.

Captured on a real Windows 11 Pro host (QEMU), 1728×1052, via
`plugins/plugin-computeruse/scripts/record-windows-cua-input.mjs`:

1. launch `notepad.exe` → resolve the real window → **maximize**
2. `mouse_move` → `click` into the text area (focuses the window)
3. progressive, chunked `type` of a marker phrase (frame captured after each chunk)
4. `ctrl+a` to select, then verify by `ctrl+c` + clipboard read-back

`gdigrab` is blocked in this session (BitBlt access), so frames are captured
through the computeruse capture path (WinRT/.NET `CopyFromScreen`) and assembled
into the video with ffmpeg.

| File | What it is |
|------|------------|
| `windows-cua-input.gif` | The recording (renders inline on the issue). |
| `windows-cua-input.mp4` | Same recording, H.264. |
| `final-typed-selected.png` | Last frame — the marker phrase typed into Notepad and selected (`ctrl+a`), status bar shows "113 of 113 characters". |
| `initial-empty-notepad.png` | An early frame — the maximized Notepad before/while typing. |
| `recording-summary.json` | The run: 13 frames, `verified: true`, the marker read back from Notepad. |

**Note on fidelity:** the legacy PowerShell/user32 input driver (used when the
nutjs driver is unavailable) lower-cases letters and drops some symbol keys, so
the visible phrase reads `elizaOS cua on windows -- 9581 …` rather than the
exact mixed-case input. The lowercase-+-digits **marker** (`eliza-win-cua-<ts>`)
round-trips exactly and is what the read-back verifies — input demonstrably
reaches the window. Notepad's session-restore may also show a leftover line from
a prior run above the typed phrase.

Regenerate: `bun run --cwd plugins/plugin-computeruse scripts/record-windows-cua-input.mjs`
(requires a *connected*/console-attached desktop session; a disconnected RDP
session has no capturable surface — reattach with `tscon <id> /dest:console`).
