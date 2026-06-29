# Issue #9941 core plugin coupling

## Scope

- Deleted the dead `buildCharacterPlugins()` env-to-plugin resolver from `packages/core/src/character.ts`.
- Added a focused regression assertion in `packages/core/src/character.test.ts` proving the character module no longer exports `buildCharacterPlugins` and no longer contains `@elizaos/plugin-*` package literals.
- This removes the divergent provider/plugin auto-enable copy from the innermost `@elizaos/core` layer.
- Removed the hardcoded app-core route-loader fallback imports for workflow, wallet, and agent-orchestrator from `packages/app-core/src/runtime/eliza.ts`.
- Made the three owning plugins register their route loaders through value-referenced/synchronous registration paths:
  - `@elizaos/plugin-workflow:routes`
  - `@elizaos/plugin-wallet:routes`
  - `@elizaos/plugin-agent-orchestrator:routes`
- Added focused plugin-owned registration tests plus an app-core boundary guard that fails if the route-loader fallback specifiers return.
- Moved app-core default TTS provider metadata into `packages/app-core/src/runtime/tts-provider-registry.ts`.
- Updated `collectPluginNames()` and `ensureTextToSpeechHandler()` to consume that provider registration instead of carrying the `@elizaos/plugin-edge-tts` package literal directly in runtime glue.
- Added a focused registry test proving the default provider metadata, disable controls, and absence of the default TTS package literal from `eliza.ts` / `ensure-text-to-speech-handler.ts`.
- Moved the agent provider env map out of `packages/agent/src/runtime/plugin-collector.ts`.
- Added `autoEnableProvider` markers to first-party registry config fields and generated `packages/registry/src/first-party/provider-plugin-map.json`.
- Added plugin-owned entries for z.ai and CLI inference plus curated entries for DeepSeek, Mistral, and Together so all previously supported provider env keys are registry-owned.
- Added a registry test that locks the generated provider env contract and rejects duplicate provider env-key claims.

## Verification

- `bunx vitest run --config packages/core/vitest.config.ts packages/core/src/character.test.ts --coverage.enabled=false` (2 passed)
- `bun run --cwd packages/core typecheck`
- `bunx @biomejs/biome check --write packages/core/src/character.ts packages/core/src/character.test.ts`
- `git diff --check -- packages/core/src/character.ts packages/core/src/character.test.ts`
- `bunx vitest run --config packages/app-core/vitest.config.ts packages/app-core/src/runtime/app-route-plugin-skip.test.ts --coverage.enabled=false` (13 passed)
- `bun test __tests__/unit/register-routes.test.ts` from `plugins/plugin-workflow` (1 passed)
- `bunx vitest run --config vitest.config.ts src/register-routes.test.ts --coverage.enabled=false` from `plugins/plugin-wallet` (1 passed)
- `bunx vitest run --config vitest.config.ts __tests__/unit/register-routes.test.ts --coverage.enabled=false` from `plugins/plugin-agent-orchestrator` (2 passed)
- `bun run --cwd packages/app-core typecheck`
- `bun run --cwd plugins/plugin-agent-orchestrator typecheck`
- `bun run --cwd plugins/plugin-workflow typecheck`
- `bun run --cwd plugins/plugin-wallet check`
- `bunx vitest run --config packages/app-core/vitest.config.ts packages/app-core/src/runtime/tts-provider-registry.test.ts --coverage.enabled=false` (3 passed)
- `bun run --cwd packages/app-core typecheck`
- `git diff --check -- packages/app-core/src/runtime/tts-provider-registry.ts packages/app-core/src/runtime/tts-provider-registry.test.ts packages/app-core/src/runtime/ensure-text-to-speech-handler.ts packages/app-core/src/runtime/eliza.ts`
- `rg -n "@elizaos/plugin-edge-tts|EDGE_TTS_PLUGIN" packages/app-core/src/runtime/eliza.ts packages/app-core/src/runtime/ensure-text-to-speech-handler.ts` (no matches)
- `bun run --cwd packages/registry generate:first-party`
- `bun run --cwd packages/registry generate:first-party:check`
- `bun run --cwd packages/registry test src/first-party/provider-plugin-map.test.ts` (3 passed)
- `bunx vitest run --config packages/agent/vitest.config.ts packages/agent/src/runtime/__tests__/plugin-collector-cerebras.test.ts packages/agent/src/runtime/__tests__/plugin-collector-zai.test.ts --coverage.enabled=false` (2 files passed, 4 passed)
- `bun run --cwd packages/registry typecheck`
- `bun run --cwd packages/agent typecheck`
- `git diff --check -- packages/registry/src/first-party/schema.ts packages/registry/src/first-party/generate.ts packages/registry/src/first-party/provider-plugin-map.test.ts packages/registry/src/first-party/provider-plugin-map.json packages/registry/src/first-party/generated.json packages/registry/package.json packages/agent/src/runtime/plugin-collector.ts`
- `rg -n "PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = \\{|ANTHROPIC_API_KEY:" packages/agent/src/runtime/plugin-collector.ts` (no matches)
