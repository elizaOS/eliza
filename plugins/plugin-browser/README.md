# @elizaos/plugin-browser

Adds browser automation through registered native Chromium profiles, the desktop
workspace, and configured hosted endpoints. Enable `features.browser` in host
configuration. The MV3 companion in `packages/browser-bridge-extension` controls
the same visible profile through an authenticated native messaging host on Linux
and the supported Chromium Desktop Android build. It supports background tabs and
complete DOM snapshots; selectors expire after effects and require fresh readback.

Native profiles are preferred before hosted browsers. Signed remote device grants
bind browser commands to one exact profile; older agent grants do not grant browser
access. A dispatched command is never replayed against a different session.
Android accessibility is a foreground-only fallback when the native profile is
unavailable before dispatch. Desktop workspace autofill requires prior per-domain
vault authorization and does not silently fill remote device profiles.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-browser build
bun run --cwd plugins/plugin-browser test
```
