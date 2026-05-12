# Type Duplication Audit: Examples, Benchmarks, Inference, Training, Cloud

Date: 2026-05-12

## Scope

Requested scope:

- `packages/examples`
- `packages/benchmarks`
- `packages/inference`
- `packages/training`
- `cloud/**`

Method:

- Used `git ls-files` for the parent repo so transient artifacts such as
  `node_modules`, `.venv`, `.wrangler`, `.eliza`, `dist`, caches, and local
  benchmark output were not treated as source contracts.
- Scanned TypeScript interfaces, type aliases, enums, and `z.object(...)`
  schemas in the requested paths.
- Scanned Python dataclasses, `TypedDict`, `BaseModel`, `Protocol`, and
  `NamedTuple` classes in benchmark and training packages.
- Scanned `packages/inference/llama.cpp` separately because it is an in-tree
  submodule/fork, not normal parent-repo tracked source.

High-level scan counts:

| Area | Tracked files | TS files | Python files | TS declarations found | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `packages/examples` | 497 | 223 | 0 | 363 | Repeated sample API and local-app contracts. |
| `packages/benchmarks` | 3,077 | 110 | 1,529 | 221 | Python benchmark DTOs are the larger duplication surface. |
| `packages/inference` | 274 | 1 | 0 | 2 | Parent repo has little TS type surface; `llama.cpp` is separate. |
| `packages/training` | 431 | 0 | 257 | 0 | Python dataclasses and string schema constants dominate. |
| `cloud` | 2,859 | 2,221 | 1 | 3,466 | Largest duplication surface: API, SDK, frontend DTOs, generated mirrors. |

The Python pass found 723 benchmark/training dataclass-like contracts in
tracked parent-repo files. The `llama.cpp` submodule contains 259 TS/Python
files and 88 TS declarations in its tracked files, but most of that surface is
upstream/fork ownership rather than elizaOS application contracts.

## Executive Findings

1. `cloud` has the most actionable duplication. Route-local request/response
   types, frontend DTO copies, SDK copies, and generated cloud API type mirrors
   are all converging on the same contracts without a single enforced source.
2. `packages/examples` repeats the same small chat, health, error, provider,
   runtime, and message DTOs across platform examples. These are low-risk but
   useful to consolidate because examples are copied by users.
3. `packages/benchmarks` has many same-name Python DTOs with different shapes.
   These should not all become one mega-type, but shared result artifacts,
   adapter responses, and leaderboard summaries should be centralized or
   intentionally renamed.
4. `packages/training` repeatedly references the same `eliza_native_v1` and
   `eliza.eliza1_trajectory_record.v1` contracts through local constants and
   validators. The scripts already point toward a canonical native-record
   module, but enforcement is incomplete.
5. `packages/inference` parent source has little project-local type duplication.
   The `llama.cpp` submodule/fork should be treated as upstream-owned except for
   explicit elizaOS patch layers.
6. Generated and test-only duplicates are common and mostly acceptable, but the
   generated copies need freshness checks so generated duplication does not turn
   into drift.

## Same-Name Hotspots

Representative TypeScript same-name groups:

| Name | Count | Primary locations | Recommendation |
| --- | ---: | --- | --- |
| `Story` | 24 | `cloud/packages/ui/src/components/*.stories.tsx` | Keep local. This is normal Storybook file-local aliasing. |
| `RouteParams` | 22 | `cloud/apps/api/**/[id]/**/route.ts` | Consolidate with a small route param helper/type. |
| `ChatResponse` | 14 | `packages/examples/{app,aws,cloudflare,convex,gcp,supabase,vercel}` | Consolidate sample chat response contracts. |
| `requestSchema` | 13 | `cloud/apps/api/v1/eliza/**/route.ts` | Rename or export route-specific schemas when they define public contracts. |
| `Harness` | 13 | `cloud/packages/tests`, `packages/benchmarks/lib` | Mostly test-local. Rename to `TestHarness` or extract only repeated setup shapes. |
| `HealthResponse` | 10 | examples plus cloud tests | Consolidate sample health response shape. |
| `ChatMessage` | 9 | examples, cloud example, API route | Use shared chat-message DTOs where the shape is intentionally portable. |
| `ChatRequest` | 9 | examples plus cloud chat route | Consolidate example request DTOs; keep OpenAI-compatible API route separate. |
| `JsonValue`/`JsonObject` | 8 each | cloud lib/sdk/tests/services, examples | Move reusable JSON primitives to a cloud/example shared type module. |

Representative Python same-name groups:

| Name | Count | Primary locations | Recommendation |
| --- | ---: | --- | --- |
| `BenchmarkResult` | 6 | HyperliquidBench, experience, lifeops-bench, standard, trust, woobench | Split shared artifact envelope from domain-specific metric payloads; rename domain DTOs. |
| `FilterStats` | 4 | lifeops-bench ingest, training preparation/privacy/judge scripts | Rename by domain and share the true privacy-filter counters. |
| `LeaderboardComparison` | 4 | gaia, orchestrator, terminal-bench, vending-bench | Create shared base or rename to benchmark-specific DTOs. |
| `Scenario` | 4 | adhdbench, lifeops-bench, orchestrator_lifecycle, woobench | Keep domain-specific but rename or namespace to avoid false interchangeability. |
| `ScenarioResult` | 4 | adhdbench, lifeops-bench, orchestrator_lifecycle, woobench | Same as `Scenario`; introduce a shared result envelope if needed. |
| `MessageResponse` | 3 | eliza-adapter, hermes-adapter, openclaw-adapter | Consolidate. These have the same shape. |

## Package Findings

### `packages/examples`

Findings:

- Serverless and REST examples repeatedly define chat contracts:
  - `packages/examples/aws/handler.ts:29` defines `ChatRequest`.
  - `packages/examples/gcp/handler.ts:27` defines the same request shape.
  - `packages/examples/vercel/api/chat.ts:26` defines the same request shape.
  - `packages/examples/rest-api/elysia/server.ts:119` and
    `packages/examples/rest-api/hono/server.ts:162` define a smaller
    `ChatRequest`.
  - `packages/examples/supabase/functions/eliza-chat/lib/types.ts:5` exports
    `ChatResponse` and `HealthResponse`.
- `ChatResponse` is repeated across app, AWS, Cloudflare, Convex, GCP,
  Supabase, and Vercel examples. The dominant shape is
  `{ response, conversationId, timestamp }`; Cloudflare uses a smaller
  `{ response, character, userId }` variant.
- `HealthResponse` is repeated across AWS, GCP, Supabase, Vercel test clients,
  and Convex test clients. Supabase adds `"initializing"` to the status union.
- Local app examples repeat the same UI message shape:
  - `packages/examples/app/capacitor/backend/src/types.ts:101`
  - `packages/examples/app/capacitor/frontend/src/types.ts:87`
  - `packages/examples/app/electron/backend/src/types.ts:87`
  - `packages/examples/browser-extension/shared/types.ts:98`
  These use `{ id, role, text, timestamp }`.
- Cloud example `cloud/examples/clone-ur-crush/types/index.ts:2` defines
  `ElizaCharacter`, which largely duplicates
  `cloud/packages/lib/types/eliza-character.ts:13`.

Recommendations:

- Add a small example contract module such as
  `packages/examples/shared/chat-contracts.ts` with:
  - `ExampleChatRequest`
  - `ExampleChatResponse`
  - `ExampleHealthResponse`
  - `ExampleErrorResponse`
- For platform examples that need variation, import the shared base and extend
  it locally instead of redefining the whole object.
- Add `packages/examples/shared/runtime-contracts.ts` for local-app/browser
  sample types such as `ProviderMode`, `ProviderSettings`, `RuntimeBundle`, and
  `ExampleChatMessage`.
- For `cloud/examples/clone-ur-crush`, either import the real cloud
  `ElizaCharacter` type or explicitly mark the local type as a standalone
  snapshot and add a drift check against `cloud/packages/lib/types/eliza-character.ts`.

### `packages/benchmarks`

Findings:

- Python benchmark DTOs frequently reuse generic names with incompatible
  shapes:
  - `packages/benchmarks/standard/_base.py:63` has a canonical standard
    `BenchmarkResult`.
  - `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/types.py:299`
    defines a LifeOps-specific `BenchmarkResult`.
  - `packages/benchmarks/woobench/types.py:172`,
    `packages/benchmarks/experience/elizaos_experience_bench/types.py:158`,
    and `packages/benchmarks/trust/elizaos_trust_bench/types.py:124` define
    other incompatible `BenchmarkResult` shapes.
- `Scenario` and `ScenarioResult` are repeated across benchmark domains:
  - `lifeops-bench` uses rich LifeOps world state and scoring fields at
    `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/types.py:124` and
    `:280`.
  - `woobench` defines monetization/persona-specific versions at
    `packages/benchmarks/woobench/types.py:131` and `:156`.
  - `adhdbench` and `orchestrator_lifecycle` use the same names for different
    contracts.
- `LeaderboardComparison` is same-name but different-shape:
  - `packages/benchmarks/gaia/elizaos_gaia/types.py:139`
  - `packages/benchmarks/orchestrator/types.py:39`
  - `packages/benchmarks/terminal-bench/elizaos_terminal_bench/types.py:129`
  - `packages/benchmarks/vending-bench/elizaos_vending_bench/types.py:319`
- Adapter response contracts are true same-shape duplicates:
  - `packages/benchmarks/eliza-adapter/eliza_adapter/client.py:19`
  - `packages/benchmarks/hermes-adapter/hermes_adapter/client.py:54`
  - `packages/benchmarks/openclaw-adapter/openclaw_adapter/client.py:61`
  All define `MessageResponse` with `text`, `thought`, `actions`, and `params`.
- TypeScript framework metrics duplicate between the producer and comparison
  script:
  - `packages/benchmarks/framework/typescript/src/metrics.ts:53` defines
    `ScenarioResult` and `BenchmarkResult`.
  - `packages/benchmarks/framework/compare.ts:47` and `:64` redefine the same
    comparison input shape.
- `packages/benchmarks/lib/src/metrics-schema.ts:1` is already a good pattern:
  it documents a canonical Zod schema plus a Python mirror for LifeOpsBench
  artifacts. That pattern should be expanded selectively.

Recommendations:

- Introduce a benchmark artifact envelope in `packages/benchmarks/lib`:
  `BenchmarkArtifact`, `BenchmarkRunMetadata`, `ScoreSummary`, and
  `LeaderboardComparisonBase`.
- Keep domain-specific metric payloads separate, but rename generic classes to
  domain names such as `LifeOpsBenchmarkResult`, `WooBenchmarkResult`, and
  `TrustBenchmarkResult`.
- Move adapter `MessageResponse` into a shared Python module, for example
  `packages/benchmarks/lib/python/adapter_types.py`, and import it from the
  eliza, hermes, and openclaw adapters.
- Make `packages/benchmarks/framework/compare.ts` import the exported metrics
  types instead of redefining `ScenarioResult`, `SystemInfo`, and
  `BenchmarkResult`.
- Do not consolidate every `Scenario` into one type. These are domain objects,
  not a shared contract. Prefer explicit names and a shared envelope.

### `packages/inference`

Findings:

- Parent-repo tracked inference source has minimal TypeScript type surface:
  `packages/inference/verify/asr_bench.ts:195` defines `Utterance`, and
  `packages/inference/verify/asr_bench.ts:221` defines `BenchRow`.
- `packages/inference/llama.cpp` is an in-tree fork/submodule. It has many
  upstream Python, C/C++, and web UI contracts, but they should not be folded
  into elizaOS shared types.
- The submodule TS scan found only two same-name TS declaration cases:
  `Window` and `AttachmentDisplayItemsOptions`. The latter appears in the
  upstream web UI type file and utility implementation.

Recommendations:

- Do not consolidate upstream/fork-owned `llama.cpp` types into repo-local
  packages. Treat them as fork surface unless an elizaOS patch explicitly owns
  the file.
- If inference verification grows more JS/TS tooling, add a local
  `packages/inference/verify/types.ts` for bench output rows and ABI smoke
  result contracts.
- Keep generated/fixture reports out of contract ownership. They can validate
  contracts, but should not become source-of-truth type definitions.

### `packages/training`

Findings:

- The canonical training row shape is repeatedly named in script-local
  constants and conditionals:
  - `packages/training/scripts/format_for_training.py:42` defines
    `NATIVE_FORMAT = "eliza_native_v1"`.
  - `packages/training/scripts/format_for_training.py:67` defines
    `ELIZA1_TRAJECTORY_RECORD_SCHEMA`.
  - `packages/training/scripts/prepare_eliza1_trajectory_dataset.py:49`
    repeats `NATIVE_FORMAT`.
  - `packages/training/scripts/publish_eliza1_dataset_candidate.py:37`
    repeats `ELIZA1_TRAJECTORY_RECORD_SCHEMA` and branches over
    `eliza_native_v1`, `chat_messages_v1`, and `eliza_record_v1`.
- `packages/training/scripts/lib/native_record.py` and
  `packages/training/scripts/lib/eliza_record.py:115` are close to being the
  canonical row builders, but many callers still own shape detection and
  validation logic locally.
- `FilterStats` is used for different domains:
  - LifeOps privacy counters at
    `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/ingest/privacy.py:81`.
  - A fallback copy in
    `packages/training/scripts/prepare_eliza1_trajectory_dataset.py:83`.
  - Larger trajectory privacy audit counters in
    `packages/training/scripts/privacy_filter_trajectories.py:114`.
  - Judge-filter counters in
    `packages/training/scripts/synth/judge_filter.py:352`.
- `BucketResult` is duplicated across benchmark scoring scripts:
  - `packages/training/scripts/benchmark/native_tool_call_bench.py`
  - `packages/training/scripts/benchmark/native_tool_call_bench.py:41`
- Manifest staging scripts duplicate `StagedFile` exactly:
  - `packages/training/scripts/manifest/stage_real_eliza1_bundle.py:116`
  - `packages/training/scripts/manifest/stage_local_eliza1_bundle.py:117`

Recommendations:

- Make `packages/training/scripts/lib/native_record.py` the only owner for
  `NATIVE_FORMAT`, `ELIZA1_TRAJECTORY_RECORD_SCHEMA`, row builders, and basic
  row validators. Import these constants instead of repeating string literals.
- Rename domain-specific stats classes:
  - `PrivacyFilterStats` for LifeOps privacy counters.
  - `TrajectoryPrivacyStats` for stream-level privacy audit counters.
  - `JudgeFilterStats` for synthetic judge filtering.
  - `_FallbackPrivacyFilterStats` if the fallback copy must remain local.
- Move the exact `StagedFile` dataclass to a manifest helper module such as
  `packages/training/scripts/manifest/staging_types.py`.
- Move common bucket counters to a small benchmark helper only if the scripts
  continue to evolve together; otherwise rename the two classes to prevent
  accidental interchange.

### `cloud/apps/api`

Findings:

- Dynamic route handlers repeatedly define `RouteParams` and `RouteContext`:
  examples include `cloud/apps/api/compat/agents/[id]/route.ts:27`,
  `cloud/apps/api/v1/admin/docker-nodes/[nodeId]/route.ts:23`, and
  `cloud/apps/api/v1/eliza/google/calendar/events/[eventId]/route.ts:6`.
- OpenAI-compatible request DTOs are duplicated between route-local types and
  provider-library types:
  - `cloud/apps/api/v1/chat/completions/route.ts:92` defines `ChatMessage`.
  - `cloud/packages/lib/providers/types.ts:10` defines `OpenAIChatMessage`.
  - `cloud/apps/api/v1/embeddings/route.ts:27` defines `EmbeddingsRequest`.
  - `cloud/packages/lib/providers/types.ts:134` defines
    `OpenAIEmbeddingsRequest`.
- Zod request schemas repeat SDK request interfaces:
  - `cloud/apps/api/v1/credits/checkout/route.ts:21` has `CheckoutSchema`.
  - `cloud/apps/api/v1/app-credits/checkout/route.ts:21` has another
    `CheckoutSchema`.
  - `cloud/packages/sdk/src/types.ts:204` and `:225` define the corresponding
    SDK request interfaces.
- Calendar create and patch schemas share nearly all fields:
  - Create schema at `cloud/apps/api/v1/eliza/google/calendar/events/route.ts:25`.
  - Patch schema at
    `cloud/apps/api/v1/eliza/google/calendar/events/[eventId]/route.ts:16`.
- `cloud/apps/api/src/_router.generated.ts:1` is generated and correctly
  declares its source generator. This is generated duplication, not a manual
  consolidation target.

Recommendations:

- Add a route helper type, for example
  `RouteParams<K extends string> = { params: Promise<Record<K, string>> }`,
  plus `getRouteParam(ctx, key)`. Use it across dynamic Hono route files.
- Reuse `OpenAIChatMessage` and `OpenAIEmbeddingsRequest` from the provider
  contract module, or move both to a neutral `cloud/packages/types` contract.
  If the API route allows `content: null`, encode that difference in the shared
  type instead of redefining the entire message object.
- Export public route schemas or generated route request types from a single
  API-contract layer, then have the SDK consume that generated output instead
  of manually mirroring request interfaces.
- Extract shared Google Calendar request schema fragments (`attendeeSchema`,
  base event fields, create-required fields, patch-partial fields).

### `cloud/apps/frontend`

Findings:

- Frontend DTOs often mirror backend/service contracts:
  - `cloud/apps/frontend/src/dashboard/admin/_components/infrastructure-dashboard.tsx:135`
    defines `InfraContainer`.
  - `cloud/packages/lib/services/admin-infrastructure.ts:106` exports
    `AdminInfrastructureContainer` with the same key set and stronger status
    unions.
  - The same pattern repeats for `NodeRuntime`/`NodeRuntimeSnapshot`,
    `InfraNode`/`AdminInfrastructureNode`,
    `InfraIncident`/`AdminInfrastructureIncident`, and
    `InfraSnapshot`/`AdminInfrastructureSnapshot`.
- Dashboard summary types are mirrored:
  - `cloud/apps/frontend/src/dashboard/Page.tsx:19` defines `DashboardAgent`.
  - `cloud/packages/db/repositories/dashboard.ts:21` exports
    `DashboardAgent`.
  - `cloud/apps/frontend/src/dashboard/Page.tsx:30` defines
    `DashboardResponse`.
  - `cloud/packages/db/repositories/dashboard.ts:32` exports
    `DashboardSummary`.
- API key list DTOs are exact-shape duplicates:
  - `cloud/apps/frontend/src/lib/data/api-keys.ts:5` defines `ApiKeyRecord`.
  - `cloud/packages/lib/client/api-keys.ts:5` defines `ClientApiKey`.
- Pending document upload files have exact key duplication:
  - `cloud/apps/api/v1/documents/_worker-documents.ts:22`
  - `cloud/apps/frontend/src/components/chat/pending-documents-processor.tsx:6`

Recommendations:

- Prefer importing exported service/API DTOs into frontend data modules and
  components instead of hand-copying them.
- When frontend needs a narrower view model, derive it with `Pick`, `Omit`, or
  a named mapper type from the backend DTO.
- Move public frontend-consumed DTOs out of repository implementation modules
  such as `cloud/packages/db/repositories/*` and into `cloud/packages/lib/types`
  or `cloud/packages/types`.
- Keep component-only prop duplicates local when they are presentation details
  (`McpCardProps`, `SidebarProps`, etc.). Consolidating those would increase
  coupling without improving contract safety.

### `cloud/packages/lib`, `cloud/packages/sdk`, `cloud/packages/types`, `cloud/packages/db`

Findings:

- `cloud/packages/lib/types/cloud-api.ts` and
  `cloud/packages/sdk/src/types.cloud-api.ts` are byte-for-byte equivalent in
  content from the source scan perspective, and both are 536 lines. The SDK also
  has handwritten types in `cloud/packages/sdk/src/types.ts`.
- `cloud/packages/types/cloud-api.ts`, `.d.ts`, and `.js` re-export from
  `@/lib/types/cloud-api`, but `cloud/packages/types/package.json` only exports
  `./package.json`. This makes the intended contract package ambiguous.
- Generated API DTOs such as `AdminRole`, `AgentSandboxStatus`,
  `AppDeploymentStatus`, `UserDatabaseStatus`, and `CreditBalanceResponse`
  appear in cloud lib and SDK generated surfaces. This duplication is
  acceptable only if generated from one source and checked for freshness.
- JSON primitive/object/value types are repeated across:
  - `cloud/packages/lib/swagger/endpoint-discovery.ts`
  - `cloud/packages/lib/providers/cloud-provider-options.ts`
  - `cloud/packages/lib/services/proxy/types.ts`
  - `cloud/packages/sdk/src/types.ts`
  - `cloud/packages/tests/e2e/helpers/json-body.ts`
  - `cloud/services/agent-server/src/handlers/event.ts`
- DB schema inferred types are a reasonable source for persistence contracts,
  but they should not be copied into frontend or SDK DTOs without a mapper or
  generated API boundary type.

Recommendations:

- Make `cloud/packages/types` the actual exported source of shared cloud
  contract types, or remove it and make `cloud/packages/lib/types/cloud-api.ts`
  the explicit source. The current re-export package shape is unclear.
- Generate `cloud/packages/sdk/src/types.cloud-api.ts` from the selected source
  during SDK build and add a `--check` mode in CI.
- Put `JsonPrimitive`, `JsonValue`, and `JsonObject` in one shared cloud type
  module. Tests can import it instead of redefining it.
- Keep DB `$inferSelect` types inside persistence/repository code. Public API
  DTOs should be generated or mapped, not casually aliased to DB rows.

### `cloud/services`

Findings:

- Gateway services duplicate small infrastructure contracts:
  - `cloud/services/gateway-webhook/src/hash-router.ts:7` defines `RingState`.
  - `cloud/services/gateway-discord/src/hash-router.ts:7` defines the same
    shape.
  - Both files define `EndpointSliceList` with the same Kubernetes response
    shape.
- Service loggers duplicate `LogLevel` and level maps:
  - `cloud/services/gateway-webhook/src/logger.ts:5`
  - `cloud/services/gateway-discord/src/logger.ts:5`
  - `cloud/services/agent-server/src/logger.ts:9`
- `cloud/services/agent-server/src/handlers/event.ts:34` defines JSON types and
  an `EventBodySchema`; these overlap with cloud JSON helper types elsewhere.

Recommendations:

- Extract deploy-safe service utilities into a small shared module, for example
  `cloud/services/shared` or `cloud/packages/lib/services/runtime-utils`.
- Consolidate `LogLevel` and logger setup if service bundle constraints allow a
  workspace import. If services are intentionally standalone deploy units,
  keep local code but add a note that the duplication is deployment-driven.
- Reuse the shared cloud JSON type for agent event payloads, while keeping the
  Zod validator local to the handler or exporting it as the event contract.

### `cloud/examples`

Findings:

- `cloud/examples/clone-ur-crush/types/index.ts:2` duplicates a large subset of
  `ElizaCharacter` from `cloud/packages/lib/types/eliza-character.ts:13`.
- Its `ChatMessage` shape at `cloud/examples/clone-ur-crush/types/index.ts:56`
  matches the common `{ id, role, content, timestamp }` message shape also seen
  in `packages/examples/next/app/page.tsx:12`.

Recommendations:

- If cloud examples are meant to run inside the monorepo, import cloud contract
  types directly.
- If they are meant to be copied out as standalone starter apps, keep local
  type snapshots but add a generated comment and drift test against the source
  cloud contract.

## Generated And Test-Only Duplicates

Generated or generated-like contracts:

- `cloud/apps/api/src/_router.generated.ts` is generated from
  `cloud/apps/api/src/_generate-router.mjs`.
- `cloud/services/operator/capabilities/crd/generated/server-v1alpha1.ts`
  contains generated Kubernetes CRD DTOs such as `AgentRef`, `ServerSpec`, and
  `ServerStatus`.
- `cloud/packages/lib/types/cloud-api.ts` and
  `cloud/packages/sdk/src/types.cloud-api.ts` are generated/mirrored API DTO
  surfaces.
- `packages/examples/convex/convex/_generated/**` and similar framework
  generated example files are not manual consolidation targets.

Recommendations for generated contracts:

- Keep generated files, but add deterministic generation checks where missing.
- Never hand-edit generated mirrors to fix type drift. Fix the source schema or
  generator.
- Generated API DTOs should identify their source in a header and be checked in
  CI with a command analogous to `generate:routes --check`.

Test-only duplicates:

- `Story` aliases in `cloud/packages/ui/src/components/*.stories.tsx` are
  idiomatic and should stay local.
- `Harness` interfaces in `cloud/packages/tests/unit/*.test.ts` are mostly
  test-local fixture shapes. Extract only when several tests share identical
  setup objects and helpers.
- `cloud/packages/tests/e2e/helpers/json-body.ts:1` duplicates JSON primitive
  types. This can import shared JSON types after those exist, but this is
  lower priority than API/SDK/frontend contract drift.

## Consolidation Plan

Recommended order:

1. Cloud API contract source:
   - Decide whether `cloud/packages/types` or `cloud/packages/lib/types` owns
     public cloud DTOs.
   - Generate SDK cloud API types from that source.
   - Add a freshness check.
2. Cloud route/frontend DTO cleanup:
   - Add route param helper types.
   - Replace route-local OpenAI-compatible DTOs with shared provider/API
     types.
   - Import frontend DTOs from cloud API/service contracts where the key set is
     already identical.
3. Example contract cleanup:
   - Add shared sample chat/runtime contracts.
   - Make platform examples extend shared bases.
4. Benchmark contract cleanup:
   - Add shared benchmark artifact/adapter contracts in `packages/benchmarks/lib`.
   - Rename benchmark-specific generic DTOs.
5. Training schema cleanup:
   - Centralize native row constants and manifest staging dataclasses.
   - Rename stats classes by domain.
6. Leave-alone list:
   - Storybook `Story` aliases.
   - Test-local harnesses unless helper extraction reduces real duplication.
   - `llama.cpp` upstream/fork types unless changed by an explicit elizaOS
     patch.

## Risk Notes

- The highest risk is cloud public contract drift: API route validators,
  frontend consumers, SDK types, and generated cloud API DTOs can disagree
  silently unless they share a generated source.
- Benchmark same-name classes are confusing but not always unsafe. Many are
  domain-specific and should be renamed rather than merged.
- Example duplicates are low runtime risk but high documentation risk because
  users copy examples into real projects.
- Inference submodule duplication is low priority for repo hardening because it
  is fork/upstream-owned.
