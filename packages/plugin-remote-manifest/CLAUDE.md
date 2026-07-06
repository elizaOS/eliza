# @elizaos/plugin-remote-manifest

Manifest schema, permissions, store, and wire envelope types for remote-mode elizaOS plugins.

## Purpose / role

This package is the single source of truth for the remote plugin protocol used across the elizaOS
desktop runtime. It defines the `plugin.json` manifest schema, the permission model (host + Bun
sandbox), the on-disk install store, the worker↔host wire message types, artifact signature
verification, RPC MAC helpers, host shims, the worker runtime bootstrap, and the reference
Claude Code sub-agent implementation. It is a shared library consumed by other packages.

Primary consumers (each declares a `workspace:*` dependency unless noted):
- `packages/agent` — `src/services/remote-plugin-bridge.ts`, `src/runtime/release-plugin-policy.ts`
- host shim subpaths — `./host-shim`, `./host-shim/web`, `./host-shim/ios`,
  `./host-shim/android`, `./host-shim/electrobun`
- worker-runtime subpaths — `./worker-runtime`, `./worker-runtime/bootstrap`,
  `./worker-runtime/error`, `./worker-runtime/runtime-proxy`
- `packages/plugin-worker-runtime` — compatibility wrapper package for the worker-runtime subpaths
- `packages/plugin-sub-agent-claude-code` — compatibility wrapper package for the Claude sub-agent subpaths
- `packages/app-core/platforms/electrobun` — desktop host, RPC schema, launch orchestrator, trace layer
- `packages/ui` — no package.json dep; path-mapped to `src/` in `tsconfig.json` for type resolution

## Layout

```
packages/plugin-remote-manifest/
  src/
    index.ts          — barrel re-export for the default "." entry point
    types.ts          — all wire envelopes, manifest interfaces, permission types, constants
    permissions.ts    — permission normalization, flatten, merge, parse helpers
    manifest.ts       — consent-request builder, permission diff util
    validation.ts     — validateRemotePluginManifest (parses plugin.json JSON safely)
    store.ts          — install store: read/write registry, install/uninstall, load, bootstrap
    signature.ts      — Ed25519 artifact verification (SOC2 A-1); verifyPluginArtifact
    rpc-mac.ts        — HMAC-SHA256 canonical encoding for WorkerRpcMessage (SOC2 A-4)
    json.ts           — isJsonObject guard (internal)
    host-shim/        — host shim entry points for web, iOS, Android, and Electrobun
    worker-runtime/   — worker bootstrap, runtime proxy, dispatch, envelope, error helpers
    sub-agent-claude-code/ — reference remote-mode Claude Code sub-agent
    *.test.ts         — co-located unit tests (run with `bun test src/`)
  examples/
    hello-remote-plugin/   — minimal background-mode reference plugin (plugin.json + worker.mjs)
    remote-plugin-clock/   — clock example
  sandbox/
    macos.sb / linux-bwrap.sh / SMOKE.md — Claude sub-agent sandbox assets
  scripts/
    sign-manifest.ts  — CLI: sign a plugin tarball with Ed25519 via KMS
```

## Export surface

The package exposes the barrel `.`, subsystem subpaths, and host-shim subpaths. Import the
specific subpath rather than the barrel when only one subsystem is needed.

| Import path | Key exports |
|---|---|
| `@elizaos/plugin-remote-manifest` | all of the below re-exported |
| `@elizaos/plugin-remote-manifest/types` | all interfaces and constants (`RemotePluginManifest`, `WorkerRpcMessage`, `HOST_PERMISSIONS`, `BUN_PERMISSIONS`, etc.) |
| `@elizaos/plugin-remote-manifest/permissions` | `normalizeRemotePluginPermissions`, `flattenRemotePluginPermissions`, `mergeRemotePluginPermissions`, `hasBunPermission`, `hasHostPermission`, `toBunWorkerPermissions`, `parseRemotePluginPermissionTag`, `isRemotePluginPermissionTag` |
| `@elizaos/plugin-remote-manifest/manifest` | `buildRemotePluginPermissionConsentRequest`, `diffRemotePluginPermissions`, `getRemotePluginManifestPermissionTags` |
| `@elizaos/plugin-remote-manifest/validation` | `validateRemotePluginManifest` — parses raw JSON into `RemotePluginManifest` or returns issues |
| `@elizaos/plugin-remote-manifest/store` | install store CRUD: `installPrebuiltRemotePlugin`, `uninstallInstalledRemotePlugin`, `loadInstalledRemotePlugins`, `readRemotePluginRegistry`, `writeRemotePluginRegistry`, `syncRemotePluginRegistry`, `buildRemotePluginRuntimeContext`, `writeRemotePluginWorkerBootstrap`, `getRemotePluginStorePaths`, `RemotePluginStoreError` |
| `@elizaos/plugin-remote-manifest/signature` | `verifyPluginArtifact`, `sha256File`, `PluginSignatureError`, `PLUGIN_MANIFEST_KEY` |
| `@elizaos/plugin-remote-manifest/rpc-mac` | `canonicalRpcBytes`, `pluginRpcKeyId`, `hexEncode`, `hexDecode` |
| `@elizaos/plugin-remote-manifest/host-shim` | shared host-shim registry and fallback helpers |
| `@elizaos/plugin-remote-manifest/host-shim/web` | browser host shim |
| `@elizaos/plugin-remote-manifest/host-shim/ios` | iOS host shim |
| `@elizaos/plugin-remote-manifest/host-shim/android` | Android host shim |
| `@elizaos/plugin-remote-manifest/host-shim/electrobun` | Electrobun desktop host shim |
| `@elizaos/plugin-remote-manifest/worker-runtime` | worker bootstrap, dispatch, channel, and runtime proxy exports |
| `@elizaos/plugin-remote-manifest/worker-runtime/bootstrap` | worker bootstrap entrypoint |
| `@elizaos/plugin-remote-manifest/worker-runtime/error` | wire error serialization helpers |
| `@elizaos/plugin-remote-manifest/worker-runtime/runtime-proxy` | worker-side runtime proxy |
| `@elizaos/plugin-remote-manifest/sub-agent-claude-code` | reference Claude Code sub-agent plugin descriptor |
| `@elizaos/plugin-remote-manifest/sub-agent-claude-code/worker` | reference Claude Code sub-agent worker entry |

### Core types

- `RemotePluginManifest` — shape of `plugin.json`; fields: `id`, `name`, `version`, `description`, `mode`, `permissions`, `view`, `worker`, optional `dependencies`/`remoteUIs`.
- `RemotePluginPermissionGrant` — `{ host?: Partial<Record<HostPermission, boolean>>; bun?: Partial<Record<BunPermission, boolean>>; isolation?: RemotePluginIsolation }`.
- `HOST_PERMISSIONS` — `windows | tray | notifications | storage | manage-remote-plugins`.
- `BUN_PERMISSIONS` — `read | write | env | run | ffi | addons | worker`.
- `REMOTE_PLUGIN_ISOLATIONS` — `shared-worker | isolated-process`.
- `RemotePluginWorkerMessage` — discriminated union of all worker↔host protocol messages.
- `PluginSurfaceKind` — `action | provider | service | model | event | route | evaluator | tests` — used in `WorkerRpcMessage.surface`.

## Commands

```bash
bun run --cwd packages/plugin-remote-manifest build        # tsc compile to dist/
bun run --cwd packages/plugin-remote-manifest typecheck    # type-check without emit
bun run --cwd packages/plugin-remote-manifest test        # bun test src/ (co-located *.test.ts)
bun run --cwd packages/plugin-remote-manifest lint        # biome check
bun run --cwd packages/plugin-remote-manifest lint:fix    # biome check --write
bun run --cwd packages/plugin-remote-manifest format      # biome format (dry)
bun run --cwd packages/plugin-remote-manifest format:fix  # biome format --write
bun run --cwd packages/plugin-remote-manifest clean       # rm -rf dist
```

Sign a plugin tarball (operator tool):
```bash
bun run packages/plugin-remote-manifest/scripts/sign-manifest.ts \
  --tarball ./my-plugin-1.2.3.tgz \
  [--signer ops@example.com] \
  [--out ./my-plugin-1.2.3.tgz.sig.json]
```

## Config / env vars

`scripts/sign-manifest.ts` reads:
- `ELIZA_KMS_BACKEND` — `memory | local | steward` (defaults to `local` for CLI use).
- `ELIZA_LOCAL_MODE` — `1` to force local KMS.

The package itself has no runtime config or env vars. It is a pure library.

## Security invariants

**SOC2 A-1 (artifact integrity):** `verifyPluginArtifact` in `src/signature.ts` must be called by
the install orchestrator BEFORE `installPrebuiltRemotePlugin`. The store layer is intentionally
sync and KMS-free; signature verification belongs in the caller. Key: `system:plugin-manifest/v1`
(`PLUGIN_MANIFEST_KEY`). Steps: (1) SHA-256 hash must match `signature.hash`; (2) Ed25519
signature over hash bytes must verify via `KmsClient.verify`.

**SOC2 A-4 (RPC integrity):** `WorkerRpcMessage.mac` is an HMAC-SHA256 hex string over the
canonical encoding `${requestId}\n${surface}\n${target}\n${stableJSON(args)}` keyed by a
per-install key (`pluginRpcKeyId(pluginId)` → `system:plugin-rpc-<sanitized-id>/v1`). Host
dispatchers check `requireMac` flag before invoking surfaces.

**Path-traversal guards:** `getRemotePluginStorePaths` and `resolveRemotePluginPathInside` both
reject paths that escape their respective roots. Plugin ids are validated by
`REMOTE_PLUGIN_ID_PATTERN` (`/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/`).

## How to extend

**Add a new HostPermission or BunPermission:**
1. Add the string literal to `HOST_PERMISSIONS` or `BUN_PERMISSIONS` in `src/types.ts`.
2. The derived type (`HostPermission` / `BunPermission`) and all permission-tag unions update
   automatically. No other changes needed in this package.

**Add a new wire message type:**
1. Define the interface in `src/types.ts`.
2. Add it to the `RemotePluginWorkerMessage` union in `src/types.ts`.
3. If the message flows through the RPC channel, add a surface handler in the consuming package
   (`packages/app-core/platforms/electrobun`).

**Add a new HostRequestMethod:**
Add the string literal to the `HostRequestMethod` union in `src/types.ts`.

**Add a new PluginSurfaceKind:**
Add the string literal to the `PluginSurfaceKind` union in `src/types.ts`. The host dispatcher
and worker bootstrap in `packages/app-core/platforms/electrobun` will need corresponding handling.

## Conventions / gotchas

- `plugin.json` id must match `REMOTE_PLUGIN_ID_PATTERN`. Dots are allowed (e.g. `com.example.myplugin`).
- `store.ts` is fully synchronous (Node fs). Do not add async fs calls; async belongs in the
  consuming install orchestrator.
- `normalizeRemotePluginPermissions` accepts both the legacy `LegacyRemotePluginPermission[]`
  array format and the current `RemotePluginPermissionGrant` object. All internal helpers call
  normalize first; pass either form.
- `writeRemotePluginWorkerBootstrap` writes a `.bunny/plugin-bun-entrypoint.mjs` bootstrap file
  inside the plugin's `currentDir`. The bootstrap injects `globalThis.__remotePluginBootstrap` and
  then dynamically imports the worker bundle.
- The package is `"private": true` — it is not published to npm independently. It is consumed via
  `workspace:*` within the monorepo.
- Build target is ESM only (`"type": "module"`). No CJS output.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root AGENTS.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[AGENTS.md](../../AGENTS.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
