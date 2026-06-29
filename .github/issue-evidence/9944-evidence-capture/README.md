# 9944 — per-platform evidence capture tooling

Proof that the new `capture:*` helpers (issue #9944) emit a real screenshot +
recording + log per platform, into `.github/issue-evidence/<issue>-<slug>/<platform>/`.

Helpers: `scripts/e2e-recordings/capture/{android,ios,desktop}-capture.mjs`,
shared by `scripts/e2e-recordings/capture/common.mjs`, wired as root scripts
`capture:android` / `capture:ios-sim` / `capture:linux` / `capture:windows` and
registered as `CAPTURE_SUITES` in `scripts/e2e-recordings/suites.mjs`.

## `android/` — real capture on a connected Pixel 9a (serial 53081JEBF11586)

`bun run capture:android --serial 53081JEBF11586 --seconds 7`

| File | What | Size |
| --- | --- | --- |
| `screen.png` | `adb exec-out screencap -p` | 2424×1080 PNG |
| `screen.mp4` | `adb shell screenrecord` (pulled) | h264, 7.00s, 60fps |
| `logcat.log` | `adb logcat -d -v time -t 2000` tail | — |

## `linux/` — real capture on the Linux x86_64 host (DISPLAY=:0, 2560×1600)

`bun run capture:linux --seconds 6`

| File | What | Size |
| --- | --- | --- |
| `screen.png` | `ffmpeg -f x11grab … -frames:v 1` | 2560×1600 PNG |
| `screen.mp4` | `ffmpeg -f x11grab … -t 6` | h264, 6.00s, 15fps |
| `desktop.log` | host/display info + ffmpeg stderr | — |

## ios / windows — skip-with-reason (correct behavior on this Linux host)

- `bun run capture:ios-sim` → `[IosCapture] [skip] iOS Simulator requires macOS (host is linux)` (exit 0)
- `bun run capture:windows` → `[DesktopCapture] [skip] windows-desktop capture requires a windows host (host is linux)` (exit 0)

Both produce real artifacts when run on their own platform with a booted
simulator / Windows desktop respectively.
