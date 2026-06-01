# `@elizaos/app-core`

Shared application core for elizaOS agent app shells (desktop, mobile, web). It bundles the pieces every shell needs: the CLI bootstrap, the dashboard HTTP API, the Eliza runtime loader, the static app/plugin/connector registry, auth/secrets/vault services, and per-platform bootstrap.

## What's in here

| Subdir          | Contains                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- |
| `src/entry.ts`  | CLI process bootstrap (built to `dist/entry.js`, launched by the `eliza.mjs` wrapper).       |
| `src/cli/`      | Commander CLI: `start`, `setup`, `doctor`, `db`, `config`, `dashboard`, `update`, `auth`, …  |
| `src/api/`      | Dashboard HTTP API: server, auth/pairing routes, dev-stack discovery, secrets/wallet routes. |
| `src/runtime/`  | Eliza agent loader (`eliza.ts`), dev server, runtime-mode (local/remote), Electrobun desktop runtimes. |
| `src/registry/` | Static app/plugin/connector registry — JSON entries in `entries/`, validated by `schema.ts`. |
| `src/security/` | Agent vault id + platform secure stores + wallet key hydration.                              |
| `src/services/` | Auth store, steward credentials/sidecar, vault mirror/bootstrap, account pool, and more.     |
| `src/platform/` | Per-platform bootstrap (Capacitor for mobile, browser stubs, native plugin entrypoints).     |
| `src/config/`   | `AppConfig` types and `DEFAULT_APP_CONFIG` (re-exported from `@elizaos/shared`).              |

## Usage

```ts
// Node/runtime barrel
import { startApiServer, loadRegistry, getPlugins } from "@elizaos/app-core";

// Targeted subpaths (see package.json exports for the full list)
import { loadRegistry } from "@elizaos/app-core/registry";
import { ensureRouteAuthorized } from "@elizaos/app-core/api/auth";
import { ensureAgentVaultId } from "@elizaos/app-core/security/agent-vault-id";
```

The full subpath list lives in the `exports` map of `package.json`.

## Build & test

```bash
bun run --cwd packages/app-core build       # tsc → flatten → copy assets → rewrite dist ESM imports
bun run --cwd packages/app-core typecheck   # tsgo --noEmit
bun run --cwd packages/app-core test         # vitest
bun run --cwd packages/app-core lint         # Biome
```

This package is consumed by `@elizaos/agent`, `@elizaos/ui`, `@elizaos/shared`, the `packages/app` shell, and most `plugins/*` app plugins. It targets Node `>=24`, with `react`/`react-dom`/`three` as peer dependencies and the `@elizaos/capacitor-*` mobile bridges as optional dependencies.
