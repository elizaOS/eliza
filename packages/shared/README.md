# @elizaos/shared

Shared cross-platform contract library for [elizaOS](https://github.com/elizaOS/eliza).

## What it is

`@elizaos/shared` is the lowest-level internal library in the elizaOS monorepo that can be safely imported by both server-side (Node.js/Bun) and browser/React code. It contains:

- **HTTP API contracts** — typed request/response shapes for every agent API route
- **Configuration schema** — `ElizaConfig` and 200+ sub-types covering agents, connectors, gateway, models, memory, TTS, auth, and more
- **Runtime environment resolution** — port and security config derived from env vars (`ELIZA_PORT`, `ELIZA_API_PORT`, `ELIZA_API_TOKEN`, etc.)
- **Eliza Cloud session helpers** — `syncStewardSession`, `exchangeStewardCode`, and the full Steward auth contract
- **Local-inference metadata** — model catalog (`MODEL_CATALOG`), Eliza-1 tier IDs, GPU profile matching, network policy, manifest signature verification, and voice model versioning
- **Brand tokens and assets** — canonical colors, font stacks, external URLs, and static brand assets for all elizaOS surfaces
- **Custom event constants** — typed `eliza:*` DOM event name constants used across app, bridge, and component layers
- **Shared utilities** — error formatting, rate limiter, streaming text, trajectory format, env parsing, and more

## Who uses it

Direct dependents: `@elizaos/agent`, `@elizaos/app-core`, `@elizaos/ui`, `@elizaos/app`, `@elizaos/cloud-api`, `@elizaos/cloud-frontend`, `@elizaos/os-homepage`, `@elizaos/browser-bridge-extension`, and `@elizaos/cloud-shared`.

## Installation

This package is part of the elizaOS monorepo and is consumed via workspace linking. It is also published to npm under the `alpha` dist-tag:

```bash
npm install @elizaos/shared@alpha
```

## Usage

```ts
// Root barrel — safe for server and browser
import { resolveRuntimePorts, ElizaConfig } from "@elizaos/shared";

// Sub-path imports for heavier modules
import { syncStewardSession } from "@elizaos/shared/steward-session-client";
import { MODEL_CATALOG, GPU_PROFILES } from "@elizaos/shared/local-inference";
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import "@elizaos/shared/brand.css";
```

## Key sub-path exports

| Import path | Contents |
|---|---|
| `@elizaos/shared` | Root barrel — all runtime-safe exports |
| `@elizaos/shared/steward-session-client` | Eliza Cloud auth session helpers |
| `@elizaos/shared/local-inference` | Model catalog, GPU profiles, inference types |
| `@elizaos/shared/brand` | Brand tokens, external URLs |
| `@elizaos/shared/brand.css` | CSS custom properties |
| `@elizaos/shared/brand-classic.css` | Eliza Classic CSS custom properties |
| `@elizaos/shared/character-presets` | Built-in character preset definitions |
| `@elizaos/shared/runtime-env` | Port and security config resolvers |
| `@elizaos/shared/config/allowed-hosts` | Allowed-hosts config helper |

## Building

```bash
bun run --cwd packages/shared build       # full build (i18n + dist)
bun run --cwd packages/shared typecheck   # type check only
bun run --cwd packages/shared test        # run tests
```

## Constraints

- The root barrel (`src/index.ts`) must remain importable in both browser and Node.js. Do not add Node.js-only or React-only imports to it.
- React-dependent modules (`boot-config-react.tsx`, `branding-react.tsx`) are intentionally excluded from the root barrel.
- Do not import from `@elizaos/agent` inside this package — it creates an ESM cycle that breaks server boot. See comments in `src/config/config.ts`.

