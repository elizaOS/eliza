# Chrome Browser Extension Package

Chrome Manifest V3 implementation of the browser-extension example.

## Build And Load

```bash
cd packages/examples/browser-extension/chrome
bun install
bun run test
bun run typecheck
```

The default `build` script is intentionally a documented skip because the
current tsup config bundles Node-only workspace dependencies into a browser
target. Use `bun run build:tsup` only when working on that bundling issue.

The local smoke test checks Manifest V3 surfaces, permissions, background chat streaming, and content extraction wiring.

To test manually, open `chrome://extensions`, enable Developer mode, choose
`Load unpacked`, and select `packages/examples/browser-extension/chrome`.

See [`../README.md`](../README.md) for provider setup and cross-browser notes.
