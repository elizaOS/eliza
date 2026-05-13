# Type Duplication Audit

Date: 2026-05-12
Scope: TypeScript `type`, `interface`, and enum-like contract duplication across packages, plugins, and cloud packages.

Validation command used for this audit:

```bash
rg -n "^\s*export\s+(interface|type|enum)\s+[A-Za-z0-9_]+|^\s*(interface|type|enum)\s+[A-Za-z0-9_]+" --glob '*.ts' --glob '*.tsx' --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**'
```

Recommended validation after consolidation:

```bash
bun run typecheck
```

## Findings

### 1. LifeOps connector contracts are copied into plugin-health

Risk: High

Evidence from `rg`:

- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:10`: `export type ConnectorMode = "local" | "cloud";`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:12`: `export interface ConnectorStatus`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:38`: `export type DispatchResult =`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:60`: `export interface ConnectorOAuthConfig`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:67`: `export interface ConnectorContribution`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:123`: `export interface ConnectorRegistryFilter`
- `plugins/app-lifeops/src/lifeops/connectors/contract.ts:128`: `export interface ConnectorRegistry`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:13`: `export type ConnectorMode = "local" | "cloud";`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:15`: `export interface ConnectorStatus`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:21`: `export type DispatchResult =`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:42`: `export interface ConnectorOAuthConfig`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:49`: `export interface ConnectorContribution`
- `plugins/plugin-health/src/connectors/contract-stubs.ts:67`: `export interface ConnectorRegistry`

Shape overlap: `ConnectorMode`, `ConnectorStatus`, `DispatchResult`, `ConnectorOAuthConfig`, `ConnectorContribution`, and `ConnectorRegistry` are duplicated almost byte-for-byte. `plugin-health` labels these as Wave-1 stubs, but they are now live contracts with behavior-affecting failure taxonomy.

Consolidation target: Move the frozen connector/channel/bus contracts to a boundary package that both LifeOps and health can import without LifeOps importing health internals. Good candidates are `@elizaos/core` if these are runtime-level contracts, or `@elizaos/shared` / an app-core contract subpath if they are product-layer contracts. Keep LifeOps as the implementation owner for the runner, not the type owner for health contributions.

Boundary issue: `plugin-health` currently mirrors LifeOps-owned types, so a LifeOps-only edit can silently break health connector assumptions.

### 2. Cloud SDK types are duplicated inside plugin-elizacloud

Risk: High

Evidence from `rg`:

- `cloud/packages/sdk/src/types.ts:25`: `export type JsonPrimitive = boolean | number | string | null;`
- `cloud/packages/sdk/src/types.ts:26`: `export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];`
- `cloud/packages/sdk/src/types.ts:28`: `export interface JsonObject`
- `cloud/packages/sdk/src/types.ts:115`: `export interface ModelListEntry`
- `cloud/packages/sdk/src/types.ts:122`: `export interface ModelListResponse`
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:25`: `export type JsonPrimitive = boolean | number | string | null;`
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:26`: `export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];`
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:28`: `export interface JsonObject`
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:115`: `export interface ModelListEntry`
- `plugins/plugin-elizacloud/src/utils/cloud-sdk/types.ts:122`: `export interface ModelListResponse`

Shape overlap: The SDK file and plugin-local `cloud-sdk/types.ts` are exact copies for the base cloud client contracts, including default URLs, request options, model listing DTOs, and JSON primitives.

Consolidation target: Make `plugins/plugin-elizacloud` consume `cloud/packages/sdk` as the SDK owner. If package graph constraints prevent that, generate the plugin-local SDK from the cloud SDK and add a provenance header plus a sync check, but do not hand-maintain both.

Boundary issue: A plugin-local copy can drift from the cloud API SDK and create runtime/API compatibility bugs while still typechecking locally.

### 3. Skill contracts are split between packages/skills, plugin-agent-skills, and agent API DTOs

Risk: High

Evidence from `rg`:

- `packages/skills/src/types.ts:34`: `export interface SkillFrontmatter`
- `packages/skills/src/types.ts:73`: `export interface Skill`
- `packages/skills/src/types.ts:144`: `export interface SkillDiagnostic`
- `packages/skills/src/types.ts:201`: `export interface SkillEntry`
- `packages/skills/src/types.ts:215`: `export interface SkillMetadata`
- `plugins/plugin-agent-skills/src/types.ts:20`: `export interface SkillFrontmatter`
- `plugins/plugin-agent-skills/src/types.ts:47`: `export interface SkillMetadata`
- `plugins/plugin-agent-skills/src/types.ts:124`: `export interface Skill`
- `plugins/plugin-agent-skills/src/types.ts:207`: `export interface SkillSearchResult`
- `packages/agent/src/api/skills-routes.ts:32`: `export interface SkillEntry`
- `packages/agent/src/api/plugin-discovery-helpers.ts:52`: `export interface SkillEntry`
- `packages/agent/src/api/server-types.ts:98`: `export interface SkillEntry`

Shape overlap: `SkillFrontmatter`, `SkillMetadata`, and `Skill` have the same domain name but different authority and requiredness. `packages/skills` allows optional frontmatter names/descriptions for filesystem loading and provenance; `plugin-agent-skills` enforces Agent Skills/Otto registry fields; `packages/agent` repeats the transport `SkillEntry` DTO three times with `{ id, name, description, enabled, scanStatus? }`.

Consolidation target: Define three explicit layers and name them accordingly:

- `@elizaos/skills`: canonical filesystem/runtime skill shapes (`SkillFrontmatter`, `LoadedSkill`, diagnostics).
- `plugin-agent-skills`: registry/Otto-specific DTOs, renamed to avoid claiming global `Skill`.
- `packages/agent/src/api`: one exported `SkillListItemDto` imported by `skills-routes.ts`, `plugin-discovery-helpers.ts`, and `server-types.ts`.

Boundary issue: Same-name types with different semantics invite accidental cross-imports and make API evolution risky.

### 4. JSON primitives are repeatedly redeclared despite @elizaos/core owning JsonValue

Risk: Medium

Evidence from `rg`:

- `packages/core/src/types/primitives.ts:4`: `export type JsonValue =`
- `packages/core/src/types/primitives.ts:15`: `export type JsonObject = { [key: string]: JsonValue };`
- `packages/core/src/features/trajectories/types.ts:4`: `export type JsonPrimitive = string | number | boolean | null;`
- `packages/core/src/features/trajectories/types.ts:5`: `export type JsonValue =`
- `packages/core/src/features/advanced-memory/types.ts:3`: `export type JsonPrimitive = string | number | boolean | null;`
- `packages/core/src/features/advanced-memory/types.ts:4`: `export type JsonValue =`
- `packages/core/src/features/advanced-planning/types.ts:10`: `export type JsonPrimitive = string | number | boolean | null;`
- `packages/core/src/features/advanced-planning/types.ts:11`: `export type JsonValue =`
- `plugins/plugin-discord/types.ts:192`: `export type JsonValue =`
- `plugins/plugin-discord/types.ts:200`: `export type JsonObject = { [key: string]: JsonValue };`
- `plugins/plugin-local-storage/src/types.ts:4`: `export type JsonPrimitive = string | number | boolean | null;`
- `plugins/plugin-local-storage/src/types.ts:21`: `export type JsonValue = JsonPrimitive | JsonObject | JsonArray;`
- `packages/native-plugins/gateway/src/definitions.ts:3`: `export type JsonPrimitive = string | number | boolean | null;`
- `packages/native-plugins/gateway/src/definitions.ts:7`: `export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];`

Shape overlap: Most definitions are structurally identical. Some allow object properties to be `undefined` (`cloud/packages/sdk`, `plugin-elizacloud`), which is not JSON after serialization and should be a deliberate named variant rather than an unnoticed fork.

Consolidation target: Re-export `JsonValue`, `JsonObject`, and `JsonPrimitive` from `@elizaos/core` for core/plugin/runtime code. For SDK DTOs that intentionally allow optional object properties, use a distinct `JsonObjectWithUndefined` / `LooseJsonObject` name and document the serialization boundary.

Boundary issue: Recursive JSON definitions are easy to get "almost right"; mismatches around `undefined` and readonly arrays can break serialization assumptions.

### 5. Training inference endpoint and stats DTOs drift between app-training and UI

Risk: High

Evidence from `rg`:

- `plugins/app-training/src/services/vast-job-store.ts:244`: `export interface InferenceEndpointRecord`
- `plugins/app-training/src/services/vast-inference-stats.ts:11`: `export interface InferenceStatRow`
- `plugins/app-training/src/services/vast-inference-stats.ts:24`: `export interface InferenceStatsAggregate`
- `plugins/app-training/src/routes/training-vast-routes.ts:178`: `const endpoints = await service.listInferenceEndpoints();`
- `plugins/app-training/src/routes/training-vast-routes.ts:223`: `const stats = await service.getInferenceStats(label, lastMinutes);`
- `packages/ui/src/components/training/types.ts:40`: `export interface InferenceEndpoint`
- `packages/ui/src/components/training/types.ts:47`: `export interface InferenceStats`
- `packages/ui/src/components/training/hooks/useTrainingApi.ts:164`: `const data = await apiCall<{ endpoints: InferenceEndpoint[] }>(`
- `packages/ui/src/components/training/hooks/useTrainingApi.ts:213`: `const data = await apiCall<InferenceStats>(`

Shape overlap/drift: Backend endpoint records are `{ id, label, base_url, registry_key, created_at }`; UI endpoint DTO is `{ id, label, base_url, model }`. Backend stats aggregate is `{ label, window_minutes, sample_count, tokens_per_sec_avg, ... }`; UI expects percentile-like fields `{ p50_tps, p95_tps, p50_tpot_ms, ... }`.

Consolidation target: Export route DTOs from the app-training package or from `@elizaos/shared/contracts/training` and have both the route and UI import them. If UI intentionally presents a transformed view model, create explicit `InferenceEndpointDto` / `InferenceEndpointViewModel` and map at the API boundary.

Boundary issue: This is not just duplication; it indicates likely frontend/backend contract drift.

### 6. Local inference recommendation result is duplicated in app-core and UI after shared local-inference types were centralized

Risk: Medium

Evidence from `rg`:

- `packages/shared/src/local-inference/types.ts:15`: `export type AgentModelSlot =`
- `packages/shared/src/local-inference/types.ts:52`: `export interface InstalledModel`
- `packages/shared/src/local-inference/types.ts:287`: `export interface CatalogModel`
- `packages/shared/src/local-inference/types.ts:492`: `export interface LocalInferenceDownloadStatus`
- `packages/app-core/src/services/local-inference/types.ts:1`: local inference type re-export shim
- `packages/ui/src/services/local-inference/types.ts:1`: local inference type re-export shim
- `packages/app-core/src/services/local-inference/recommendation.ts:50`: `export interface RecommendedModelSelection`
- `packages/ui/src/services/local-inference/recommendation.ts:23`: `export interface RecommendedModelSelection`

Shape overlap: `RecommendedModelSelection` is identical in app-core and UI: `slot`, `platformClass`, `model`, `quantization`, `fit`, `reason`, `alternatives`. The surrounding local inference contract is already centralized under `@elizaos/shared`, so this is a remaining straggler.

Consolidation target: Move `RecommendationPlatformClass` and `RecommendedModelSelection` into `packages/shared/src/local-inference/types.ts` or a `recommendation-types.ts` submodule. Keep recommendation algorithms in app-core/UI only if both environments truly need local implementations.

Boundary issue: The type drift risk is lower than the training DTO issue because both files currently match, but future catalog changes will need duplicate edits.

### 7. Core action parameter schemas are locally reshaped in cloud bootstrap and plugin MCP utilities

Risk: Medium

Evidence from `rg`:

- `packages/core/src/types/components.ts:23`: `export interface ActionParameterSchema`
- `packages/core/src/types/components.ts:60`: `export interface ActionParameter`
- `packages/core/src/types/components.ts:101`: `export interface ActionParameters`
- `packages/core/src/types/components.ts:643`: `export interface ActionResult`
- `cloud/packages/lib/eliza/plugin-cloud-bootstrap/types.ts:3`: `export interface NativePlannerActionResult extends ActionResult`
- `cloud/packages/lib/eliza/plugin-cloud-bootstrap/types.ts:17`: `export interface ActionParameter`
- `cloud/packages/lib/eliza/plugin-mcp/utils/schema-converter.ts:4`: `export interface ActionParameter`

Shape overlap: Core uses action parameters as named entries with nested schema. Cloud bootstrap defines a simplified object-map parameter shape `{ type, description, required?, enum?, default? }` and converts it back to `Action["parameters"]`. MCP schema conversion declares another local `ActionParameter`.

Consolidation target: Add an explicit core helper type for the simplified authoring form, for example `ActionParameterAuthoringSpec`, plus conversion helpers in `@elizaos/core`. Then cloud bootstrap and MCP utilities can import the authoring type instead of redefining it.

Boundary issue: Local simplified schemas can lose capabilities present in `ActionParameterSchema` (`items`, `properties`, `oneOf`, `anyOf`, nested required arrays) or encode enum/default differently.

### 8. Model usage normalization is duplicated across provider plugins

Risk: Medium

Evidence from `rg`:

- `plugins/plugin-anthropic/utils/events.ts:14`: `export type NormalizedModelUsage =`
- `plugins/plugin-openrouter/utils/events.ts:12`: `export type NormalizedModelUsage =`
- `plugins/plugin-anthropic/types/index.ts:147`: `export interface ModelUsageEventData`

Shape overlap: Anthropic and OpenRouter both normalize provider token usage into `{ promptTokens, completionTokens, totalTokens }` and emit `EventType.MODEL_USED`. The functions differ only in provider-specific token input names and event labels.

Consolidation target: Put `NormalizedModelUsage` and a small `emitModelUsageEvent` helper in `@elizaos/core` or a provider utility package. Provider plugins should pass `{ provider, modelType, modelName, modelLabel, usage }` and only keep provider-specific extraction of token aliases.

Boundary issue: Provider usage telemetry is cross-cutting; duplicated event assembly makes analytics inconsistent when one plugin adds a new token field such as cache reads/writes.

### 9. Provider model list/info DTOs repeat near-identical shapes with provider-specific names

Risk: Low

Evidence from `rg`:

- `plugins/plugin-openrouter/types/index.ts:80`: `export interface OpenRouterModelInfo`
- `plugins/plugin-ollama/types/index.ts:46`: `export interface OllamaModelInfo`
- `plugins/plugin-lmstudio/types/index.ts:26`: `export interface LMStudioModelInfo`
- `plugins/plugin-mlx/types/index.ts:27`: `export interface MlxModelInfo`
- `plugins/plugin-openai/types/index.ts:359`: `export interface OpenAIModelsResponse`

Shape overlap: Provider packages maintain their own "model info" records. These are not exact duplicates because upstream APIs differ, but most expose `id/name`, context-ish metadata, capabilities, and response wrappers.

Consolidation target: Do not force upstream response DTOs into one type. Instead, define a normalized `ProviderModelRecord` in core/shared for UI/runtime selection and keep raw provider DTOs private to each plugin.

Boundary issue: Low current risk, but route/UI code should not consume raw provider-specific DTOs when a normalized selector model exists.

## Prioritized TODOs

1. Create a shared owner for the LifeOps/health connector contracts and replace `plugin-health/src/connectors/contract-stubs.ts` imports first. This has the highest behavioral risk because `DispatchResult` drives runner retry/escalation policy.
2. Remove or generate the `plugin-elizacloud` cloud SDK copy from `cloud/packages/sdk`; add a sync check if direct imports are not possible.
3. Fix app-training/UI inference DTO drift by introducing explicit shared route DTOs and mapping view models separately.
4. Split skill type ownership into filesystem/runtime, registry/Otto, and API transport DTO layers; dedupe the repeated agent `SkillEntry` first because it is narrow and low-risk.
5. Centralize `JsonValue` imports around `@elizaos/core`, with a separately named loose JSON variant where `undefined` is intentionally allowed.
6. Move local inference recommendation result types into `@elizaos/shared/local-inference`.
7. Add core authoring/conversion helpers for simplified action parameter specs and replace cloud bootstrap/MCP local copies.
8. Normalize model usage telemetry through a shared helper, then leave provider raw model DTOs private unless they cross package boundaries.
