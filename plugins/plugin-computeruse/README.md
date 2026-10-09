# @elizaos/plugin-computeruse

Desktop automation for elizaOS agents — screenshots, mouse/keyboard control, browser CDP
automation, window management, and a multi-display scene model.

Native capture and input require OS permission. macOS uses Screen
Recording/Accessibility permissions and the packaged AX helper; Linux X11 requires
capture/input utilities such as scrot and xdotool. Browser control needs a supported
Chromium browser. Keep physical-pointer effects behind session policy and approval.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-computeruse build  # build
bun run --cwd plugins/plugin-computeruse test   # tests
```
