# Package Exports Follow-up Audit

Date: 2026-05-12

Scope: read-only inspection of package export/import boundaries across `packages/`, `plugins/`, `cloud/`, client apps, and build/typecheck aliases. This report intentionally proposes edits only; no source files were changed.

## Commands run

- `rg --files -g 'package.json' ...`
- custom Node manifest scanner for ordered `exports` conditions, wildcard exports, source exports, and `.d.ts` exports under source/generated paths
- `node scripts/audit-package-barrels.mjs`
- `bun run audit:package-barrels:check` (exits 1 on current repo state)
- targeted `rg` scans for package subpath imports, `src/generated`, `dist/src`, `src/dist`, shims, and tsconfig path aliases

## Summary

| Area | Result | Risk | Recommendation |
| --- | ---: | --- | --- |
| `exports` condition order | 117 manifests have at least one conditional object with `default` before `types` | Build/publish warnings; some tooling may stop before reading `types` | Normalize every export object to put `types` before runtime conditions |
| Wildcard package exports | 117 manifests expose broad `./*` and usually `./*.css` | Leaks internals as public API; makes dead-code cleanup unsafe | Replace wildcard exports with explicit owned public subpaths, then remove `./*` |
| Published subpath exports | 275 exported package subpaths vs 41 observed workspace subpath references | Export surface is much larger than actual usage | Collapse to root barrels or explicit allowlist |
| Source/generated declarations | `packages/agent`, `plugins/plugin-sql`, `plugins/plugin-whatsapp`, `plugins/plugin-discord-local`, `packages/prompts`, `plugins/app-wallet`, `plugins/plugin-aosp-local-inference` expose source-ish paths | Consumers compile against repo layout, generated declarations, or nested build output | Publish from stable `dist` layout only; keep source aliases private to local dev |
| Tsconfig path leakage | Root, app, app-core, electrobun, scenario-runner, and cloud configs map package names to other packages' `src` internals | Typecheck passes while package boundaries are invalid | Move to package exports/dist paths for build configs; keep source aliases only in dev-only configs |

## P0: Condition order warnings

Finding: the current warning class is broad and mechanical. In each affected manifest, at least one export object contains both `default` and `types`, with `types` appearing after `default`. The most common offender is:

```json
"./*": {
  "import": "./dist/*.js",
  "default": "./dist/*.js",
  "types": "./dist/*.d.ts"
}
```

Risk: modern package tooling treats condition object order as significant. If `default` is visited before `types`, type metadata can be ignored or warnings can become publish failures.

Recommended edit:

1. Change all conditional export objects to `types`, then environment/runtime conditions (`browser`, `node`, `bun`), then `import`, then `default`.
2. Update any manifest generation script that preserves old object order so regenerated manifests stay clean. `scripts/prepare-package-dist.mjs` already emits `types` first for string exports, but preserves object key order for existing objects.
3. Add a CI scanner that fails if any `exports` object has `types` after `default` or `import`.

Validation:

- `bun run build`
- `bun run typecheck`
- `bun run lint:check`
- `node scripts/audit-package-barrels.mjs --check`
- custom export-order scanner, or add it as `bun run audit:package-exports:check`

Exact manifests affected:

```text
packages/agent/package.json
packages/cloud-routing/package.json
packages/core/package.json
packages/prompts/package.json
packages/scenario-runner/package.json
packages/scenario-schema/package.json
packages/shared/package.json
packages/skills/package.json
packages/ui/package.json
packages/vault/package.json
packages/workflows/package.json
plugins/app-2004scape/package.json
plugins/app-babylon/package.json
plugins/app-clawville/package.json
plugins/app-companion/package.json
plugins/app-contacts/package.json
plugins/app-defense-of-the-agents/package.json
plugins/app-device-settings/package.json
plugins/app-documents/package.json
plugins/app-elizamaker/package.json
plugins/app-hyperliquid/package.json
plugins/app-hyperscape/package.json
plugins/app-lifeops/package.json
plugins/app-messages/package.json
plugins/app-phone/package.json
plugins/app-polymarket/package.json
plugins/app-scape/package.json
plugins/app-screenshare/package.json
plugins/app-shopify/package.json
plugins/app-steward/package.json
plugins/app-task-coordinator/package.json
plugins/app-training/package.json
plugins/app-trajectory-logger/package.json
plugins/app-vincent/package.json
plugins/app-wallet/package.json
plugins/app-wifi/package.json
plugins/plugin-agent-orchestrator/package.json
plugins/plugin-agent-skills/package.json
plugins/plugin-anthropic/package.json
plugins/plugin-aosp-local-inference/package.json
plugins/plugin-app-control/package.json
plugins/plugin-background-runner/package.json
plugins/plugin-bluebubbles/package.json
plugins/plugin-bluesky/package.json
plugins/plugin-browser/package.json
plugins/plugin-calendly/package.json
plugins/plugin-capacitor-bridge/package.json
plugins/plugin-cli/package.json
plugins/plugin-codex-cli/package.json
plugins/plugin-coding-tools/package.json
plugins/plugin-commands/package.json
plugins/plugin-computeruse/package.json
plugins/plugin-discord-local/package.json
plugins/plugin-discord/package.json
plugins/plugin-edge-tts/package.json
plugins/plugin-elevenlabs/package.json
plugins/plugin-eliza-classic/package.json
plugins/plugin-elizacloud/package.json
plugins/plugin-farcaster/package.json
plugins/plugin-feishu/package.json
plugins/plugin-form/package.json
plugins/plugin-github/package.json
plugins/plugin-google-chat/package.json
plugins/plugin-google-genai/package.json
plugins/plugin-google/package.json
plugins/plugin-groq/package.json
plugins/plugin-health/package.json
plugins/plugin-imessage/package.json
plugins/plugin-inmemorydb/package.json
plugins/plugin-instagram/package.json
plugins/plugin-line/package.json
plugins/plugin-linear/package.json
plugins/plugin-lmstudio/package.json
plugins/plugin-local-ai/package.json
plugins/plugin-local-embedding/package.json
plugins/plugin-local-inference/package.json
plugins/plugin-local-storage/package.json
plugins/plugin-localdb/package.json
plugins/plugin-matrix/package.json
plugins/plugin-mcp/package.json
plugins/plugin-minecraft/package.json
plugins/plugin-mlx/package.json
plugins/plugin-music/package.json
plugins/plugin-mysticism/package.json
plugins/plugin-ngrok/package.json
plugins/plugin-nostr/package.json
plugins/plugin-ollama/package.json
plugins/plugin-openai/package.json
plugins/plugin-openrouter/package.json
plugins/plugin-pdf/package.json
plugins/plugin-rlm/package.json
plugins/plugin-roblox/package.json
plugins/plugin-shell/package.json
plugins/plugin-shopify/package.json
plugins/plugin-signal/package.json
plugins/plugin-slack/package.json
plugins/plugin-social-alpha/package.json
plugins/plugin-sql/package.json
plugins/plugin-streaming/package.json
plugins/plugin-suno/package.json
plugins/plugin-tailscale/package.json
plugins/plugin-tee/package.json
plugins/plugin-telegram/package.json
plugins/plugin-todos/package.json
plugins/plugin-tunnel/package.json
plugins/plugin-twitch/package.json
plugins/plugin-video/package.json
plugins/plugin-vision/package.json
plugins/plugin-wallet/package.json
plugins/plugin-web-search/package.json
plugins/plugin-wechat/package.json
plugins/plugin-whatsapp/package.json
plugins/plugin-workflow/package.json
plugins/plugin-x/package.json
plugins/plugin-x402/package.json
plugins/plugin-xai/package.json
plugins/plugin-zai/package.json
```

## P0: Wildcard exports and excessive public surface

Finding: the same 117 manifests above expose broad wildcard export keys, usually `./*` plus `./*.css`. `packages/ui/package.json` also exposes `./styles/*.css` and `./dist/styles/*.css`. `packages/agent/package.json` exposes broader source-backed wildcards under `./security/*` and `./services/*`.

Risk: wildcard exports make every built file a supported import path. Cleanup then becomes risky because an apparently internal file can be externally importable.

Recommended edit:

1. Keep root package exports.
2. For actual consumers, add explicit named subpaths only where the API is deliberately public.
3. Replace workspace imports with bare root imports where possible.
4. Remove `./*` only after `node scripts/audit-package-barrels.mjs --check` shows no unapproved subpath references.

Validation:

- `bun run audit:package-barrels:check`
- `bun run build`
- `bun run test`
- package-level `npm pack --dry-run` or existing `pack:dry-run` scripts on changed public packages

## P0: Source/generated declaration leakage

| Package path | Evidence | Risk | Recommended edit |
| --- | --- | --- | --- |
| `packages/agent/package.json` | root export points at `./src/index.ts`; subpaths expose `./src/services/*.d.ts`, `./src/security/*.d.ts`, and `bun` source `.ts` | Generated/source declarations become API; consumers can import arbitrary agent internals | Publish root from `dist`; replace `./services/*` and `./security/*` with explicit subpaths or root exports |
| `plugins/plugin-sql/package.json` | `main` and `types` point into `src/dist`; root/drizzle/schema exports also point into `src/dist` | Nested build output leaks into package API; hard to reason about package root | Move built artifacts to top-level `dist` and publish only one manifest |
| `plugins/plugin-sql/src/package.json` | second package manifest with same name `@elizaos/plugin-sql` and version `2.0.0-beta.0` | Duplicate package identity under a source directory | Decide whether this is a fixture; otherwise delete/merge after fixing root package layout |
| `plugins/plugin-whatsapp/package.json` | `types` and export types point at `dist/src/index.d.ts` | Build output preserves source folder layout as API | Emit declarations to `dist/index.d.ts` or map exports to stable `dist` files |
| `plugins/plugin-discord-local/package.json` | `types` and export types point at `dist/src/index.d.ts` | Same `dist/src` API leak | Emit declarations to stable `dist/index.d.ts` |
| `packages/prompts/package.json` | `main`, `types`, and root export point at `./src/index.ts` | Published package is source-backed while also having `dist` wildcard exports | Choose source-only private package or compiled public package, not both |
| `plugins/app-wallet/package.json` | `bun` condition points at `./src/index.ts` while general runtime uses `dist` | Bun consumers bypass compiled boundary | Move Bun condition to compiled output unless intentionally dev-only |
| `plugins/plugin-aosp-local-inference/package.json` | root export points at `./src/index.ts` | Source-backed plugin export | Compile/publish from `dist`, or mark the package private/internal |

Private benchmark packages (`packages/benchmarks/interrupt-bench`, `packages/benchmarks/lib`, `packages/inference/voice-bench`, `packages/native-plugins/shared-types`) also export source files. That is lower risk if they remain private and are excluded from published package validation.

## P1: Current subpath imports to eliminate

`node scripts/audit-package-barrels.mjs` found 41 workspace subpath references. These are the concrete imports that keep wildcard/subpath exports alive:

```text
plugins/app-2004scape/src/index.ts -> @elizaos/agent/services/app-session-gate
plugins/app-companion/src/plugin.ts -> @elizaos/agent/services/app-session-gate
plugins/app-scape/src/index.ts -> @elizaos/agent/services/app-session-gate
plugins/app-screenshare/src/index.ts -> @elizaos/agent/services/app-session-gate
packages/app-core/platforms/electrobun/src/native/permissions.ts -> @elizaos/agent/services/permissions/probers/index
packages/agent/src/services/permissions/register-probers.ts -> @elizaos/agent/services/permissions/register-probers
packages/agent/src/config/plugin-auto-enable.ts -> @elizaos/agent/config/plugin-auto-enable
packages/app-core/src/services/tool-call-cache/index.ts -> @elizaos/agent/runtime/tool-call-cache/index
packages/app-core/src/services/tool-call-cache/index.ts -> @elizaos/agent/runtime/tool-call-cache/index
packages/app/src/app-config.ts -> @elizaos/ui/config/app-config
packages/app/vite.config.ts -> @elizaos/ui/config/app-config
packages/app-core/scripts/aosp/variant-config-schema.ts -> @elizaos/ui/config/app-config
packages/app/src/main.tsx -> @elizaos/ui/styles
packages/ui/src/styles.ts -> @elizaos/ui/styles
packages/app/src/main.tsx -> @elizaos/ui/api/ios-local-agent-transport
packages/app/src/main.tsx -> @elizaos/ui/api/ios-local-agent-transport
plugins/app-task-coordinator/src/CodingAgentTasksPanel.tsx -> @elizaos/ui/api/client-types-cloud
plugins/app-task-coordinator/src/PtyConsoleSidePanel.d.ts -> @elizaos/ui/api/client-types-cloud
plugins/app-task-coordinator/src/PtyConsoleSidePanel.tsx -> @elizaos/ui/api/client-types-cloud
plugins/app-task-coordinator/src/PtyConsoleBase.tsx -> @elizaos/ui/api/client-types-cloud
plugins/app-task-coordinator/src/PtyConsoleDrawer.tsx -> @elizaos/ui/api/client-types-cloud
plugins/app-task-coordinator/src/PtyConsoleBase.d.ts -> @elizaos/ui/api/client-types-cloud
packages/app-core/scripts/playwright-ui-live-stack.ts -> @elizaos/ui/onboarding-config
packages/app-core/test/app/memory-relationships.real.e2e.test.ts -> @elizaos/ui/onboarding-config
packages/app-core/test/app/onboarding-companion.live.e2e.test.ts -> @elizaos/ui/onboarding-config
packages/app-core/test/helpers/i18n.ts -> @elizaos/ui/i18n
packages/app-core/src/api/dev-route-catalog.test.ts -> @elizaos/ui/navigation
packages/ui/src/types/index.ts -> @elizaos/shared/types/index
packages/app-core/scripts/lib/orchestrator-desktop-dev-banner.mjs -> @elizaos/shared/dev-settings-figlet-heading
cloud/packages/lib/services/coding-containers.ts -> @elizaos/shared/contracts/cloud-coding-containers
cloud/packages/lib/services/coding-containers.ts -> @elizaos/shared/contracts/cloud-coding-containers
cloud/packages/lib/services/coding-containers.ts -> @elizaos/shared/contracts/cloud-coding-containers
packages/app/src/main.tsx -> @elizaos/app-contacts/register
packages/app/src/main.tsx -> @elizaos/app-device-settings/register
packages/app/src/main.tsx -> @elizaos/app-messages/register
packages/app/src/main.tsx -> @elizaos/app-phone/register
packages/app/src/main.tsx -> @elizaos/app-wifi/register
plugins/app-lifeops/scripts/migrate-seed-routines.mjs -> @elizaos/app-lifeops/seed-routine-migrator
scripts/verify-phone-download.mjs -> @elizaos/app-core/services/local-inference/catalog
scripts/verify-phone-download.mjs -> @elizaos/app-core/services/local-inference/downloader
packages/examples/code/src/__tests__/test-utils.ts -> @elizaos/core/testing
```

Recommended edit:

- Move stable shared symbols to package root barrels.
- Replace cross-package subpath imports with root imports.
- Keep only intentionally public subpaths such as `@elizaos/core/testing` if they are documented and have explicit exports.
- For app registration imports (`@elizaos/app-*/register`), decide whether registration is a public convention; if yes, keep explicit `./register` exports and remove wildcard `./*`.

## P1: Tsconfig aliases bypass package APIs

High-risk alias sets:

- `tsconfig.json` maps `@elizaos/ui/*`, `@elizaos/core/*`, `@elizaos/shared/*`, and `@elizaos/app-wallet/*` directly to `src/*`.
- `packages/app/tsconfig.json` maps app, plugin, agent, core, shared, native plugin, and UI packages directly to `src` files.
- `packages/app/tsconfig.typecheck.json` mixes source aliases with generated declaration paths such as `plugins/plugin-sql/src/dist/index.node.d.ts` and `plugins/plugin-whatsapp/dist/src/index.d.ts`.
- `packages/app-core/tsconfig.json` maps many plugins to `src`, including wildcard aliases for `@elizaos/agent/*`, `@elizaos/plugin-computeruse/*`, `@elizaos/plugin-mcp/*`, `@elizaos/plugin-discord-local/*`, and `@elizaos/plugin-local-inference/*`.
- `packages/app-core/platforms/electrobun/tsconfig.json` repeats broad `src` aliases for app-core, agent, core, shared, UI, plugin-elizacloud, plugin-local-inference, plugin-signal, plugin-whatsapp, app-wallet, and app-task-coordinator.
- `packages/scenario-runner/tsconfig.build.json` still maps several dependencies to `src`, includes `@elizaos/app-lifeops` via `./src/shims/eliza-app-lifeops.ts`, and mixes `dist` with `src`.
- `cloud/apps/api/tsconfig.json` maps `@elizaos/core/*` to `packages/core/src/*`, `@elizaos/plugin-sql` to `plugins/plugin-sql/src/index.ts`, and `drizzle-orm` to `plugins/plugin-sql/node_modules/drizzle-orm`.
- `cloud/tsconfig.test.json` maps `@elizaos/core/*` to source and `@elizaos/cloud-ui` to `cloud/packages/ui/src/index.ts`.

Risk: these aliases let package code compile against implementation files that are not exported from package manifests. That hides missing exports, circular ownership, and package build layout bugs.

Recommended edit:

1. Split aliases into dev-only and build/publish configs.
2. In build/typecheck configs, resolve package names through `exports` or compiled `dist` declarations.
3. For client apps that intentionally bundle workspace source, keep a narrow app-local alias file and document it as bundler-only.
4. Remove wildcard aliases after the subpath imports above are moved to root APIs.

Validation:

- `bun run typecheck`
- `bun run build`
- per-package typecheck for changed owners: `bun run --cwd packages/app typecheck`, `bun run --cwd packages/app-core typecheck`, `bun run --cwd packages/app-core/platforms/electrobun typecheck`, `bun run --cwd cloud/apps/api typecheck`

## P1: Cloud package boundary notes

Cloud packages are cleaner than the root plugin/app package set:

- `cloud/packages/sdk/package.json` has a clean root export with `types` first.
- `cloud/packages/billing/package.json` has a clean root export with `types` first.
- `cloud/packages/ui/package.json` exposes `"."` as a string export and top-level `types`; this is acceptable, but can be made consistent with a conditional object.
- `cloud/packages/lib/package.json` and `cloud/packages/db/package.json` are private and source-backed (`"." -> "./index.ts"`). That is acceptable only if they remain private internal workspace packages.

Risk remains in cloud app tsconfig aliases rather than published cloud package manifests, especially `cloud/apps/api/tsconfig.json` pulling `@elizaos/plugin-sql` source and that plugin's nested `node_modules`.

## P2: Shims and temporary package markers

Exact package/report candidates:

- `plugins/plugin-local-embedding/package.json`: description says it is a deprecated compatibility shim for the local inference provider. Keep only if a migration window is still required; otherwise delete after consumers move to `@elizaos/plugin-local-inference`.
- `cloud/services/_smoke-mcp/package.json`: description says it is a temporary build/dry-deploy harness. Either document why it remains or remove once MCP Workers verification is complete.
- `plugins/plugin-sql/src/package.json`: nested duplicate package identity should be resolved as part of plugin-sql layout cleanup.
- `scripts/patch-nested-agent-dist.mjs` and `scripts/patch-nested-core-dist.mjs`: packaging shims around nested dist layouts. Reassess after source/generated declaration leakage is fixed.
- `packages/elizaos/templates/project/apps/app/src/type-stubs/**`: template stubs are intentional if the template must build without the full monorepo, but should not leak into real package export policy.

## Implementation order

1. Add a package export-order check and fix all 117 condition-order offenders.
2. Fix `plugins/plugin-sql` package layout first; it is the highest-risk source/generated export leak.
3. Fix `packages/agent` exports so public service/security APIs are explicit and compiled.
4. Move the 41 live subpath imports to root/public APIs.
5. Collapse wildcard exports package family by package family.
6. Tighten tsconfig aliases after the exported API is stable.
7. Re-run full validation and package-barrel check.

## Final validation matrix

```sh
bun run lint:check
bun run typecheck
bun run build
bun run test
bun run audit:package-barrels:check
node scripts/audit-package-barrels.mjs
```

For each changed published package, also run its package-level build and dry pack command where present:

```sh
bun run --cwd <package> build
bun run --cwd <package> typecheck
bun run --cwd <package> pack:dry-run
```
