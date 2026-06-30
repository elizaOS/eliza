# #9581 — Windows non-disruptive mouse/keyboard effect screen recording

The capture harness proves Windows CUA input lands by reading the typed marker
back. This is the moving-picture companion: a real screen recording of CUA mouse
and keyboard input taking effect on a controlled Windows text-input window.

Captured on a real Windows 11 Pro host (QEMU), 1728x1052, via
`plugins/plugin-computeruse/scripts/record-windows-cua-input.mjs`:

1. launch a generated Windows Forms text target through computeruse
2. click inside the controlled text box bounds
3. progressively paste a marker with `Ctrl+V` while capturing frames
4. save with `Ctrl+S` and verify the marker from the real saved file/window

Frames are captured through the computeruse WinRT/.NET capture path and
assembled into MP4/GIF with ffmpeg.

| File | What it is |
|------|------------|
| `windows-cua-input.gif` | Inline recording of the run. |
| `windows-cua-input.mp4` | Same recording, H.264. |
| `final-typed-selected.png` | Final frame after verification; the typed marker is visible in the target. |
| `initial-empty-input-window.png` | Early frame before typing. |
| `windows-cua-input-target.txt` | The real text file saved by the `Ctrl+S` step. |
| `windows-cua-input-target.ps1` | The generated controlled Windows Forms target used for the run. |
| `recording-summary.json` | Run metadata, including `verified: true` and verification method. |

Verification method for this run: `saved-file`.
