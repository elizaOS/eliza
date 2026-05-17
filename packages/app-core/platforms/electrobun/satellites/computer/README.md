# Eliza Computer Satellite

`eliza.computer` is the desktop/system capability provider for screen, display, and host-context operations.

It does not replace semantic plugins:

- `plugin-computeruse` remains the agent-facing computer-use layer.
- `plugin-browser` remains the browser/task semantic layer.
- native screen, camera, canvas, and desktop plugins remain plugin-facing facades until their implementation paths are routed.

The Satellite provides a broker target for Electrobun host capabilities that should not live directly in plugins:

- `computer.status`
- `computer.permissions`
- `computer.displays`
- `computer.screenshot`

Screenshots are disabled by default. Enable them explicitly with:

```sh
ELIZA_COMPUTER_ENABLE_SCREENSHOT=1
```

Plugins should reach this Satellite through the shared capability router and `eliza.runtime`, not by importing Electrobun internals.
