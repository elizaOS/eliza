# @elizaos/shared

Shared contracts, configuration, utilities, and assets used by runtime hosts, UI, Cloud
services, and plugins.

Shared contracts, configuration, utilities, translations, catalog metadata, and assets.
Check package.json exports before importing a subpath. First-party catalog sources live
in src/catalog; use the catalog scripts rather than editing generated output.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/shared build  # build
bun run --cwd packages/shared test   # tests
```

Renderers use `@elizaos/shared/browser-contracts` and `/views/*` for browser-safe
values and view policies. The browser logger keeps canonical credential redaction;
Node consumers retain core class identities and the runtime diagnostic stream.
