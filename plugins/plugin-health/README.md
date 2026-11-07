# @elizaos/plugin-health

Health, sleep, circadian-regularity, and screen-time domain plugin for elizaOS.

## Host integration

Loading this plugin registers health connectors, anchors, activity signal
families, default packs, the health view, and typed health contracts. It does
not register `OWNER_HEALTH` or `OWNER_SCREENTIME` actions or their routes:
those require host-owned permissions and storage, and are currently provided by
`plugin-personal-assistant`. A host that loads only `plugin-health` will expose
the shared health domain but will not make those owner actions available.

Connector data also comes from the host. Configure and authorize a supported
provider through the host's connector setup; adding this package alone does
not request mobile permissions, connect an account, or import health records.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd plugins/plugin-health build  # build
bun run --cwd plugins/plugin-health test   # tests
```
