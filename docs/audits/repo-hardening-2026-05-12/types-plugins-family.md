# Type Duplication Audit - Plugins Family

Workspace: `/Users/shawwalters/eliza-workspace/milady/eliza`
Date: 2026-05-12
Mode: dry run / report only

No source files were edited. This pass only writes this audit document.

## Scope

Detailed pass:

- `plugins/app-lifeops`
- `plugins/plugin-health`
- `plugins/plugin-discord`
- `plugins/plugin-wallet`
- `plugins/plugin-local-ai`
- `plugins/plugin-browser`
- `plugins/plugin-sql`
- `plugins/plugin-social-alpha`

Broad scan:

- Top-level `plugins/app-*` and `plugins/plugin-*` packages, to identify
  repeated type-family patterns outside the detailed set.

## Guardrails

The LifeOps / Health invariants from `AGENTS.md` and the plugin READMEs are
hard constraints:

- Keep one task primitive: `ScheduledTask`.
- Keep one runner:
  `plugins/app-lifeops/src/lifeops/scheduled-task/runner.ts`.
- Keep one graph model: `EntityStore` and `RelationshipStore`. Cadence stays
  on relationship edges.
- Health remains a separate plugin. LifeOps may consume its public exports and
  registry contributions, but must not import Health internals.
- Connector/channel dispatch uses typed `DispatchResult`, not boolean.
- Runner behavior is structural; no behavior from `promptInstructions` text.

## Methodology

Read-only commands used:

```sh
rg --files plugins/app-lifeops plugins/plugin-health plugins/plugin-discord \
  plugins/plugin-wallet plugins/plugin-local-ai plugins/plugin-browser \
  plugins/plugin-sql plugins/plugin-social-alpha

rg -n 'contract-stubs|wave1-types|DispatchResult|ScheduledTask|DefaultPack|ConnectorContribution|LifeOpsBrowserSession|LifeOpsEntity|LifeOpsGraphRelationship' \
  plugins/app-lifeops/src plugins/plugin-health/src plugins/plugin-browser/src

node '<regex inventory of exported interface/type definitions; grouped by duplicate names, identical bodies, and same member keys>'

diff -u packages/shared/src/contracts/lifeops.ts \
  plugins/plugin-health/src/contracts/lifeops.ts
```

The focused regex inventory found 3,242 type/interface definitions across 1,163
TypeScript files in the detailed package set:

| Package | Type defs | Unique names | Files scanned | Cross-package duplicate names |
| --- | ---: | ---: | ---: | ---: |
| `plugins/app-lifeops` | 1,553 | 1,463 | 346 | 42 |
| `plugins/plugin-health` | 480 | 480 | 23 | 40 |
| `plugins/plugin-wallet` | 573 | 552 | 102 | 9 |
| `plugins/plugin-discord` | 196 | 185 | 44 | 3 |
| `plugins/plugin-sql` | 174 | 132 | 49 | 1 |
| `plugins/plugin-browser` | 122 | 119 | 15 | 7 |
| `plugins/plugin-social-alpha` | 117 | 111 | 20 | 7 |
| `plugins/plugin-local-ai` | 28 | 28 | 10 | 0 |

## Executive Findings

1. The highest-risk duplication is the LifeOps / Health contract family:
   `ScheduledTask`, `DefaultPack`, `DispatchResult`, connector registries,
   entity/relationship DTOs, and browser-session DTOs are copied across
   `app-lifeops`, `plugin-health`, `plugin-browser`, and `packages/shared`.

2. Several Wave-1 stub files are still active import targets:
   `plugins/app-lifeops/src/default-packs/contract-stubs.ts`,
   `plugins/app-lifeops/src/lifeops/wave1-types.ts`,
   `plugins/plugin-health/src/default-packs/contract-stubs.ts`, and
   `plugins/plugin-health/src/connectors/contract-stubs.ts`.

3. The canonical `ScheduledTask` type now has `executionProfile`, but the
   older copies do not. That is real contract drift:
   `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:220` vs
   `plugins/app-lifeops/src/lifeops/wave1-types.ts:78` and
   `plugins/plugin-health/src/default-packs/contract-stubs.ts:92`.

4. `plugins/plugin-health/src/contracts/lifeops.ts` is a near-copy of
   `packages/shared/src/contracts/lifeops.ts`, but it has already drifted:
   it lacks shared `apple_calendar` connector/calendar support and the
   open `LifeOpsBusFamily` type. This is a worse state than either vendoring
   intentionally or importing a canonical public contract.

5. `plugin-browser` owns a generic browser bridge contract, but the same
   LifeOps browser-session/action shapes are also present in Health/shared
   contracts and app-lifeops service facades.

6. `plugin-wallet` and `plugin-social-alpha` duplicate market-data DTOs,
   especially `TokenTradeData` and wallet portfolio item shapes.

7. `plugin-social-alpha` has same-name type drift between manual interfaces
   in `types.ts` and Zod-derived types in `schemas.ts`.

8. The broader plugin family repeats credential-provider, message-connector,
   route-context, and model-adapter result shapes. Those are not all in the
   detailed package set, but they should be follow-up consolidation families.

## Package Findings

### `plugins/app-lifeops`

#### ScheduledTask copies

Evidence:

- Canonical runner contract:
  `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:220`
- Old Wave-1 mirror:
  `plugins/app-lifeops/src/lifeops/wave1-types.ts:78`
- Default-pack stub:
  `plugins/app-lifeops/src/default-packs/contract-stubs.ts:133`
- Health default-pack copy:
  `plugins/plugin-health/src/default-packs/contract-stubs.ts:92`

Drift:

- Canonical `ScheduledTask` includes optional `executionProfile` at
  `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:220`.
- The Wave-1/default-pack/Health copies do not.
- `ScheduledTaskRef` also differs: the canonical type is
  `string | ScheduledTask`, while app default-pack stubs allow
  `string | ScheduledTask | ScheduledTaskSeed`.

Recommendation:

- Keep `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts` as the
  in-package runtime owner.
- Introduce a public type-only export for scheduleable pack records, rather
  than keeping `wave1-types.ts`.
- Decide whether inline pipeline child seeds are real API. If yes, update the
  canonical `ScheduledTaskRef`; if no, remove that extension from default-pack
  stubs.
- Update the frozen docs if `executionProfile` is public, or clearly mark it as
  an internal persisted-runner extension.

#### DefaultPack and registry stubs

Evidence:

- App envelope:
  `plugins/app-lifeops/src/default-packs/registry-types.ts:25`
- App stub envelope:
  `plugins/app-lifeops/src/default-packs/contract-stubs.ts:177`
- Health stub envelope:
  `plugins/plugin-health/src/default-packs/contract-stubs.ts:177`

Recommendation:

- Keep one `DefaultPack` envelope and make both LifeOps and Health consume it.
- The owner should be a public contract module, not a Health internal and not a
  LifeOps runtime-internal path. This preserves Health's soft-dependency
  posture while removing copy drift.
- Keep pack behavior structural: pack records are `ScheduledTask` seeds only.
  Do not add a second pack/task primitive.

#### Connector and channel contracts

Evidence:

- Canonical LifeOps connector contract:
  `plugins/app-lifeops/src/lifeops/connectors/contract.ts:38`
  (`DispatchResult`) and `:67` (`ConnectorContribution`)
- Health connector stub:
  `plugins/plugin-health/src/connectors/contract-stubs.ts:21`
  (`DispatchResult`) and `:49` (`ConnectorContribution`)
- Channel contract reuses connector `DispatchResult`:
  `plugins/app-lifeops/src/lifeops/channels/contract.ts:10`

Recommendation:

- Extract a neutral public registry/dispatch contract for:
  `DispatchResult`, `ConnectorContribution`, `ConnectorRegistry`,
  `AnchorContribution`, `AnchorRegistry`, `BusFamilyContribution`, and
  `FamilyRegistry`.
- Health can then contribute by importing that public contract without importing
  LifeOps internals.
- Keep `verify(): Promise<boolean>` distinct from dispatch. The AGENTS
  no-boolean rule applies to connector/channel dispatch, not status probes.

#### Entity / relationship and graph-like contracts

Evidence:

- Canonical entity:
  `plugins/app-lifeops/src/lifeops/entities/types.ts:95`
- Canonical relationship:
  `plugins/app-lifeops/src/lifeops/relationships/types.ts:59`
- Public DTO copies in Health/shared contract:
  `plugins/plugin-health/src/contracts/lifeops.ts:4232` and `:4262`
- Legacy relationship DTO:
  `plugins/plugin-health/src/contracts/lifeops.ts:3804`
- App LifeOps legacy relationship mixin projects writes into the graph:
  `plugins/app-lifeops/src/lifeops/service-mixin-relationships.ts:9`
- Separate context graph class:
  `plugins/app-lifeops/src/lifeops/context-graph.ts:1140`

Recommendation:

- Do not create another graph store. Treat `LifeOpsContextGraph` as either an
  ephemeral projection/query index or migrate it behind `EntityStore` /
  `RelationshipStore`.
- Public DTOs should be aliases/projections from the canonical entity and
  relationship contracts. Duplicated DTOs are acceptable only as compatibility
  surfaces with explicit deprecation windows.
- Keep cadence-bearing tasks on `subject.kind = "relationship"`.

#### Browser, iMessage, WhatsApp, permission DTOs

Evidence:

- Browser service facade in app-lifeops:
  `plugins/app-lifeops/src/lifeops/service-mixin-browser.ts:69`
- Plugin-browser route service:
  `plugins/plugin-browser/src/service.ts:26`
- iMessage request/message/chat in app:
  `plugins/app-lifeops/src/lifeops/service-mixin-imessage.ts:78`
- iMessage public DTO copy:
  `plugins/plugin-health/src/contracts/lifeops.ts:4159`
- WhatsApp send request appears in app runtime delegates, app WhatsApp mixin,
  and public LifeOps contracts:
  `plugins/app-lifeops/src/lifeops/runtime-service-delegates.ts:9`,
  `plugins/app-lifeops/src/lifeops/service-mixin-whatsapp.ts:24`,
  `plugins/plugin-health/src/contracts/lifeops.ts:3135`
- Website/app permission status shapes:
  `plugins/app-lifeops/src/website-blocker/permissions.ts:1`,
  `plugins/plugin-health/src/contracts/permissions.ts:14`,
  `plugins/app-lifeops/src/app-blocker/types.ts:7`

Recommendation:

- Move browser bridge/session types to the browser plugin's public contract
  surface, then have LifeOps import/alias them.
- Move connector-specific DTO ownership to the connector plugin when a plugin
  exists (`plugin-browser`, `plugin-whatsapp`, `plugin-imessage`), and keep
  LifeOps request types as compatibility aliases.
- Move generic system permission types out of Health. Health should not be the
  owner of app/website/browser permissions.

#### Exact duplicate utility contract

Evidence:

- `plugins/app-lifeops/src/lifeops/token-encryption.ts:30`
- `plugins/plugin-health/src/util/token-encryption.ts:30`

The files are byte-identical.

Recommendation:

- Move token encryption to a shared internal utility or `packages/vault`.
- Both LifeOps and Health should import it. Do not keep two encryption envelope
  definitions.

### `plugins/plugin-health`

#### Over-broad local LifeOps contract copy

Evidence:

- Local copy:
  `plugins/plugin-health/src/contracts/lifeops.ts`
- Shared copy:
  `packages/shared/src/contracts/lifeops.ts`
- Health re-export surface:
  `plugins/plugin-health/src/contracts/health.ts:8`

Drift found by `diff`:

- Shared includes `apple_calendar` in `LIFEOPS_CONNECTOR_PROVIDERS`; Health
  copy does not.
- Shared includes `LifeOpsBusFamily = LifeOpsTelemetryFamily | string`; Health
  copy does not.
- Shared calendar provider supports `"google" | "apple_calendar"`; Health copy
  narrows calendar provider to `"google"`.

Recommendation:

- Shrink `plugin-health/src/contracts/lifeops.ts` to health-owned contracts
  only: health connectors, health metrics, sleep/circadian, screen-time,
  health signal filters, and health REST request/response envelopes.
- Import public non-health LifeOps contracts from a canonical package instead
  of vendoring the whole file.
- If vendoring is intentional for plugin independence, add a generation script
  and CI diff gate. A silent fork is the worst option.

#### Connector/default-pack stubs

Evidence:

- `plugins/plugin-health/src/connectors/contract-stubs.ts:21`
- `plugins/plugin-health/src/default-packs/contract-stubs.ts:92`
- Active imports from Health packs and connector registration:
  `plugins/plugin-health/src/default-packs/bedtime.ts:13`,
  `plugins/plugin-health/src/connectors/index.ts:33`

Recommendation:

- Keep Health decoupled from LifeOps internals by importing a neutral public
  registry contract, not by copying stubs.
- Keep the Health default packs as `DefaultPack` contributions that produce
  `ScheduledTask` seeds; do not add Health-specific scheduled task shapes.

#### Non-health DTOs in Health contracts

Evidence:

- Discord DM probe DTOs:
  `plugins/plugin-health/src/contracts/lifeops.ts:2880`
- Browser action/session DTOs:
  `plugins/plugin-health/src/contracts/lifeops.ts:912` and `:3616`
- iMessage DTOs:
  `plugins/plugin-health/src/contracts/lifeops.ts:4159`
- Entity/relationship DTOs:
  `plugins/plugin-health/src/contracts/lifeops.ts:4232` and `:4262`

Recommendation:

- Do not keep non-health connector/application DTOs under `plugin-health`.
- Move or alias them from their owning plugin/shared contract modules.
- Preserve Health's public exports for existing consumers during a deprecation
  window, but make them type-only re-exports.

### `plugins/plugin-browser`

#### Generated declarations checked into `src`

Evidence:

- `plugins/plugin-browser/src/contracts.ts`
- `plugins/plugin-browser/src/contracts.d.ts`
- `plugins/plugin-browser/src/lifeops-session-contracts.ts`
- `plugins/plugin-browser/src/lifeops-session-contracts.d.ts`
- Many other `src/**/*.d.ts` files are present.

Recommendation:

- Do not keep build-emitted declarations beside source unless they are authored
  ambient declarations.
- Move generated declarations to build output or remove them from source
  control. Keep authored ambient files such as `ambient-jsdom.d.ts` if needed.

#### Browser session/action duplication

Evidence:

- Browser-owned LifeOps browser session:
  `plugins/plugin-browser/src/lifeops-session-contracts.ts:11`
- Health/shared LifeOps browser session:
  `plugins/plugin-health/src/contracts/lifeops.ts:3616`
- Browser bridge action:
  `plugins/plugin-browser/src/contracts.ts:66`
- LifeOps browser action copy:
  `plugins/plugin-health/src/contracts/lifeops.ts:912`
- Progress update request copies:
  `plugins/plugin-browser/src/contracts.ts:282`,
  `plugins/plugin-health/src/contracts/lifeops.ts:3658`

Recommendation:

- Make `plugin-browser` the owner of browser bridge action/session contracts.
- If LifeOps needs branded names (`LifeOpsBrowserAction`), export aliases from
  the browser public contract instead of copying members.
- Keep ownership/request policy fields as LifeOps-specific wrappers around the
  browser primitive rather than duplicating browser primitive fields.

#### Route context/service facade duplication

Evidence:

- Browser route context:
  `plugins/plugin-browser/src/routes/bridge.ts:47`
- LifeOps route context:
  `plugins/app-lifeops/src/routes/lifeops-routes.ts:95`
- Browser route service:
  `plugins/plugin-browser/src/service.ts:26`
- LifeOps browser service facade:
  `plugins/app-lifeops/src/lifeops/service-mixin-browser.ts:69`

Recommendation:

- Extract a shared plugin route context helper for `req/res/method/pathname/url`
  plus `json/error/readJsonBody/decodePathComponent`.
- Let LifeOps facade narrow owner/runtime scoping, but import method signatures
  from the browser route service where possible.

### `plugins/plugin-discord`

#### Same-name config drift

Evidence:

- Full config types:
  `plugins/plugin-discord/config.ts:36`,
  `plugins/plugin-discord/config.ts:53`,
  `plugins/plugin-discord/config.ts:144`
- Runtime account config copies:
  `plugins/plugin-discord/accounts.ts:24`,
  `plugins/plugin-discord/accounts.ts:64`,
  `plugins/plugin-discord/accounts.ts:80`

Drift:

- `DiscordAccountConfig` in `config.ts` has newer fields such as
  `capabilities`, markdown/command settings, block streaming, chunking, and
  other account-level options.
- `accounts.ts` defines a narrower same-name interface and adds older
  compatibility booleans such as `shouldIgnoreDirectMessages`.

Recommendation:

- Keep `config.ts` as the authored config schema.
- Rename the runtime-normalized account shape in `accounts.ts` to something
  explicit, such as `ResolvedDiscordAccountConfig`.
- Derive it from `DiscordAccountConfig` where possible instead of repeating
  same-name fields.

#### Discord browser probe duplicated into LifeOps contracts

Evidence:

- Browser scraper DTOs:
  `plugins/plugin-discord/user-account-scraper/discord-browser-scraper.ts:40`
  and `:49`
- LifeOps contract copies:
  `plugins/plugin-health/src/contracts/lifeops.ts:2880` and `:2889`

Recommendation:

- Make the Discord plugin export its browser probe DTOs.
- LifeOps/Health/shared contracts can expose compatibility aliases, but the
  source of truth should live with the Discord browser scraper.

#### Small local duplicates

Evidence:

- `DiscordListenChannelPayload` and `DiscordNotInChannelsPayload` share the
  same `runtime/message/source/accountId` keys with different `message` types:
  `plugins/plugin-discord/types.ts:81` and `:88`.
- `PendingEntry` and `ChannelPendingEntry` are identical:
  `plugins/plugin-discord/debouncer.ts:13` and `:46`.

Recommendation:

- These are low-risk local cleanup candidates. Prefer a generic helper only if
  it simplifies code; do not churn them ahead of the config contract drift.

### `plugins/plugin-wallet`

#### Birdeye response wrappers

Evidence:

- Generic wrapper exists:
  `plugins/plugin-wallet/src/analytics/birdeye/types/api/common.ts:88`
- Many endpoint-specific responses repeat `{ success; data }`, e.g.
  `plugins/plugin-wallet/src/analytics/birdeye/types/api/token.ts:12`,
  `:46`, `:68`, `:107`, `:323`, `:344`, `:418`, `:441`, `:459`.

Recommendation:

- Use `BirdeyeApiResponseWrapper<T>` for endpoint responses.
- Keep endpoint names as aliases:
  `type TokenOverviewResponse = BirdeyeApiResponseWrapper<TokenOverviewData>`.
- This gives endpoint-level readability without duplicating the wire envelope.

#### Wallet/social market-data duplication

Evidence:

- Wallet `TokenTradeData`:
  `plugins/plugin-wallet/src/analytics/birdeye/types/api/common.ts:120`
- Social Alpha `TokenTradeData`:
  `plugins/plugin-social-alpha/src/types.ts:517`
- Wallet portfolio item:
  `plugins/plugin-wallet/src/chains/solana/types.ts:3`
- Social Alpha wallet portfolio item:
  `plugins/plugin-social-alpha/src/types.ts:806`

Recommendation:

- Make wallet/Birdeye market data a public wallet analytics contract.
- `plugin-social-alpha` should import the wallet DTO or define a deliberately
  smaller projection type.
- Do not duplicate the full 184-field `TokenTradeData` in Social Alpha.

#### Chain/DEX position shape duplication

Evidence:

- Orca:
  `plugins/plugin-wallet/src/chains/solana/dex/orca/providers/positionProvider.ts:18`
- Raydium:
  `plugins/plugin-wallet/src/chains/solana/dex/raydium/providers/positionProvider.ts:61`

Recommendation:

- Introduce a shared CLMM position-statistics base with pool/position IDs,
  in-range flag, distance BPS, and width BPS.
- Let each DEX adapter map its native identifier names into that common shape.

#### Suppression signal

Evidence:

- Several wallet analytics/DEX files begin with `@ts-nocheck`, e.g.
  `plugins/plugin-wallet/src/analytics/birdeye/types/api/token.ts:1` and
  `plugins/plugin-wallet/src/chains/solana/dex/orca/providers/positionProvider.ts:1`.

Recommendation:

- Consolidate wire DTOs before removing suppressions. The suppressions appear
  to be symptoms of absorbed plugin type drift, not isolated lint problems.

### `plugins/plugin-social-alpha`

#### Same-name manual-vs-Zod type drift

Evidence:

- Manual interfaces/types:
  `plugins/plugin-social-alpha/src/types.ts:142` (`RecommenderMetrics`),
  `:198` (`TokenPerformance`), `:262` (`TokenRecommendation`),
  `:285` (`Position`), `:320` (`Transaction`),
  `:490` (`MessageRecommendation`)
- Zod-derived same-name exports:
  `plugins/plugin-social-alpha/src/schemas.ts:156` through `:159`,
  and `:335`

Drift examples:

- Manual `RecommenderMetrics` has `platform`, `failedTrades`,
  `totalProfit`, `lastUpdated`, `createdAt`.
- Zod `recommenderMetricsSchema` has `riskScore`, `virtualConfidence`,
  `lastActiveDate`, `trustDecay`, `updatedAt`.
- Manual `Transaction` stores `amount` and `price` as strings/date fields;
  schema parses numeric amount and ISO timestamp, then converts through
  `toTransaction()`.

Recommendation:

- Make `schemas.ts` the runtime-validation owner and export domain types from
  the schemas.
- If database rows differ from domain objects, name them explicitly:
  `RecommenderMetricsRow`, `TransactionRow`, `TokenRecommendationRow`.
- Remove same-name imports that can accidentally bind to the wrong shape.

#### Wallet analytics duplication

Evidence:

- Social Alpha full `TokenTradeData` copy:
  `plugins/plugin-social-alpha/src/types.ts:517`
- Social Alpha wallet portfolio:
  `plugins/plugin-social-alpha/src/types.ts:806`
- Wallet counterparts:
  `plugins/plugin-wallet/src/analytics/birdeye/types/api/common.ts:120`,
  `plugins/plugin-wallet/src/chains/solana/types.ts:3`

Recommendation:

- Depend on wallet analytics public DTOs for shared market data.
- Keep Social Alpha-specific trust/recommendation types local.

#### Simulation compatibility surface

Evidence:

- Back-compat simulation re-export/stub:
  `plugins/plugin-social-alpha/src/simulationActors.ts:1`
- New simulation types:
  `plugins/plugin-social-alpha/src/services/simulationRunner.ts:31`,
  `:40`, `:60`, `:88`, `:100`, `:118`

Recommendation:

- Keep the compatibility file only if benchmark imports still require it.
- Prefer type-only re-exports from the new simulation modules, and avoid adding
  new compatibility-specific shapes.

### `plugins/plugin-local-ai`

Findings:

- No cross-package duplicate type names were found in the detailed focused
  scan.
- The main duplicative contract is conceptual: local `ToolCallResult` mirrors
  the core model tool-call shape.

Evidence:

- Local tool-call result:
  `plugins/plugin-local-ai/structured-output.ts:14`
- Core tool-call shape:
  `packages/core/src/types/model.ts:260`

Recommendation:

- Return/import `ToolCall` from `@elizaos/core` or define
  `type ToolCallResult = ToolCall` with a narrow adapter if stricter
  `arguments: Record<string, unknown>` is required.
- Keep model specification types local. `ModelSpec`, `VisionModelSpec`, and
  `TTSModelSpec` in `plugins/plugin-local-ai/types.ts:6` through `:49` are
  package-owned configuration, not shared contract duplication.

### `plugins/plugin-sql`

#### Runtime migrator schema and row shapes

Evidence:

- Canonical runtime-migrator schema/row types:
  `plugins/plugin-sql/src/runtime-migrator/types.ts:27` through `:178`
- Local Drizzle pseudo-types inside snapshot generation:
  `plugins/plugin-sql/src/runtime-migrator/drizzle-adapters/snapshot-generator.ts:225`
  through `:340`

Recommendation:

- Keep adapter-private pseudo-types local if they are one-file shims over
  unexported Drizzle internals.
- If another adapter needs the same pseudo-types, move them into
  `runtime-migrator/types.ts` under names like `DrizzleIndexShape`.

#### Connector credential store as a consolidation target

Evidence:

- `plugins/plugin-sql/src/connector-credential-store.ts:3` through `:38`

Broad scan found repeated connector credential ref shapes in
`plugin-google`, `plugin-slack`, `plugin-calendly`, `plugin-github`, and
`plugin-x`.

Recommendation:

- Promote `ConnectorCredentialStore`, `ConnectorCredentialVault`, and
  `ConnectorPasswordManagerReference` to a shared connector-credential contract
  if SQL is the persistence owner.
- Then migrate provider plugins away from hand-rolled credential ref metadata.

#### Messaging `Channel` naming

Evidence:

- Persistence channel:
  `plugins/plugin-sql/src/stores/messaging.store.ts:47`
- LifeOps channel contribution:
  `plugins/app-lifeops/src/lifeops/channels/contract.ts:21`

Recommendation:

- Do not merge these. They are different concepts.
- Rename or namespace if confusion grows: `MessagingChannelRow` vs
  `ChannelContribution`.

## Broader Plugin/App Family Patterns

These appeared in the broad scan beyond the detailed package set.

| Family | Packages / examples | Recommendation |
| --- | --- | --- |
| Credential provider results | `plugin-bluesky`, `plugin-farcaster`, `plugin-bluebubbles`, `plugin-line`, `plugin-twitch`, `plugin-slack`, `plugin-signal`, `plugin-whatsapp`, `plugin-google-chat`, `plugin-instagram`, `plugin-matrix`, `plugin-x` all repeat `CredentialProviderResult`-style shapes. | Add a shared connector credential provider result contract. |
| Message connector registration | `plugin-bluebubbles`, `plugin-line`, `plugin-slack`, `plugin-signal`, `plugin-imessage`, `plugin-telegram`, `plugin-feishu`, `plugin-whatsapp`, `plugin-google-chat`, `plugin-instagram`, `plugin-matrix`, `plugin-discord`. | Add a neutral message connector SDK contract for registration, fetch/read params, send handlers, and setup states. |
| Model adapter result types | `plugin-openrouter`, `plugin-groq`, `plugin-mlx`, `plugin-lmstudio`, `plugin-local-ai`, `plugin-xai`, `plugin-ollama`, `plugin-anthropic`, `plugin-openai`, `plugin-google-genai`. | Prefer core `GenerateTextResult`, `ToolCall`, `TokenUsage`, and shared native-stream result types. |
| Route contexts | `app-babylon`, `app-2004scape`, `app-clawville`, `app-screenshare`, `app-lifeops`, `plugin-browser`, `app-training`, `app-documents`, `plugin-agent-orchestrator`. | Extract a small plugin route utility/context contract. |
| App-training runtime/service facades | `app-training` repeats `RuntimeLike` / `TrajectoryServiceLike` shapes across service and cron files. | Promote to app-training internal contracts or import core service interfaces. |
| Wallet price DTO consumers | `app-companion`, `app-steward`, `plugin-social-alpha`, `plugin-wallet` repeat `DexScreenerPair`/price shapes. | Make wallet/dexscreener DTOs public and reuse them. |

## Consolidation Plan

### P0 - Stop contract drift

1. Pick public owners for:
   - `ScheduledTask` / `ScheduledTaskSeed`
   - `DefaultPack`
   - `DispatchResult` / connector registry / anchor registry / family registry
   - Browser bridge action/session
   - Entity/Relationship public DTO projections
2. Convert current stubs to type-only re-exports.
3. Add CI grep to prevent new imports from `contract-stubs.ts` and
   `wave1-types.ts` after migration.

### P1 - Reduce package-specific duplicates

1. Collapse `plugin-health/src/contracts/lifeops.ts` into narrow health-owned
   contracts plus imports/re-exports from canonical public contracts.
2. Make `plugin-browser` the source of browser bridge/session DTOs.
3. Make `plugin-discord/config.ts` the source of Discord configuration and
   rename normalized runtime configs.
4. Make `plugin-wallet` the source of wallet/Birdeye market-data DTOs and
   make `plugin-social-alpha` import or project from them.
5. Make `plugin-social-alpha/schemas.ts` the source for runtime-validated
   domain types.

### P2 - Broader family cleanup

1. Create shared connector credential/provider contracts.
2. Create shared message connector SDK types.
3. Create shared plugin route context utilities.
4. Normalize model adapter result/usage/tool-call types on core contracts.

## Validation Gates

Minimum validation after an implementation pass:

```sh
rg -n 'contract-stubs|wave1-types' plugins/app-lifeops/src plugins/plugin-health/src

bun run --cwd plugins/app-lifeops test
bun run --cwd plugins/app-lifeops lint:default-packs
bun run --cwd plugins/plugin-health test
bun run --cwd plugins/plugin-browser build
bun run --cwd plugins/plugin-discord test
bun run --cwd plugins/plugin-wallet test
bun run --cwd plugins/plugin-social-alpha test
bun run --cwd plugins/plugin-sql test
bun run typecheck
```

LifeOps/Health-specific verification should also include:

```sh
rg -n 'promptInstructions' plugins/app-lifeops/src/lifeops/scheduled-task
rg -n 'Promise<boolean>|return true|return false' \
  plugins/app-lifeops/src/lifeops/connectors \
  plugins/app-lifeops/src/lifeops/channels \
  plugins/plugin-health/src/connectors
```

The boolean scan is a review aid only: `verify(): Promise<boolean>` is
allowed; dispatch must return `DispatchResult`.

