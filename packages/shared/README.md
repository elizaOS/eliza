# @elizaos/shared

Shared contracts, configuration, utilities, and brand assets used by the agent,
application hosts, UI, Cloud services, and plugins. This workspace depends on
`@elizaos/core` and `@elizaos/registry`; it is not an independent foundation below
them.

## Entry points

The [package manifest](package.json) defines the public exports. Choose the entry
that matches the consumer's runtime:

- The root barrel combines contracts with runtime helpers, including Node-only
  Cloud TTS helpers. Browser use depends on the host's bundler configuration; it
  is not proof that every root export is browser-safe.
- `@elizaos/shared/brand` owns shared brand constants; `@elizaos/shared/brand.css`
  exposes the stylesheet.
- `@elizaos/shared/local-inference` exposes model metadata and cross-platform
  policies. Filesystem verification and routing persistence use the separate
  `/local-inference/verify` and `/local-inference/routing-preferences` exports.
- `@elizaos/shared/steward-session-client` owns browser session synchronization.
  Refresh credentials use the HttpOnly cookie; clearing legacy local storage
  does not make it an active credential source.

```ts
import type { ElizaConfig } from "@elizaos/shared";
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import { syncStewardSession } from "@elizaos/shared/steward-session-client";
```

## Development

From the repository root:

```bash
bun run --cwd packages/shared build
bun run --cwd packages/shared typecheck
bun run --cwd packages/shared lint:check
bun run --cwd packages/shared test
```

Build and typecheck regenerate keyword data from `src/i18n/keywords/`. Edit those
inputs, not `src/i18n/generated/`. Brand assets live in `assets/`; the `sync`
script copies them into consumer public directories.

See [CLAUDE.md](CLAUDE.md) for ownership and contribution details.
