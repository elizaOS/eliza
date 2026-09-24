# @elizaos/plugin-browser

Adds browser automation and companion bridge management to an Eliza agent.

Enable `features.browser` in host configuration. Browser automation needs a supported
browser/companion bridge or configured Stagehand endpoint (`STAGEHAND_SERVER_URL`).
Autofill requires prior per-domain vault authorization. Mobile support depends on the
selected bridge/backend.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-browser build  # build
bun run --cwd plugins/plugin-browser test   # tests
```
