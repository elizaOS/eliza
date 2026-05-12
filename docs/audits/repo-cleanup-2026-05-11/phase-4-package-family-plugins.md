# Phase 4 - Provider, Social, Utility, And Wallet Plugin Audit

Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Mode: dry run / report only

No source files were deleted or modified for this pass.

## Scope

All `plugins/plugin-*` packages except `plugin-health` and the app-plugin
family covered elsewhere. The scan focused on stale compatibility surfaces,
stubs, missing validation scripts, package-boundary drift, suppressions, and
obvious consolidation candidates.

## Methodology

Read-only commands used:

```sh
git ls-files 'plugins/**' |
  rg -v '^plugins/(app-lifeops|plugin-health|app-)' |
  rg -n -i '(legacy|deprecated|fallback|stub|shim|compat|unified|consolidated|TODO|FIXME|HACK|@ts-nocheck|eslint-disable|biome-ignore|contract-stubs)'
node -e '<package script inventory over plugins/*/package.json>'
rg -n 'biome-ignore|eslint-disable|@ts-nocheck|@ts-ignore|@ts-expect-error' plugins
```

## High-Confidence Review Queue

These are not automatic deletes, but they are the highest-signal package
cleanup targets.

| Path | Classification | Recommended Action |
| --- | --- | --- |
| `plugins/plugin-agent-orchestrator/src/actions/sandbox-stub.ts` | Stub-named action | Verify whether it is a real action placeholder or live sandbox task bridge. Delete or rename only after action registry/spec check. |
| `plugins/plugin-discord/compat.ts` | Active core-version compatibility | Keep for now. Remove only with Discord runtime version-floor change. |
| `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts` | Active API compatibility | Keep while app-core/agent dispatchers import it. Route ownership cleanup belongs in backend wave. |
| `plugins/plugin-mcp/src/tool-compatibility/**` | Active provider compatibility layer | Keep if MCP provider translation is still a feature. Rename only if it becomes canonical. |
| `plugins/plugin-music/src/route-fallback.ts` | Fallback route | Audit for real alternate path. If it only masks missing route ownership, delete after routing tests. |
| `plugins/plugin-music/src/utils/streamFallback.ts` | Fallback utility | Audit for production fallback behavior and user-visible degradation. |
| `plugins/plugin-music/src/utils/ytdlpFallback.ts` | Fallback utility | Audit whether fallback is necessary or should be a hard dependency error. |
| `plugins/plugin-shell/bun-shims.d.ts` | Runtime type shim | Keep if Bun shell plugin needs it; otherwise move to a package-local type-stubs folder. |
| `plugins/plugin-wallet/src/browser-shim/**` | Browser injection shim | Keep. This is real browser functionality, not slop. |
| `plugins/plugin-wallet/src/providers/unified-wallet-provider.ts` | Public provider name | Keep until product/API rename is approved. |
| `plugins/plugin-workflow/src/lib/legacy-*.ts` | Data migration | Keep while installed users may carry legacy workflow/task rows. |
| `plugins/plugin-zai/providers/openai-compatible.ts` | Provider compatibility | Keep; compatibility is the provider protocol. |

## Script Coverage Gaps

Packages missing one or more standard package-local gates:

| Package | Gap |
| --- | --- |
| `@elizaos/plugin-agent-skills` | no `test` |
| `@elizaos/plugin-browser` | no `test`, no `lint` |
| `@elizaos/plugin-calendly` | no `lint` |
| `@elizaos/plugin-capacitor-bridge` | no `test` |
| `@elizaos/plugin-computeruse` | no `lint` |
| `@elizaos/plugin-discord-local` | no `test` |
| `@elizaos/plugin-form` | no `lint` |
| `@elizaos/plugin-github` | no `lint` |
| `@elizaos/plugin-local-inference` | no `test` |
| `@elizaos/plugin-shopify` | no `typecheck`, no `lint` |
| `@elizaos/plugin-telegram` | no `typecheck` |
| `@elizaos/plugin-video` | no `lint` |
| `@elizaos/plugin-wallet` | no `typecheck` |
| `@elizaos/plugin-web-search` | no `test` |
| `@elizaos/plugin-wechat` | no `typecheck`, no `lint` |
| `@elizaos/plugin-x402` | no `test` |

TODO:
add uniform scripts or explicit no-op scripts with a reason. Package-level
validation should not be discoverable only from root Turbo config.

## Suppression And Low-Quality Hotspots

Top suppression cluster is `plugin-wallet`, especially Solana/EVM LP and DEX
areas. The cleanup direction should be:

1. Move shared LP/DEX transaction types into canonical modules.
2. Replace `@ts-nocheck` and broad suppressions with typed SDK wrappers.
3. Keep chain-specific code behind package-local boundaries; do not leak SDK
   raw shapes into app/UI packages.
4. Add fast unit tests for wrappers before removing suppressions.

Other hotspots:

- `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts` has repeated
  suppression markers; audit parser edge cases and replace suppressions with
  typed helpers.
- `plugins/plugin-computeruse/src/platform/driver.ts` has suppressions around
  platform driver typing; isolate platform-specific types.
- `plugins/plugin-browser/src/index.ts` and `plugins/plugin-aosp-local-inference`
  carry suppressions that should be justified or removed.

## Consolidation TODOs

1. Define the policy for plugin compatibility route files: public route alias,
   temporary transition, or internal implementation name. Do not rename without
   route tests.
2. Move repeated OpenAI-compatible provider protocol helpers into a shared
   provider utility only if at least two plugins can import it without cycles.
3. Consolidate wallet LP/DEX service typing. The number of suppressed files
   indicates structural type drift, not isolated lint noise.
4. Remove or rename `sandbox-stub.ts` if it is now a real task action. Stub
   names in action registries make audit results unreliable.
5. Ensure every publishable plugin has `build`, `typecheck`, `test`, and `lint`
   scripts.

## Validation Gate

Minimum after plugin-family cleanup:

```sh
bun run test:plugins
bun run lint
bun run typecheck
bun run build
bun run --cwd plugins/plugin-wallet test
bun run --cwd plugins/plugin-discord test
bun run --cwd plugins/plugin-workflow test
```

Knip remains blocked locally by the `@oxc-resolver/binding-darwin-arm64`
native binding signature issue. Rerun `bun run knip` after that local toolchain
problem is resolved.
