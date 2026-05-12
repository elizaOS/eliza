# Type duplication audit: core package family

Date: 2026-05-12

Scope:

- `packages/core/src`
- `packages/shared/src`
- `packages/agent/src`
- `packages/app-core/src`
- `packages/ui/src`
- `packages/app/src`
- `packages/elizaos/src`
- `packages/vault/src`
- `packages/cloud-routing/src`

Generated/build/test/story trees were excluded: `dist`, `node_modules`, `.vite`,
`.turbo`, `coverage`, `__tests__`, `test`, `tests`, `stories`, `*.test.*`,
`*.spec.*`, `*.stories.*`, and `*.d.ts`.

Method:

- Parsed TypeScript/TSX with the TypeScript compiler API.
- Extracted `interface`, object-literal `type`, union `type`, and public class
  declarations.
- Compared same-name declarations, exact member signatures, same key sets, and
  exact union type text.
- Used direct `cmp`/`diff` checks for suspected whole-file mirrors.

Scan size:

| package | source files scanned | declarations | object/member shapes |
| --- | ---: | ---: | ---: |
| `packages/core` | 548 | 2254 | 1581 |
| `packages/shared` | 155 | 1189 | 778 |
| `packages/agent` | 373 | 1079 | 754 |
| `packages/app-core` | 244 | 758 | 487 |
| `packages/ui` | 676 | 1672 | 1228 |
| `packages/app` | 5 | 4 | 2 |
| `packages/elizaos` | 13 | 14 | 13 |
| `packages/vault` | 18 | 64 | 45 |
| `packages/cloud-routing` | 4 | 9 | 4 |

## Main findings

1. `core` and `shared` mirror several public contract files. The largest are
   wallet, onboarding, service routing, cloud topology, runtime env, and HTTP
   helper contracts. This is the highest-risk family because both packages are
   published public surfaces.
2. `ui` mirrors `shared` extensively. Some files are exact copies, while API
   client files copy selected server DTOs from `agent`, `core`, and `shared`.
3. `app-core` and `ui` still carry local-inference contract copies even though
   `packages/shared/src/local-inference/index.ts` says shared is the canonical
   type surface for server and UI local-inference contracts.
4. `core/src/cloud-routing.ts` and `packages/cloud-routing/src` duplicate the
   same routing contract and most of the same helper behavior.
5. `agent` server route DTOs are manually mirrored into `ui` client DTOs and
   repeated inside `agent` itself. Several copies are exact; a few have already
   drifted.
6. `vault` wire types are copied into `ui` because `ui` has no dependency on
   `@elizaos/vault` and there is no browser-safe vault contract package/subpath.

Recommended ownership map:

| contract family | recommended canonical owner | notes |
| --- | --- | --- |
| Runtime/plugin/core contracts | `@elizaos/core` | `@elizaos/shared` already depends on `@elizaos/core`, so shared can re-export instead of copy. |
| UI config/helpers | `@elizaos/shared` | `@elizaos/ui` already depends on shared; replace exact copies with imports/re-exports. |
| Agent HTTP DTOs | new type-only `@elizaos/agent` export or `@elizaos/shared/contracts/agent-api` | Avoid importing `api/server.ts` into Vite; export pure DTO modules. |
| Local inference wire contracts | `@elizaos/shared/local-inference` | Existing shared module is intended for this; finish the migration. |
| Cloud route resolution | `@elizaos/cloud-routing` | Make `core` a re-export/deprecation shim, or collapse package into core and make cloud-routing the shim. |
| Vault browser-facing wire types | `@elizaos/vault` type-only subpath or `@elizaos/shared/contracts/vault` | Prevent UI settings types from drifting from vault persistence/API types. |
| Mobile/iOS runtime config | `@elizaos/shared` or a single `@elizaos/ui` export consumed by `app` | Current `app` and `ui` copies are nearly identical. |

## Cross-package evidence

### Exact same-name object contracts

Representative high-confidence exact duplicates:

| symbol | locations | overlap evidence |
| --- | --- | --- |
| `WalletConfigStatus` | `packages/core/src/contracts/wallet.ts:228`, `packages/shared/src/contracts/wallet.ts:400` | 33 identical keys: `selectedRpcProviders`, `walletNetwork`, `legacyCustomChains`, `alchemyKeySet`, `infuraKeySet`, `ankrKeySet`, `nodeRealBscRpcSet`, `quickNodeBscRpcSet`, `managedBscRpcReady`, `cloudManagedAccess`, `evmBalanceReady`, `ethereumBalanceReady`, `baseBalanceReady`, `bscBalanceReady`, `avalancheBalanceReady`, `solanaBalanceReady`, `tradePermissionMode`, `tradeUserCanLocalExecute`, `tradeAgentCanLocalExecute`, `heliusKeySet`, `birdeyeKeySet`, `evmChains`, `walletSource`, `automationMode`, `pluginEvmLoaded`, `pluginEvmRequired`, `executionReady`, `executionBlockedReason`, `evmSigningCapability`, `evmSigningReason`, `solanaSigningAvailable`, `wallets`, `primary`. |
| `TriggerSummary` | `packages/agent/src/triggers/types.ts:46`, `packages/ui/src/api/agent-client-type-shim.ts:101`, `packages/ui/src/api/client-types-core.ts:109` | 24 identical keys: `id`, `taskId`, `displayName`, `instructions`, `triggerType`, `enabled`, `wakeMode`, `createdBy`, `timezone`, `intervalMs`, `scheduledAtIso`, `cronExpression`, `eventKind`, `maxRuns`, `runCount`, `nextRunAtMs`, `lastRunAtIso`, `lastStatus`, `lastError`, `updatedAt`, `updateInterval`, `kind`, `workflowId`, `workflowName`. |
| `BscTradeQuoteResponse` | `packages/core/src/contracts/wallet.ts:341`, `packages/shared/src/contracts/wallet.ts:513` | 21 identical keys: `ok`, `side`, `routeProvider`, `routeProviderRequested`, `routeProviderFallbackUsed`, `routeProviderNotes`, `routerAddress`, `wrappedNativeAddress`, `tokenAddress`, `slippageBps`, `route`, `quoteIn`, `quoteOut`, `minReceive`, `price`, `preflight`, `swapTargetAddress`, `swapCallData`, `swapValueWei`, `allowanceTarget`, `quotedAt`. |
| `ServiceRouteConfig` | `packages/core/src/contracts/service-routing.ts:119`, `packages/shared/src/contracts/service-routing.ts:119` | 18 identical keys: `backend`, `transport`, `accountId`, `accountIds`, `strategy`, `primaryModel`, `nanoModel`, `smallModel`, `mediumModel`, `largeModel`, `megaModel`, `remoteApiBase`, `responseHandlerModel`, `shouldRespondModel`, `actionPlannerModel`, `plannerModel`, `responseModel`, `mediaDescriptionModel`. |
| `AppConfig` | `packages/shared/src/config/app-config.ts:222`, `packages/ui/src/config/app-config.ts:222` | Entire files are identical by `cmp`; 18-key `AppConfig` shape is duplicated. |
| `LocalInferenceLoadArgs` | `packages/app-core/src/services/local-inference/active-model.ts:90`, `packages/ui/src/services/local-inference/active-model.ts:76` | 18 identical keys: `modelPath`, `contextSize`, `useGpu`, `maxThreads`, `draftModelPath`, `draftContextSize`, `draftMin`, `draftMax`, `speculativeSamples`, `mobileSpeculative`, `cacheTypeK`, `cacheTypeV`, `disableThinking`, `gpuLayers`, `kvOffload`, `flashAttention`, `mmap`, `mlock`. |
| `JsonSchemaProperty` | `packages/shared/src/config/config-catalog.ts:37`, `packages/ui/src/config/config-catalog.ts:37` | 17 identical keys. File differs only in import path style near the top. |
| `AppSessionState` | `packages/shared/src/contracts/apps.ts:160`, `packages/ui/src/api/client-types-cloud.ts:466` | 16 identical keys: `sessionId`, `appName`, `mode`, `status`, `displayName`, `agentId`, `characterId`, `followEntity`, `canSendCommands`, `controls`, `summary`, `goalLabel`, `suggestedPrompts`, `recommendations`, `activity`, `telemetry`. |
| `CreateTriggerRequest` / `UpdateTriggerRequest` | `packages/agent/src/triggers/types.ts:83` and `:101`, `packages/ui/src/api/agent-client-type-shim.ts:138` and `:156`, `packages/ui/src/api/client-types-core.ts:146` and `:164` | 15 and 14 identical request keys respectively. |
| `DeviceCapabilities` | `packages/app-core/src/services/local-inference/device-bridge.ts:50`, `packages/ui/src/services/local-inference/device-bridge.ts:50` | 15 identical keys. Nearby union type `DeviceOutbound` has already drifted: `app-core` has `cacheKey`, UI does not. |
| `StylePreset` | `packages/core/src/contracts/onboarding.ts:31`, `packages/shared/src/contracts/onboarding.ts:31` | 15 identical keys. |
| `LinkedAccountConfig` | `packages/core/src/contracts/service-routing.ts:82`, `packages/shared/src/contracts/service-routing.ts:82` | 14 identical keys. |
| `ProviderOption` | `packages/core/src/contracts/onboarding.ts:112`, `packages/shared/src/contracts/onboarding.ts:112` | 14 identical keys. |
| `RegistrySearchResult` | `packages/agent/src/services/registry-client-types.ts:97`, `packages/ui/src/api/client-types-config.ts:445` | 13 identical keys. |
| `RelationshipsPersonFact` | `packages/core/src/services/relationships-graph-builder.ts:120`, `packages/ui/src/api/client-types-relationships.ts:55` | 12 identical keys, with type-level drift around `UUID` vs `string` aliases. |
| `SubscriptionProviderStatus` | `packages/core/src/contracts/onboarding.ts:671`, `packages/shared/src/contracts/onboarding.ts:671` | 12 identical keys. |
| `ConversationMetadata` | `packages/agent/src/api/server-types.ts:48`, `packages/ui/src/api/agent-client-type-shim.ts:42`, `packages/ui/src/api/client-types-core.ts:56` | 10 identical keys. |
| `ElizaRuntimeEnv` / `ResolvedApiSecurityConfig` | `packages/core/src/runtime-env.ts:45` and `:34`, `packages/shared/src/runtime-env.ts:45` and `:34` | Same names and same shapes. |
| `RuntimePrivateState` | `packages/core/src/plugin-lifecycle.ts:97`, `packages/agent/src/runtime/plugin-lifecycle.ts:132` | 9 identical keys for private runtime plugin lifecycle storage. |
| `IosRuntimeConfig` | `packages/ui/src/platform/ios-runtime.ts:10`, `packages/app/src/ios-runtime.ts:10` | 8 identical keys; `ui` copy has expanded comments, `app` copy does not. |
| `BackendStatus` | `packages/vault/src/manager.ts:48`, `packages/ui/src/components/settings/vault-tabs/types.ts:12` | 6 identical keys plus `authMode`; UI removes `readonly`. |

### Different names with same or overlapping shapes

These are semantically duplicative even when names differ:

| source symbol | duplicate symbol | overlap evidence | recommendation |
| --- | --- | --- | --- |
| `AgentUpdateStatus` at `packages/shared/src/contracts/update-status.ts:70` | `UpdateStatus` at `packages/ui/src/api/client-types-config.ts:372` | Same 17 keys. UI widens `installMethod` to `string`; shared has `AgentInstallMethod | (string & {})`. | Export/import the shared contract under the UI name if desired: `type UpdateStatus = AgentUpdateStatus`. |
| `MemorySearchHit` at `packages/agent/src/api/memory-routes.ts:51` | `MemorySearchResult` at `packages/ui/src/api/client-types-chat.ts:354` | Same keys: `id`, `text`, `createdAt`, `score`. | Put memory API DTOs in a pure type module consumed by routes and UI. |
| `MemoryBrowseItem` at `packages/agent/src/api/memory-routes.ts:243` | `MemoryBrowseItem` at `packages/ui/src/api/client-types-chat.ts:383` | Same name and same 9 keys, copied between route and client. | Same as above. |
| `WorkbenchTaskView` at `packages/agent/src/api/workbench-helpers.ts:33` | `WorkbenchTask` at `packages/ui/src/api/client-types-config.ts:534` | Same keys: `id`, `name`, `description`, `tags`, `isCompleted`, `updatedAt`. | Make `WorkbenchTask` the exported wire DTO and use it on both sides. |
| `ParsedPermissionRequest` at `packages/agent/src/api/parse-action-block.ts:25` | `PermissionCardPayload` at `packages/ui/src/components/composites/chat/permission-card.tsx:393` | Same keys: `permission`, `reason`, `feature`, `fallbackOffered`, `fallbackLabel`; `fallbackOffered` is required server-side and optional UI-side. | Extract the action payload contract; UI props can wrap it instead of redefining it. |
| `PluginIndexEntry` at `packages/agent/src/api/plugin-discovery-helpers.ts:109` | `ManifestPluginEntry` at `packages/app-core/src/api/plugins-routes.ts:73` | Same plugin index field family: `id`, `dirName`, `name`, `npmName`, `description`, `tags`, `category`, `envKey`, `configKeys`, `version`, `pluginDeps`, `pluginParameters`, `configUiHints`, `icon`, `logoUrl`, `homepage`, `repository`, `setupGuideUrl`. Optionality differs. | Define one manifest/index DTO and layer route-specific optionality with `Partial`/normalizers. |
| `RawPluginParameterDefinition` at `packages/agent/src/api/plugin-discovery-helpers.ts:178` | `ManifestPluginParameter` at `packages/app-core/src/api/plugins-routes.ts:63` | Same parameter keys: `type`, `description`, `required`, `optional`, `sensitive`, `default`, `options`. | Move to shared plugin registry contract. |
| `PluginParamDef` at `packages/agent/src/api/server-types.ts:151` | `PluginParamDef` at `packages/agent/src/api/plugin-routes.ts:66`, `packages/ui/src/api/client-types-config.ts:94` | Same 9 keys: `key`, `type`, `description`, `required`, `sensitive`, `default`, `options`, `currentValue`, `isSet`. | Use `server-types.ts` as the agent-internal canonical type and export it through a safe type-only client module. |
| `OptionalTrainingConfig` at `packages/agent/src/api/server.ts:641` | `AutoTrainingConfig` at `packages/ui/src/components/settings/CapabilitiesSection.tsx:7` | Same keys: `autoTrain`, `triggerThreshold`, `triggerCooldownHours`, `backends`. | Move out of component-local and route-local types into agent API DTOs. |
| `CachedModel` at `packages/agent/src/api/model-provider-helpers.ts:190` | `ProviderModelRecord` at `packages/ui/src/api/client-types-core.ts:289` | Same keys: `id`, `name`, `category`; associated categories are `ModelCategory` at `:182` and `ProviderModelCategory` at UI `:281`. | Export provider model list DTO from the agent API contract module. |
| `ModelOption` at `packages/core/src/contracts/onboarding.ts:135`, `packages/shared/src/contracts/onboarding.ts:135` | `ModelOption` at `packages/agent/src/api/model-provider-helpers.ts:17`, `packages/ui/src/components/settings/cloud-model-schema.ts:17` | Same keys: `id`, `name`, `provider`, `description`, `recommended`, `free`. | Reuse onboarding `ModelOption` instead of local copies. |
| `AppSessionFeature` at `packages/shared/src/contracts/apps.ts:14`, `packages/ui/src/api/client-types-cloud.ts:403` | `PluginManifestAppSessionFeature` at `packages/core/src/types/plugin-manifest.ts:93`, `PluginAppSessionFeature` at `packages/core/src/types/plugin.ts:180` | Same literal union: `commands`, `telemetry`, `pause`, `resume`, `suggestions`. | Define once in core plugin/app session contracts, re-export under compatibility aliases. |
| `ServiceRouteAccountStrategy` at `packages/core/src/contracts/service-routing.ts:113` and `packages/shared/src/contracts/service-routing.ts:113` | `Strategy` at `packages/app-core/src/services/account-pool.ts:58` | Same literal strategy family. | Import the service-routing strategy type into app-core account-pool. |
| `SessionSendPolicyMatch` at `packages/core/src/types/channel-config.ts:117` | `MediaUnderstandingScopeMatch` at `packages/shared/src/config/types.tools.ts:9` | Same keys: `channel`, `chatType`, `keyPrefix`. | Either share a generic `ChannelScopeMatch` or intentionally alias one to the other. |
| `BackendId` / `BackendStatus` at `packages/vault/src/manager.ts:46` and `:48` | `BackendId` / `BackendStatus` at `packages/ui/src/components/settings/vault-tabs/types.ts:9` and `:12` | Same backend id union and status fields. | Export browser-safe vault wire types. |

### Same names that have drifted

| symbol | locations | drift |
| --- | --- | --- |
| `TradePermissionMode` | `packages/core/src/contracts/wallet.ts:295`, `packages/shared/src/contracts/wallet.ts:467`, `packages/agent/src/api/trade-safety.ts:42`, `packages/ui/src/api/client-types-core.ts:74`, `packages/ui/src/api/agent-client-type-shim.ts:60` | `core`/`shared` allow `user-sign-only`, `manual-local-key`, `agent-auto`; `agent`/`ui` add `disabled`. This is the clearest DTO drift and should be resolved before further wallet work. |
| `AgentStartupDiagnostics` | `packages/agent/src/api/server-types.ts:76`, `packages/agent/src/api/health-routes.ts:22`, `packages/agent/src/api/server-helpers.ts:191`, `packages/ui/src/api/client-types-core.ts:254` | Agent copies have 5 keys; UI adds embedding warmup fields. The UI may be ahead of the server contract or embedding status is undocumented in the route DTO. |
| `DeviceOutbound` / device generate request | `packages/app-core/src/services/local-inference/device-bridge.ts:81`, `packages/ui/src/services/local-inference/device-bridge.ts:81` | `app-core` supports `cacheKey` in generate payload and method args; UI copy omits it. Prompt-cache reuse can silently disappear for UI-routed calls. |
| `ActiveModelManager.load` and fit admission | `packages/app-core/src/services/local-inference/active-model.ts:566`, `packages/ui/src/services/local-inference/active-model.ts:476` | `app-core` has host RAM admission control (`ModelDoesNotFitError`, `assertModelFitsHost`); UI copy lacks it. Types remain identical enough to hide divergent behavior. |
| `IntegrationBoundary` | `packages/app-core/src/diagnostics/integration-observability.ts:3`, `packages/agent/src/diagnostics/integration-observability.ts:3` | Same event shape, but `agent` adds `lifeops` and `browser-bridge` boundary literals. |

## Package-by-package report

## `packages/core`

High-confidence duplicates:

- `packages/core/src/contracts/wallet.ts` duplicates all 86 declared symbols in
  `packages/shared/src/contracts/wallet.ts`. Examples:
  - `WalletConfigStatus` at `:228` mirrors shared `:400` with 33 identical keys.
  - `BscTradeQuoteResponse` at `:341` mirrors shared `:513` with 21 identical keys.
  - `WalletTradeLedgerEntry` at `:435` mirrors shared `:607` with 18 identical keys.
  - `WalletTradeLedgerRecordInput` at `:747` mirrors shared `:919` with 18 identical keys.
  - `TradePermissionMode` at `:295` has already drifted from agent/UI by missing `disabled`.
- `packages/core/src/contracts/onboarding.ts` duplicates all 30 declared symbols
  in `packages/shared/src/contracts/onboarding.ts`. Examples:
  - `StylePreset` at `:31` mirrors shared `:31` with 15 identical keys.
  - `ProviderOption` at `:112` mirrors shared `:112` with 14 identical keys.
  - `ModelOption` at `:135` also appears in agent and UI with the same 6-key shape.
  - `SubscriptionProviderStatus` at `:671` mirrors shared `:671` with 12 identical keys.
- `packages/core/src/contracts/service-routing.ts` duplicates all 18 declared
  symbols in `packages/shared/src/contracts/service-routing.ts`. Examples:
  - `LinkedAccountConfig` at `:82` mirrors shared `:82` with 14 identical keys.
  - `ServiceRouteConfig` at `:119` mirrors shared `:119` with 18 identical keys.
  - `ServiceRouteAccountStrategy` at `:113` overlaps app-core `Strategy`.
- `packages/core/src/contracts/cloud-topology.ts` duplicates
  `packages/shared/src/contracts/cloud-topology.ts`.
  - `ResolvedElizaCloudTopology` at `:15` mirrors shared `:15`.
  - `ElizaCloudService` at `:8` mirrors shared `:8`.
- `packages/core/src/runtime-env.ts` duplicates runtime env contracts in
  `packages/shared/src/runtime-env.ts`.
  - `ResolvedApiSecurityConfig` at `:34` mirrors shared `:34`.
  - `ElizaRuntimeEnv` at `:45` mirrors shared `:45`.
- `packages/core/src/api/http-helpers.ts` duplicates HTTP body helper contracts
  in `packages/shared/src/api/http-helpers.ts`.
  - `CachedRequest` at `:7`, `RequestBodyOptions` at `:18`, and
    `ReadJsonBodyOptions` at `:147` mirror shared.
- `packages/core/src/cloud-routing.ts` duplicates package-level cloud routing:
  - `CloudRouteSource` at `:1` mirrors `packages/cloud-routing/src/types.ts:1`.
  - `CloudRoute` at `:3` mirrors `packages/cloud-routing/src/types.ts:4`.
  - `RouteSpec` at `:21` mirrors `packages/cloud-routing/src/types.ts:47`.
  - `CloudRuntimeSettings` at `:39` has the same `getSetting` shape as
    `packages/cloud-routing/src/resolve.ts:20` `RuntimeSettings`.
- `packages/core/src/types/plugin-manifest.ts:93`,
  `packages/core/src/types/plugin.ts:180`, `packages/shared/src/contracts/apps.ts:14`,
  and `packages/ui/src/api/client-types-cloud.ts:403` all encode the same
  app-session feature union.
- `packages/core/src/plugin-lifecycle.ts` duplicates internal runtime lifecycle
  shapes in `packages/agent/src/runtime/plugin-lifecycle.ts`.
  - `RuntimePrivateState` at core `:97` mirrors agent `:132`.
  - `RuntimeSendHandler` at core `:29` mirrors agent `:71`.
  - `RuntimeServicePromiseHandler` at core `:53` mirrors agent `:96`.
- `packages/core/src/services/relationships-graph-builder.ts` DTOs are copied
  into `packages/ui/src/api/client-types-relationships.ts`.
  - `RelationshipsPersonFact` at core `:120` mirrors UI `:55`.
  - `RelationshipsPersonDetail` at core `:195` mirrors UI `:134`.

Recommendations:

1. Make `core` canonical for runtime/plugin/wallet/onboarding/service-routing
   contracts that are already part of the public core API. Replace shared copies
   with type/value re-exports where module side effects allow it.
2. Add compatibility aliases before removing names. For example, keep
   `PluginManifestAppSessionFeature` and `PluginAppSessionFeature` as aliases
   to one canonical `AppSessionFeature`.
3. Resolve `TradePermissionMode` first because it is already semantically
   inconsistent across wallet, trade-safety, and UI contracts.
4. For cloud routing, choose a single owner. Prefer `@elizaos/cloud-routing`
   because it is already a small purpose-built package; make the core module
   delegate or re-export with a deprecation window.
5. For relationship DTOs, export a pure DTO module from core or shared so the
   UI does not need to restate UUID-to-string shapes manually.

## `packages/shared`

High-confidence duplicates:

- Mirrors public core contract files:
  - `packages/shared/src/contracts/wallet.ts` duplicates 86 symbols from
    `packages/core/src/contracts/wallet.ts`.
  - `packages/shared/src/contracts/onboarding.ts` duplicates 30 symbols from
    `packages/core/src/contracts/onboarding.ts`.
  - `packages/shared/src/contracts/service-routing.ts` duplicates 18 symbols
    from `packages/core/src/contracts/service-routing.ts`.
  - `packages/shared/src/contracts/cloud-topology.ts` duplicates
    `packages/core/src/contracts/cloud-topology.ts`.
  - `packages/shared/src/runtime-env.ts` duplicates `packages/core/src/runtime-env.ts`.
  - `packages/shared/src/api/http-helpers.ts` duplicates
    `packages/core/src/api/http-helpers.ts`.
- Exact file mirrors with UI:
  - `packages/shared/src/config/allowed-hosts.ts`
  - `packages/shared/src/config/api-key-prefix-hints.ts`
  - `packages/shared/src/config/app-config.ts`
  - `packages/shared/src/config/boot-config-react.tsx`
  - `packages/shared/src/config/boot-config.ts`
  - `packages/shared/src/config/cloud-only.ts`
  - `packages/shared/src/config/plugin-ui-spec.ts`
  - `packages/shared/src/config/ui-spec.ts`
  - `packages/shared/src/terminal/links.ts`
  - `packages/shared/src/terminal/palette.ts`
  - `packages/shared/src/utils/assistant-text.ts`
  - `packages/shared/src/utils/browser-tab-kit-types.ts`
  - `packages/shared/src/utils/character-message-examples.ts`
  - `packages/shared/src/utils/cloud-status.ts`
  - `packages/shared/src/utils/documents-upload-image.ts`
  - `packages/shared/src/utils/eliza-cloud-model-route.ts`
  - `packages/shared/src/utils/eliza-globals.ts`
  - `packages/shared/src/utils/errors.ts`
  - `packages/shared/src/utils/format.ts`
  - `packages/shared/src/utils/labels.ts`
  - `packages/shared/src/utils/log-prefix.ts`
  - `packages/shared/src/utils/name-tokens.ts`
  - `packages/shared/src/utils/namespace-defaults.ts`
  - `packages/shared/src/utils/number-parsing.ts`
  - `packages/shared/src/utils/owner-name.ts`
  - `packages/shared/src/utils/rate-limiter.ts`
  - `packages/shared/src/utils/serialise.ts`
  - `packages/shared/src/utils/streaming-text.ts`
  - `packages/shared/src/utils/subscription-auth.ts`
  - `packages/shared/src/utils/trajectory-format.ts`
  - `packages/shared/src/utils/tts-debug.ts`
- Near-exact UI mirrors:
  - `packages/shared/src/config/config-catalog.ts` vs
    `packages/ui/src/config/config-catalog.ts`: differs only in import path
    style near the top; `JsonSchemaProperty`, `ResolvedField`, `FieldCatalog`,
    `FieldRenderProps`, and related interfaces are identical.
  - `packages/shared/src/config/boot-config-store.ts` vs
    `packages/ui/src/config/boot-config-store.ts`: shares `GlobalConfigSlot`,
    `ResolvedCharacterAsset`, and boot config types.
- Exact mirror with agent:
  - `packages/shared/src/contracts/awareness.ts` and
    `packages/agent/src/contracts/awareness.ts` are exact file copies.
    `AwarenessInvalidationEvent` at `:20` and `AwarenessContributor` at `:29`
    are duplicated.
- Exact helper copies across multiple packages:
  - `packages/shared/src/cli/parse-duration.ts`,
    `packages/agent/src/cli/parse-duration.ts`,
    `packages/app-core/src/cli/parse-duration.ts`.
  - `packages/shared/src/utils/eliza-root.ts`,
    `packages/app-core/src/utils/eliza-root.ts`,
    `packages/ui/src/utils/eliza-root.ts`.
  - `packages/shared/src/utils/exec-safety.ts`,
    `packages/agent/src/utils/exec-safety.ts`,
    `packages/ui/src/utils/exec-safety.ts`.
- `packages/shared/src/contracts/apps.ts` has DTOs copied into
  `packages/ui/src/api/client-types-cloud.ts`:
  - `AppSessionState` at shared `:160` mirrors UI `:466`.
  - `AppSessionActionResult` at shared `:179` mirrors UI `:485`.
  - `AppRunEvent` at shared `:205` mirrors UI `:511`.
  - `AppLaunchResult` at shared `:271` mirrors UI `:581`.
  - `AppStopResult` at shared `:313` mirrors UI `:593`.
- `packages/shared/src/contracts/update-status.ts:70` `AgentUpdateStatus`
  mirrors UI `UpdateStatus` at `packages/ui/src/api/client-types-config.ts:372`.

Recommendations:

1. Split shared surfaces into two categories:
   - Shared-owned UI/config/util modules: keep in shared and make UI import or
     re-export them.
   - Core-owned contracts: replace shared implementations with re-exports from
     core or explicitly move ownership to shared and remove the core copies.
2. Keep `packages/shared/src/local-inference` as the canonical local-inference
   type barrel and migrate app-core/UI stragglers into it.
3. Move `AwarenessContributor` and related awareness types to a single shared
   module; agent should import that module instead of carrying a copy.
4. Add an AST drift check for exact shared/UI mirrors until the copies are
   removed. Exact file copies make accidental one-sided edits likely.

## `packages/agent`

High-confidence duplicates:

- Trigger DTOs are copied into UI twice:
  - `TriggerSummary` at `packages/agent/src/triggers/types.ts:46` mirrors
    `packages/ui/src/api/agent-client-type-shim.ts:101` and
    `packages/ui/src/api/client-types-core.ts:109`.
  - `TriggerHealthSnapshot` at `packages/agent/src/triggers/types.ts:73`
    mirrors UI `:128` and UI core `:136`.
  - `CreateTriggerRequest` at `:83` mirrors UI `:138` and UI core `:146`.
  - `UpdateTriggerRequest` at `:101` mirrors UI `:156` and UI core `:164`.
- Server/core DTOs are copied into UI:
  - `ConversationScope` at `packages/agent/src/api/server-types.ts:29`
    mirrors UI `packages/ui/src/api/client-types-core.ts:37`.
  - `ConversationMetadata` at agent `:48` mirrors UI `:56`.
  - `StreamEventType` at agent `:115` mirrors UI `:69`.
  - `PluginParamDef` at agent `:151` mirrors UI
    `packages/ui/src/api/client-types-config.ts:94`.
  - `LogEntry` at agent `:107` mirrors multiple agent copies and UI
    `packages/ui/src/api/client-types-core.ts:551`.
- Same symbol repeated inside agent:
  - `AgentStartupDiagnostics` appears at
    `packages/agent/src/api/server-types.ts:76`,
    `packages/agent/src/api/health-routes.ts:22`, and
    `packages/agent/src/api/server-helpers.ts:191`.
  - `LogEntry` appears in `packages/agent/src/actions/logs.ts:55`,
    `packages/agent/src/api/chat-routes.ts:127`,
    `packages/agent/src/api/plugin-discovery-helpers.ts:61`, and
    `packages/agent/src/api/server-types.ts:107`.
  - `PluginParamDef` appears in `packages/agent/src/api/server-types.ts:151`
    and `packages/agent/src/api/plugin-routes.ts:66`.
- Plugin discovery/index types overlap app-core plugin manifest route types:
  - `PluginIndexEntry` at `packages/agent/src/api/plugin-discovery-helpers.ts:109`
    overlaps `ManifestPluginEntry` at `packages/app-core/src/api/plugins-routes.ts:73`.
  - `RawPluginParameterDefinition` at agent `:178` overlaps
    `ManifestPluginParameter` at app-core `:63`.
- Model provider DTOs overlap core/shared/UI:
  - `ModelOption` at `packages/agent/src/api/model-provider-helpers.ts:17`
    mirrors core/shared onboarding `ModelOption` and UI cloud-model schema.
  - `ModelCategory` at `packages/agent/src/api/model-provider-helpers.ts:182`
    mirrors UI `ProviderModelCategory` at
    `packages/ui/src/api/client-types-core.ts:281`.
  - `CachedModel` at agent `:190` mirrors UI `ProviderModelRecord` at `:289`.
- Memory/workbench/action payloads are mirrored in UI:
  - `MemorySearchHit` at `packages/agent/src/api/memory-routes.ts:51`
    mirrors UI `MemorySearchResult` at `packages/ui/src/api/client-types-chat.ts:354`.
  - `MemoryBrowseItem` at agent `:243` mirrors UI `:383`.
  - `WorkbenchTaskView` at `packages/agent/src/api/workbench-helpers.ts:33`
    mirrors UI `WorkbenchTask` at `packages/ui/src/api/client-types-config.ts:534`.
  - `ParsedPermissionRequest` at `packages/agent/src/api/parse-action-block.ts:25`
    mirrors UI `PermissionCardPayload` at
    `packages/ui/src/components/composites/chat/permission-card.tsx:393`.
- Runtime and security types overlap core:
  - `packages/agent/src/runtime/plugin-lifecycle.ts` mirrors core plugin
    lifecycle private shapes.
  - `AccessContext` at `packages/agent/src/security/access.ts:10` mirrors
    core access-context shapes in `packages/core/src/features/plugin-manager/security.ts:41`
    and `packages/core/src/roles.ts:845`.
- Exact file mirrors:
  - `packages/agent/src/contracts/awareness.ts` mirrors
    `packages/shared/src/contracts/awareness.ts`.
  - `packages/agent/src/cli/parse-duration.ts` mirrors shared and app-core.
  - `packages/agent/src/utils/exec-safety.ts` mirrors shared and UI.
- Internal auth and OAuth shapes repeat:
  - `OAuthCredentials` at `packages/agent/src/auth/types.ts:5` mirrors
    `AnthropicOAuthCredentials` at
    `packages/agent/src/auth/vendor/pi-oauth/anthropic-login.ts:20`.
  - `VendorFlow` at `packages/agent/src/auth/oauth-flow.ts:217` mirrors
    `AnthropicOAuthFlowHandle` at
    `packages/agent/src/auth/vendor/pi-oauth/anthropic-login.ts:34`.
  - `LegacyStoredCredentials` at `packages/agent/src/auth/account-storage.ts:78`
    mirrors `StoredCredentials` at `packages/agent/src/auth/types.ts:271`.

Recommendations:

1. Create a pure agent API contract barrel that contains only DTOs and no route
   implementation imports. UI can import this safely without pulling
   `api/server.ts` into Vite.
2. Replace `agent-client-type-shim.ts` and duplicated slices of
   `client-types-core.ts` with imports/aliases from that DTO barrel.
3. Collapse repeated agent-internal DTOs (`AgentStartupDiagnostics`, `LogEntry`,
   `PluginParamDef`) into `server-types.ts` or a narrower `api/contracts.ts`.
4. Move plugin-index/manifest parameter definitions to shared registry
   contracts and have both agent discovery and app-core manifest routes parse
   into that shape.
5. Reuse core/shared onboarding `ModelOption` and wallet `TradePermissionMode`
   instead of local literals.

## `packages/app-core`

High-confidence duplicates:

- Local-inference service contracts are mirrored in UI:
  - `LocalInferenceLoadArgs` at
    `packages/app-core/src/services/local-inference/active-model.ts:90`
    mirrors UI `packages/ui/src/services/local-inference/active-model.ts:76`.
  - `LocalInferenceLoadOverrides` at app-core `:306` mirrors UI `:292`.
  - `LocalInferenceLoader` at app-core `:261` mirrors UI `:247`.
  - `DeviceCapabilities` at
    `packages/app-core/src/services/local-inference/device-bridge.ts:50`
    mirrors UI `:50`.
  - `DeviceBridgeStatus` at app-core `:258` mirrors UI `:250`.
  - `ConnectedDevice`, `DeviceSummary`, `PendingLoad`, `PendingUnload`,
    `PendingGenerate`, `PendingEmbed`, and `MinimalWebSocket` are also mirrored
    between the same files.
  - `BundledModelEntry` at
    `packages/app-core/src/services/local-inference/bundled-models.ts:39`
    mirrors UI `:39`; that whole file is an exact copy.
  - `HfSearchResultRaw` and `HfModelDetailRaw` in
    `packages/app-core/src/services/local-inference/hf-search.ts:19` and `:34`
    mirror UI `:19` and `:34`.
  - `HandlerRegistration` at
    `packages/app-core/src/services/local-inference/handler-registry.ts:18`
    mirrors UI `:18`.
  - `RecommendationPlatformClass` and `RecommendedModelSelection` in
    `packages/app-core/src/services/local-inference/recommendation.ts:37` and
    `:45` mirror UI `:14` and `:22`.
- Exact local-inference file mirrors with UI:
  - `packages/app-core/src/services/local-inference/bundled-models.ts`
  - `packages/app-core/src/services/local-inference/external-scanner.ts`
  - `packages/app-core/src/services/local-inference/paths.ts`
  - `packages/app-core/src/services/local-inference/readiness.ts`
  - `packages/app-core/src/services/local-inference/registry.ts`
  - `packages/app-core/src/services/local-inference/routing-policy.ts`
  - `packages/app-core/src/services/local-inference/routing-preferences.ts`
  - `packages/app-core/src/services/local-inference/verify.ts`
- Drift in near-copied local-inference files:
  - `packages/app-core/src/services/local-inference/device-bridge.ts` includes
    generate `cacheKey` in the outbound union and `generate()` args; UI omits it.
  - `packages/app-core/src/services/local-inference/active-model.ts` includes
    `ModelDoesNotFitError` and RAM admission control; UI omits it.
  - `packages/app-core/src/services/local-inference/recommendation.ts` has
    manifest/tier-aware recommendation logic; UI has older literal ladders and
    `assessFit` logic.
- Plugin manifest route DTOs overlap agent plugin discovery DTOs:
  - `ManifestPluginParameter` at `packages/app-core/src/api/plugins-routes.ts:63`
    overlaps `RawPluginParameterDefinition` at
    `packages/agent/src/api/plugin-discovery-helpers.ts:178`.
  - `ManifestPluginEntry` at app-core `:73` overlaps agent `PluginIndexEntry`
    at `:109`.
- Diagnostics:
  - `IntegrationObservabilityEvent` at
    `packages/app-core/src/diagnostics/integration-observability.ts:6`
    mirrors `packages/agent/src/diagnostics/integration-observability.ts:12`
    with boundary-literal drift.
- Exact helper copies:
  - `packages/app-core/src/cli/parse-duration.ts` mirrors shared and agent.
  - `packages/app-core/src/utils/eliza-root.ts` mirrors shared and UI.
  - `packages/app-core/src/runtime/dev-settings-figlet-heading.ts` mirrors
    `packages/shared/src/dev-settings-figlet-heading.ts`.

Recommendations:

1. Finish local-inference type extraction into `@elizaos/shared/local-inference`.
   `packages/shared/src/local-inference/index.ts` already documents this as the
   intended ownership model, but key wire types remain in app-core/UI copies.
2. Keep runtime-only implementation in app-core, UI-only client behavior in UI,
   and move only wire types, constants, catalog DTOs, and validation helpers to
   shared.
3. Add a local-inference drift test around generate request payloads so fields
   like `cacheKey` cannot exist server-side but disappear client-side.
4. Consolidate plugin manifest/index contracts with agent plugin discovery.
5. Put `IntegrationObservabilityEvent` and `IntegrationBoundary` in a shared
   diagnostics contract and let packages extend allowed boundary literals via
   a single union, not copied files.

## `packages/ui`

High-confidence duplicates:

- UI has the broadest duplication footprint. Major mirrored sources:
  - Shared config/util modules, including exact copies listed in the
    `packages/shared` section.
  - Agent API DTOs in `packages/ui/src/api/client-types-core.ts`,
    `packages/ui/src/api/agent-client-type-shim.ts`,
    `packages/ui/src/api/client-types-chat.ts`, and
    `packages/ui/src/api/client-types-config.ts`.
  - Shared app contracts in `packages/ui/src/api/client-types-cloud.ts`.
  - App-core local-inference service contracts in
    `packages/ui/src/services/local-inference/*`.
  - Vault wire types in `packages/ui/src/components/settings/vault-tabs/types.ts`.
  - App iOS runtime config in `packages/ui/src/platform/ios-runtime.ts`.
- Exact duplicate examples:
  - `AppConfig` at `packages/ui/src/config/app-config.ts:222` mirrors shared.
  - `UiElement` at `packages/ui/src/config/ui-spec.ts:188` mirrors shared.
  - `UiRenderContext` at `packages/ui/src/config/ui-spec.ts:215` mirrors shared.
  - `PatchOp` at `packages/ui/src/config/ui-spec.ts:243` mirrors shared.
  - `PluginParam` at `packages/ui/src/config/plugin-ui-spec.ts:14` mirrors shared.
  - `PluginForUiSpec` at `packages/ui/src/config/plugin-ui-spec.ts:23` mirrors shared.
  - `MessageRecord` at `packages/ui/src/utils/character-message-examples.ts:3`
    mirrors shared.
  - `ByteSizeFormatterOptions` at `packages/ui/src/utils/format.ts:33` mirrors shared.
  - `DurationFormatOptions` at `packages/ui/src/utils/format.ts:58` mirrors shared.
  - `StreamingUpdateResult` at `packages/ui/src/utils/streaming-text.ts:137`
    mirrors shared.
- API client examples:
  - `UpdateStatus` at `packages/ui/src/api/client-types-config.ts:372`
    mirrors shared `AgentUpdateStatus`.
  - `ColumnInfo` at UI `packages/ui/src/api/client-types-core.ts:222`
    mirrors agent database/action DTOs.
  - `LogsResponse` at UI `packages/ui/src/api/client-types-core.ts:559`
    mirrors `packages/agent/src/actions/logs.ts:63`.
  - `CatalogSearchResult` at UI `packages/ui/src/api/client-types-config.ts:822`
    mirrors `packages/agent/src/services/skill-catalog-client.ts:41`.
  - `PermissionCardPayload` at UI
    `packages/ui/src/components/composites/chat/permission-card.tsx:393`
    mirrors agent parsed action payload.
- App/cloud DTOs:
  - `AppSessionFeature` at `packages/ui/src/api/client-types-cloud.ts:403`
    mirrors shared and core plugin types.
  - `AppSessionState` at UI `:466` mirrors shared `:160`.
  - `AppRunEvent`, `AppRunSummary`, `AppLaunchResult`, and `AppStopResult`
    mirror shared app contracts.
- Vault DTOs:
  - `BackendId` at UI `packages/ui/src/components/settings/vault-tabs/types.ts:9`
    mirrors vault `packages/vault/src/manager.ts:46`.
  - `VaultEntryCategory` at UI `:39` mirrors vault
    `packages/vault/src/inventory.ts:46`.
  - `VaultEntryProfile` at UI `:47` mirrors vault `:54`.

Recommendations:

1. Treat UI copies as compatibility shims only. Replace duplicated definitions
   with `import type` plus alias exports whenever the source module is
   browser-safe.
2. For server-only modules that are not browser-safe, create dedicated type-only
   exports in agent/app-core/shared rather than copying DTOs into UI.
3. Delete `agent-client-type-shim.ts` once `client-types-core.ts` imports the
   same type source as the agent routes.
4. Stop copying shared config/util files into UI. UI already depends on
   `@elizaos/shared`; exact file copies should be one-line re-exports or direct
   imports.
5. Add a CI drift check for UI API DTOs until the generated/type-only client
   surface exists.

## `packages/app`

High-confidence duplicates:

- `packages/app/src/ios-runtime.ts` mirrors `packages/ui/src/platform/ios-runtime.ts`.
  - `IosRuntimeMode` at app `:3` mirrors UI `:3`.
  - `IosRuntimeConfig` at app `:10` mirrors UI `:10`.
  - Helper behavior such as `resolveCloudApiBase` and
    `apiBaseToDeviceBridgeUrl` is also duplicated.

Recommendations:

1. Move mobile runtime config and helpers to shared or import the UI platform
   module from app.
2. Keep app-specific environment wiring in `packages/app`, but avoid owning the
   type/normalization contract twice.

## `packages/elizaos`

Findings:

- No high-confidence cross-package duplicate contract was found in the scanned
  `src` tree.
- Internal package-json shapes overlap:
  - `PackageJson` at `packages/elizaos/src/commands/plugins.ts:18` has
    `name`, `version`, `description`, `homepage`, `keywords`, `repository`,
    and `elizaos` metadata.
  - `PackageJson` at `packages/elizaos/src/package-info.ts:7` has required
    `description`, `name`, and `version`.
- `TemplateDefinition` and `TemplatesManifest` are package-local at
  `packages/elizaos/src/types.ts:12` and `:23`; no matching core-family
  shape was found in the scanned source set.

Recommendations:

1. Leave template/scaffold types local unless another package starts consuming
   templates.
2. If plugin submission/package-info logic expands, introduce a local
   `PackageJsonLike` helper type instead of growing more per-file package-json
   interfaces.

## `packages/vault`

High-confidence duplicates:

- UI copies vault manager/status types:
  - `BackendId` at `packages/vault/src/manager.ts:46` mirrors
    `packages/ui/src/components/settings/vault-tabs/types.ts:9`.
  - `BackendStatus` at vault `:48` mirrors UI `:12`.
- UI copies vault inventory types:
  - `VaultEntryCategory` at `packages/vault/src/inventory.ts:46` mirrors UI
    `packages/ui/src/components/settings/vault-tabs/types.ts:39`.
  - `VaultEntryProfile` at vault `:54` mirrors UI `:47`.
  - `VaultEntryMeta`/meta-record shapes overlap the UI settings tab wire
    shapes around UI `:53`.

Recommendations:

1. Add a browser-safe, type-only contract subpath such as
   `@elizaos/vault/contracts` or move the UI-facing wire types to
   `@elizaos/shared/contracts/vault`.
2. Have UI import aliases from that source. Do not require UI to duplicate
   `readonly` removal; use mapped types if UI needs mutable view state.

## `packages/cloud-routing`

High-confidence duplicates:

- `packages/cloud-routing/src/types.ts` duplicates `packages/core/src/cloud-routing.ts`.
  - `CloudRouteSource` at cloud-routing `:1` mirrors core `:1`.
  - `CloudRoute` at cloud-routing `:4` mirrors core `:3`.
  - `RouteSpec` at cloud-routing `:47` mirrors core `:21`.
- `packages/cloud-routing/src/resolve.ts:20` `RuntimeSettings` mirrors
  `packages/core/src/cloud-routing.ts:39` `CloudRuntimeSettings`.
- Helper behavior also overlaps:
  - `toRuntimeSettings`
  - `cloudServiceApisBaseUrl`
  - `isCloudConnected`
  - `resolveCloudRoute`
- `packages/cloud-routing/src/types.ts:28` `FeatureCloudRoute` extends the
  duplicated `CloudRoute` with `feature` and `policy`, so package-local feature
  routing now rests on a copied base contract.

Recommendations:

1. Make `@elizaos/cloud-routing` the canonical owner for route resolution and
   feature route contracts.
2. Change `packages/core/src/cloud-routing.ts` to a re-export/delegation module,
   or invert ownership by moving cloud-routing internals into core and making
   the package a compatibility shim. Do not keep both implementations.
3. Keep `RuntimeSettings` structural and dependency-light, but expose a single
   name. Prefer `RuntimeSettings` over `CloudRuntimeSettings` if this remains a
   standalone package.

## Consolidation plan

Suggested order:

1. Fix already-drifted unions and DTOs:
   - `TradePermissionMode`
   - `AgentStartupDiagnostics`
   - local-inference `DeviceOutbound`/`cacheKey`
   - local-inference recommendation/fit contracts
2. Add canonical type-only exports without changing behavior:
   - `@elizaos/agent` API DTO subpath
   - `@elizaos/vault` contract subpath
   - complete `@elizaos/shared/local-inference` exports
3. Convert duplicate modules to aliases/re-exports:
   - shared re-exporting core-owned contract families, or core re-exporting
     shared if ownership is intentionally inverted
   - UI importing shared config/util modules
   - app importing the single iOS runtime config source
4. Add drift guards:
   - AST check for duplicate same-name symbols across the family.
   - Allow-list intentional aliases.
   - Fail on same-name different literal unions unless the report explicitly
     marks them as domain-separated.
5. Remove compatibility shims after downstream packages import canonical names.

## Suggested CI guard

Add a repo-local script that:

- Scans the same package family with TypeScript AST.
- Ignores generated/test/story files.
- Builds declaration signatures from interface/type-literal members and union
  literal text.
- Fails when:
  - the same symbol name appears in more than one package with non-identical
    signatures and no allow-list entry;
  - different symbol names have the exact same 5+ key object signature and no
    allow-list entry;
  - exact file copies exist outside an allow-listed shim directory.

This should be introduced after the first consolidation pass so CI starts from
an intentionally curated allow-list rather than the current duplication volume.
