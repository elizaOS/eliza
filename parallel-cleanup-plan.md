# Eliza Parallel Cleanup Plan

This plan treats the cleanup as one concurrent push, not sequential phases. Each workstream has an owner path set, acceptance criteria, and conflicts to avoid. The central rule is: use existing core seams where they already exist, and only add registry shape where enumeration/routing metadata is missing.

## Ground Truth From Core

- Core already defines canonical component types in `packages/core/src/types/components.ts`: `Action`, `Provider`, `Evaluator`, `ActionResult`, `ActionContext`.
- Core already defines abstract service interfaces in `packages/core/src/types/service-interfaces.ts`: `IWalletService`, `ITokenDataService`, `ILpService`, `IWebSearchService`, `IMessagingService`, `IEmailService`, `IPostService`, `IBrowserService`, etc.
- Runtime already has the send dispatch seam: `IAgentRuntime.registerSendHandler(source, handler)` and `IAgentRuntime.sendMessageToTarget(target, content)`.
- Runtime does not yet expose enough send-handler metadata for planning: no target resolver enumeration, no channel/contact listing, no chat/user context hook, no connector capability summary.
- Context routing already exists: `ContextRoutingDecision`, `primaryContext`, `secondaryContexts`, `getActiveRoutingContextsForTurn`, `resolveActionContexts`, `resolveProviderContexts`, `actionGroup.contexts`.
- Core already collapses grouped actions in the `ACTIONS` provider for main chat. This is the key for wallet/search/connector umbrella actions.
- The main planner output is already TOON in `messageHandlerTemplate`.
- Core action formatting already looks TOON-ish (`actions[n]`, `params[n]`), but it still renders action entries as markdown bullets. We should make this canonical TOON.
- `descriptionCompressed` is already auto-derived by `compressPromptDescription`, with a 160-char cap and protected technical spans. What is missing is linting, author guidance, and hand-fixing bad descriptions.
- Trajectory helpers already exist in `packages/core/src/trajectory-utils.ts`: `recordLlmCall`, `withActionStep`, `withProviderStep`, `withEvaluatorStep`, `spawnWithTrajectoryLink`.
- `runtime.useModel` already has fallback trajectory logging through `packages/agent/src/runtime/prompt-optimization.ts`.
- Planned tool execution currently calls `action.handler(...)` directly. It should be wrapped in `withActionStep`.
- Provider/evaluator dispatch paths should be wrapped in `withProviderStep` / `withEvaluatorStep` if not already.
- All raw SDK/fetch LLM-like calls must use `recordLlmCall`.

## Global Decisions

- Rename `plugins/plugin-form` to `plugins/plugin-form`.
- Delete per-platform `SEND_*_MESSAGE` actions immediately after the unified `SEND_MESSAGE` router owns routing. No deprecated aliases.
- Do not introduce a vague "native-only" package. For phone/wifi/contact/mobile app actions, use explicit plugin/shared-helper naming and remove `packages/agent/src/runtime/android-app-plugins.ts` only after real plugin exports cover the same behavior.
- Use existing service interfaces before creating new ones.
- Delete slop and placeholder code rather than hiding it behind flags.
- All LLM calls, including background loops and provider SDK calls, must emit trajectories.

## Parallel Coordination Rules

- Every agent owns only its listed paths.
- Core contract agents own shared runtime/types/util files. Plugin agents must not edit those files unless their workstream explicitly says so.
- Plugin agents may add small local adapter functions, but should not invent independent registries.
- If an action is read-only state exposure, prefer a provider unless the user explicitly needs a fresh/live operation with side effects or expensive query semantics.
- If multiple actions share a noun and vary only by operation, collapse to one action with `subaction`.
- If multiple actions share an operation and vary by backend/platform/chain/category, collapse to one action with `target`/`source`/`chain`/`category`.
- Use TOON in all model-facing prompts and examples. No XML/JSON/fenced JSON for planner-facing schemas unless a downstream API truly requires JSON.
- Use `descriptionCompressed` as semantic dispatch text, not marketing copy.
- Add tests or update existing tests for every action rename, router, registry, or deletion.
- Regenerate canonical action docs/specs only in the generated-docs workstream, after code owners finish.

## Workstream 01 - Core Connector Registry

Owner paths:
- `packages/core/src/types/runtime.ts`
- `packages/core/src/runtime.ts`
- `packages/core/src/types/service-interfaces.ts`
- `packages/core/src/types/*connector*.ts` if a new type file is required
- Runtime tests under `packages/core/src/__tests__/`

TODO:
- [ ] Extend the existing send-handler mechanism instead of replacing it.
- [ ] Add planner-facing metadata for send handlers: source, label, capabilities, supported target kinds, description, contexts.
- [ ] Add optional resolver hooks: `resolveTargets(query, context)`, `listRecentTargets(context)`, `listRooms(context)`, `getChatContext(target)`, `getUserContext(entityId)`.
- [ ] Expose `runtime.getMessageConnectors()` or equivalent enumeration.
- [ ] Keep `registerSendHandler(source, handler)` backward compatible.
- [ ] Add `registerMessageConnector(registration)` as a convenience that internally registers the send handler.
- [ ] Add collision logging when two connector registrations claim the same source.
- [ ] Add tests for multiple connectors, metadata enumeration, duplicate source handling, and `sendMessageToTarget` compatibility.

Acceptance:
- Existing connector plugins still compile without migration.
- Unified `SEND_MESSAGE` can see registered connector metadata without knowing plugin internals.

## Workstream 02 - Core Search Registry

Owner paths:
- `packages/core/src/types/service-interfaces.ts`
- `packages/core/src/types/runtime.ts`
- `packages/core/src/runtime.ts`
- New `packages/core/src/types/search*.ts` only if needed
- Search registry tests

TODO:
- [ ] Reuse `IWebSearchService` for web search.
- [ ] Add a generic search category registration surface for non-web backends: category, label, contexts, filters, result schema summary.
- [ ] Add runtime enumeration for search categories.
- [ ] Avoid making every plugin a `ServiceType.WEB_SEARCH`; category registrations are planner-facing capabilities.
- [ ] Add tests for category registration, duplicate category behavior, filter metadata, and disabled/missing category errors.

Acceptance:
- `WEB_SEARCH`, `SEARCH_POSTS`, `SEARCH_LINEAR_ISSUES`, `SEARCH_YOUTUBE`, `SEARCH_KNOWLEDGE`, `SEARCH_PLUGINS`, `SEARCH_VECTORS`, etc. can be migrated to one `SEARCH` action without losing backend-specific metadata.

## Workstream 03 - Core Action Grouping And TOON Formatting

Owner paths:
- `packages/core/src/actions.ts`
- `packages/core/src/features/basic-capabilities/providers/actions.ts`
- `packages/core/src/utils/toon.ts`
- Relevant prompt/action formatting tests

TODO:
- [ ] Make `formatActions` emit canonical TOON, not markdown bullets.
- [ ] Preserve deterministic shuffle behavior.
- [ ] Render action rows as a TOON list/table with fields: `name`, `description`, `params`, `aliases`, `tags`, `example`.
- [ ] Ensure parameters render compactly and parseably.
- [ ] Add a helper to render dynamic subactions/capabilities as TOON.
- [ ] Keep `formatActionNames` compact.
- [ ] Add tests covering actions with params, aliases, tags, examples, empty descriptions, and generated docs.

Acceptance:
- Main planner action surface is TOON-only.
- No XML/JSON action docs are introduced.

## Workstream 04 - Core Context Capability Surfacing

Owner paths:
- `packages/core/src/utils/context-catalog.ts`
- `packages/core/src/utils/context-routing.ts`
- `packages/core/src/features/basic-capabilities/providers/actions.ts`
- `packages/core/src/services/message.ts`
- Context routing tests

TODO:
- [ ] Keep `primaryContext` / `secondaryContexts` as the routing input.
- [ ] Make context-selected umbrella actions expand dynamic subaction descriptions only in relevant contexts.
- [ ] Support wallet/search/connectors dynamic provider inclusion by context.
- [ ] Add context tags for new umbrella actions: `WALLET_ACTION`, `SEARCH`, `SEND_MESSAGE`, `CONNECTOR_ACTION`.
- [ ] Ensure page-scoped contexts do not leak main-chat grouped actions.
- [ ] Add tests for wallet context, connector context, search/knowledge context, and no-context general chat.

Acceptance:
- Wallet/search/connector capabilities are not always dumped into the main planning context.
- Selecting a context reveals richer subaction/provider data.

## Workstream 05 - Core Trajectory Wiring

Owner paths:
- `packages/core/src/runtime.ts`
- Provider/evaluator dispatch code in `packages/core/src/**`
- `packages/core/src/trajectory-utils.ts` only for small fixes
- Trajectory tests

TODO:
- [ ] Wrap planned tool handler invocation with `withActionStep(runtime, action.name, ...)`.
- [ ] Wrap provider rendering with `withProviderStep`.
- [ ] Wrap evaluator dispatch with `withEvaluatorStep`.
- [ ] Verify child steps link to parent via `appendChildSteps`.
- [ ] Fix any incorrect use of `startStep(parentStepId, ...)` if persistence expects trajectory id rather than step id.
- [ ] Ensure action errors close/annotate child steps correctly.
- [ ] Add regression tests with fake trajectory logger: one planner step, one action step, one provider step, one evaluator step, nested child action.

Acceptance:
- Every action/provider/evaluator LLM call inside a message turn has a step.
- Existing runtime behavior is unchanged when trajectories are disabled.

## Workstream 06 - Trajectory Strict Mode And Raw LLM Guard

Owner paths:
- `packages/core/src/trajectory-utils.ts`
- `packages/agent/src/runtime/prompt-optimization.ts`
- Any shared lint/test helper files

TODO:
- [ ] Add dev/test guard for "LLM-like call outside trajectory" under `MILADY_TRAJECTORY_STRICT=1`.
- [ ] Expose a common helper for SDK/fetch calls: `recordLlmCall(runtime, details, fn)` is already present; document and enforce usage.
- [ ] Add tests where raw SDK calls fail strict mode without `recordLlmCall`.
- [ ] Ensure strict mode does not break embeddings/tokenizers unless explicitly classified as LLM calls.
- [ ] Clarify purpose/actionType taxonomy: `planner`, `action`, `provider`, `evaluator`, `background`, `external_llm`, `optimizer`.

Acceptance:
- New raw generation calls are easy to catch in CI.

## Workstream 07 - Model Provider Trajectory And Token Hygiene A

Owner paths:
- `plugins/plugin-anthropic`
- `plugins/plugin-openrouter`
- `plugins/plugin-nvidiacloud`

TODO:
- [ ] Fix double-emit token/double-count behavior.
- [ ] Ensure `MODEL_USED` events include model label, prompt tokens, completion tokens, total tokens where provider exposes them.
- [ ] Ensure streaming and non-streaming paths behave identically for trajectory logging.
- [ ] Remove bespoke fallback trajectory logging if core wrapper already captures it.
- [ ] Add provider-specific tests with mocked usage.

Acceptance:
- Exactly one trajectory LLM row per model call, enriched with token usage.

## Workstream 08 - Model Provider Trajectory And Token Hygiene B

Owner paths:
- `plugins/plugin-groq`
- `plugins/plugin-ollama`
- `plugins/plugin-vertex`
- `plugins/plugin-xai`
- `plugins/plugin-local-ai`

TODO:
- [ ] Emit `MODEL_USED` with token usage where available.
- [ ] Estimate and mark token usage as estimated where provider does not expose tokens.
- [ ] Ensure object/text/embed paths are classified correctly.
- [ ] Add tests for at least text small/large and object calls.

Acceptance:
- No provider leaves token columns blank unless the row explicitly marks estimation/unavailable.

## Workstream 09 - Model Provider Trajectory And Raw SDK Hygiene C

Owner paths:
- `plugins/plugin-openai`
- `plugins/plugin-google-genai`
- `plugins/plugin-rlm`
- `plugins/plugin-local-embedding`
- `plugins/plugin-edge-tts`
- `plugins/plugin-elevenlabs`

TODO:
- [ ] Audit for raw SDK/fetch generation calls.
- [ ] Wrap generation calls in `recordLlmCall` where they are LLM-like.
- [ ] Do not record deterministic tokenizer/embedding utility calls as generation unless existing trajectory policy requires it.
- [ ] Remove custom schema/prompt wrappers that conflict with TOON planner conventions.
- [ ] Add tests or fixtures for each wrapped call.

Acceptance:
- No generative model call in these provider plugins bypasses trajectory logging.

## Workstream 10 - Unified SEND_MESSAGE Core Action

Owner paths:
- Existing core/agent send message actions:
  - `packages/core/src/features/**/actions/*send*`
  - `packages/agent/src/actions/send-message.ts`
  - `packages/agent/src/actions/read-messages.ts` only if resolver utilities move
  - `packages/agent/src/actions/connector-resolver.ts`

TODO:
- [ ] Identify the canonical `SEND_MESSAGE` action and remove competing agent-local send actions.
- [ ] Route via connector registry metadata.
- [ ] Extract target hints from params and recent conversation: names, handles, channel names, server names, room names, keywords.
- [ ] Use relationship/entity components to resolve known contacts and shared platform handles.
- [ ] Use connector `resolveTargets` and `listRecentTargets` to score candidates.
- [ ] If multiple high-confidence targets remain, return a clarification/subaction selector result.
- [ ] If no target is selected but only one connector is relevant, default to that connector.
- [ ] Dynamic action description must list currently registered targets/categories compactly in TOON.
- [ ] Parameters should be uniform: `target`, `source?`, `targetKind?`, `message`, `thread?`, `attachments?`, `urgency?`.
- [ ] Delete per-platform `SEND_*_MESSAGE` actions after connector agents migrate.
- [ ] Add tests for exact source, inferred source, entity contact, channel target, ambiguous target, no connector, and permission failure.

Acceptance:
- The planner sees one `SEND_MESSAGE`.
- No per-platform send actions remain registered.

## Workstream 11 - Messaging Connector Adapters A

Owner paths:
- `plugins/plugin-discord`
- `plugins/plugin-slack`
- `plugins/plugin-telegram`

TODO:
- [ ] Keep existing service behavior.
- [ ] Register connector metadata/capabilities with core.
- [ ] Implement target resolution for users, channels, threads where APIs support it.
- [ ] Implement chat context and user context hooks where existing providers already expose the data.
- [ ] Delete platform-specific send action exports after unified send passes tests.
- [ ] Convert action/provider prompt snippets to TOON.
- [ ] Add adapter tests.

Acceptance:
- These connectors can send through unified `SEND_MESSAGE` and supply context without their old send actions.

## Workstream 12 - Messaging Connector Adapters B

Owner paths:
- `plugins/plugin-matrix`
- `plugins/plugin-signal`
- `plugins/plugin-line`
- `plugins/plugin-google-chat`
- `plugins/plugin-feishu`

TODO:
- [ ] Same migration checklist as Workstream 11.
- [ ] Collapse send/flex/location variants where appropriate into connector capabilities or one plugin-local router.
- [ ] Remove redundant chat/user providers after Workstream 15 adds shared provider factories.

Acceptance:
- Unified `SEND_MESSAGE` owns outgoing message planning for these connectors.

## Workstream 13 - Messaging Connector Adapters C

Owner paths:
- `plugins/plugin-imessage`
- `plugins/plugin-bluebubbles`
- `plugins/plugin-whatsapp`
- `plugins/plugin-xmtp`

TODO:
- [ ] Same migration checklist as Workstream 11.
- [ ] Normalize phone-number/contact identifiers in target resolution.
- [ ] Preserve any local bridge setup/health behavior as providers or connector status, not send actions.
- [ ] Remove duplicate iMessage/BlueBubbles chat context providers after shared provider migration.

Acceptance:
- Unified `SEND_MESSAGE` can resolve human contacts across SMS/iMessage/WhatsApp-style connectors.

## Workstream 14 - Social/Post Connectors

Owner paths:
- `plugins/plugin-x`
- `plugins/plugin-instagram`
- `plugins/plugin-farcaster`
- `plugins/plugin-bluesky`
- `plugins/plugin-nostr`
- `plugins/plugin-twitch`

TODO:
- [ ] Distinguish direct/private messaging from public posting.
- [ ] Use `IPostService`-style semantics for posts/casts/tweets where possible.
- [ ] Use connector registry only for DM/chat paths.
- [ ] Collapse redundant send/reply/post variants into router actions with `subaction`.
- [ ] Ensure background post-generation loops use standalone trajectories and `recordLlmCall`.
- [ ] Fix `instagram_user_state` duplicate provider by keeping one source of truth.

Acceptance:
- Chat/DM actions do not duplicate `SEND_MESSAGE`; public post actions are grouped by platform with clear subactions.

## Workstream 15 - Shared Chat/User Context Providers

Owner paths:
- Core provider factory location under `packages/core/src/features/**/providers`
- Connector provider files across:
  - `plugins/plugin-slack`
  - `plugins/plugin-discord`
  - `plugins/plugin-matrix`
  - `plugins/plugin-signal`
  - `plugins/plugin-line`
  - `plugins/plugin-google-chat`
  - `plugins/plugin-imessage`
  - `plugins/plugin-bluebubbles`
  - `plugins/plugin-nostr`
  - `plugins/plugin-twitch`

TODO:
- [ ] Add `PLATFORM_CHAT_CONTEXT` provider that enumerates registered message connectors and asks only context-relevant connectors for chat state.
- [ ] Add `PLATFORM_USER_CONTEXT` provider that resolves current user/contact identity across connectors.
- [ ] Delete per-platform chat/user context providers once adapters implement hooks.
- [ ] Keep connector-specific provider text out of general context unless context routing selects social/phone/connectors.
- [ ] Render provider output as TOON.
- [ ] Add tests for no connectors, one connector, multiple connectors, current-room context, and entity-specific context.

Acceptance:
- Chat/user context appears once in the provider surface, not N times per connector.

## Workstream 16 - Unified SEARCH Action

Owner paths:
- Core/plugin search action files:
  - `packages/core/src/features/knowledge/actions.ts`
  - `packages/core/src/features/plugin-manager/actions/searchPluginAction.ts`
  - `packages/agent/src/actions/search-conversations.ts`
  - `packages/agent/src/actions/database.ts`
  - `packages/agent/src/actions/entity-actions.ts`
  - `packages/agent/src/actions/web-search.ts`
  - `plugins/plugin-web-search`

TODO:
- [ ] Add one planner-visible `SEARCH` action with params: `category`, `query`, `filters?`, `limit?`, `freshness?`.
- [ ] Register categories dynamically from plugins.
- [ ] Migrate web search to plugin-web-search and remove agent-local `WEB_SEARCH`.
- [ ] Keep category descriptions compact and dynamic.
- [ ] Demote list-only search-like status actions to providers when they do not perform a real query.
- [ ] Add tests for category dispatch, missing category, filter validation, web search, knowledge search, plugin search, vector search.

Acceptance:
- Search backends are category registrations, not separate planner actions.

## Workstream 17 - Search Category Plugin Migrations

Owner paths:
- `plugins/plugin-linear`
- `plugins/plugin-github`
- `plugins/plugin-shopify`
- `plugins/plugin-music-library`
- `plugins/plugin-x`
- `plugins/plugin-discord`
- `plugins/plugin-agent-skills`
- `plugins/plugin-wallet/src/analytics/dexscreener`
- `plugins/plugin-wallet/src/analytics/birdeye`

TODO:
- [ ] Convert `SEARCH_LINEAR_ISSUES`, `SEARCH_SHOPIFY_STORE`, `SEARCH_YOUTUBE`, `SEARCH_POSTS`, `SEARCH_MESSAGES`, `SEARCH_SKILLS`, `DEXSCREENER_SEARCH`, Birdeye token searches to category registrations.
- [ ] Delete old action exports after `SEARCH` tests pass.
- [ ] Preserve backend-specific filters as metadata.
- [ ] Convert prompts/examples to TOON.
- [ ] Add per-plugin dispatch tests.

Acceptance:
- These plugins contribute categories to `SEARCH`, not standalone search actions.

## Workstream 18 - Plugin Manager Umbrella

Owner paths:
- `packages/core/src/features/plugin-manager`
- `packages/agent/src/actions/list-ejected.ts`
- `packages/agent/src/actions/list-installed-plugins.ts`
- `packages/agent/src/actions/connector-control.ts` only if connector/plugin overlap appears

TODO:
- [ ] Make `MANAGE_PLUGINS` / plugin-manager umbrella the only plugin-management action surface.
- [ ] Remove agent-local `LIST_EJECTED_PLUGINS`.
- [ ] Fold list/search/enable/disable/eject/status into subactions where applicable.
- [ ] Move read-only plugin state to providers where more efficient.
- [ ] Add tests that old duplicate action names are gone.

Acceptance:
- One plugin manager action family, no core/agent duplicate action names.

## Workstream 19 - plugin-form Migration

Owner paths:
- `plugins/plugin-form` -> `plugins/plugin-form`
- `packages/core/src/features/advanced-capabilities/form`
- Any package registry/tsconfig/package references to plugin-form/core form

TODO:
- [ ] Rename package/folder to `plugins/plugin-form`.
- [ ] Delete duplicated core form runtime implementation.
- [ ] Keep type-only exports in core if other packages depend on them.
- [ ] Ensure `FORM_CONTEXT`, `form_evaluator`, `FORM_RESTORE`, and `FORM` serviceType have only one owner.
- [ ] Update plugin registry entries and package names.
- [ ] Convert form prompts/provider output to TOON.
- [ ] Add tests for form restore, provider context, evaluator, and service registration.

Acceptance:
- Form is self-contained as `plugin-form`; core no longer registers duplicate form service/action/provider/evaluator.

## Workstream 20 - Voice Consolidation

Owner paths:
- `plugins/plugin-simple-voice`
- `plugins/plugin-robot-voice`
- Registry entries under `packages/app-core/src/registry/entries/plugins`
- Any references in examples/cloud migrations/UI types

TODO:
- [ ] Reconfirm current references.
- [ ] Keep the referenced voice plugin (`plugin-simple-voice` unless references changed).
- [ ] Delete duplicate `plugin-robot-voice` and registry entry.
- [ ] Ensure `SAY_ALOUD` and `SAM_TTS` appear once.
- [ ] Convert action docs/prompts to TOON if needed.
- [ ] Add/adjust tests for TTS serviceType and action registration.

Acceptance:
- One SAM TTS service, one `SAY_ALOUD` action.

## Workstream 21 - Phone/Wifi/Contacts Action Consolidation

Owner paths:
- `plugins/app-phone`
- `plugins/app-wifi`
- `plugins/app-contacts`
- `packages/agent/src/runtime/android-app-plugins.ts`
- Any runtime import sites for android app plugin actions

TODO:
- [ ] Treat `android-app-plugins.ts` as a temporary circular-dependency escape hatch, not canonical source.
- [ ] Move real implementations into the owning plugin packages or a clearly named shared helper.
- [ ] Remove duplicated action declarations from agent runtime once plugin exports are usable.
- [ ] Keep mobile/desktop bundling constraints explicit in comments/tests.
- [ ] Collapse read-only `LIST_CONTACTS` to provider if not a live operation.
- [ ] Add tests for `PLACE_CALL`, `READ_CALL_LOG`, `SCAN_WIFI`, contacts.

Acceptance:
- No action is redeclared as an agent stub.
- No vague "native-only" package is introduced.

## Workstream 22 - Wallet Core Chain Router

Owner paths:
- `plugins/plugin-wallet/src/chains`
- `plugins/plugin-wallet/src/services`
- `plugins/plugin-wallet/src/types`
- `plugins/plugin-wallet/src/index.ts`

TODO:
- [ ] Make one wallet aggregator service own planner-facing wallet capability registration.
- [ ] Use existing `IWalletService` / `ITokenDataService` where possible.
- [ ] Add internal chain handler registry: chain id/name, supported actions, tokens, signer requirements, dry-run support.
- [ ] Collapse `SWAP`, `SWAP_SOLANA`, `TRANSFER`, `TRANSFER_TOKEN`, `WALLET_SWAP`, `WALLET_TRANSFER`, `CROSS_CHAIN_TRANSFER`, `PREPARE_TRANSFER` into a small set of wallet router actions.
- [ ] Parameters should be uniform: `subaction`, `chain`, `fromToken`, `toToken`, `amount`, `recipient`, `slippageBps`, `mode` (`prepare|execute`), `dryRun`.
- [ ] If chain omitted and only one handler supports subaction, default. If multiple, ask for clarification.
- [ ] Add tests for EVM swap/transfer, Solana swap/transfer, unsupported chain, ambiguous chain, dry-run.

Acceptance:
- Planner sees one wallet action family; chain behavior is dynamically registered.

## Workstream 23 - Solana Service Deduplication

Owner paths:
- `plugins/plugin-wallet/src/chains/solana/service.ts`
- `plugins/plugin-wallet/src/chains/solana/actions`
- `plugins/plugin-wallet/src/chains/solana/providers`
- Solana tests

TODO:
- [ ] Collapse `SolanaService` and `SolanaWalletService` responsibilities or clearly split one public service plus internal helper.
- [ ] Remove duplicate serviceType hazards.
- [ ] Convert Solana `SWAP_SOLANA` / `TRANSFER` action implementation to chain handler methods.
- [ ] Wrap financial LLM parameter extraction in trajectories.
- [ ] Add confirmation/approval gates if missing for on-chain writes.
- [ ] Update generated specs after action deletions.

Acceptance:
- One Solana wallet/service registration path; no duplicate planner actions.

## Workstream 24 - EVM Wallet Router Migration

Owner paths:
- `plugins/plugin-wallet/src/chains/evm`
- EVM action tests/specs

TODO:
- [ ] Convert EVM transfer/swap action implementation into chain handler methods.
- [ ] Remove duplicate planner actions once wallet router owns them.
- [ ] Preserve network/chain ID support.
- [ ] Ensure all LLM extraction/judgment calls are traced.
- [ ] Keep transaction preparation/execution safety semantics intact.

Acceptance:
- EVM is one registered chain implementation under the wallet router.

## Workstream 25 - Wallet Birdeye And Token Intel Compression

Owner paths:
- `plugins/plugin-wallet/src/analytics/birdeye`

TODO:
- [ ] Delete `BIRDEYE_TEST_ALL_ENDPOINTS`.
- [ ] Collapse address/symbol token search actions into the unified `SEARCH` category or wallet/token intel subaction.
- [ ] Collapse duplicate portfolio providers with a factory.
- [ ] Fix spelling/semantic quality in compressed descriptions.
- [ ] Render provider output as TOON.
- [ ] Add tests for token search by symbol/address and portfolio provider factory.

Acceptance:
- Birdeye contributes token intel/search/providers without a large standalone action surface.

## Workstream 26 - DEX LP Management Unification

Owner paths:
- `plugins/plugin-wallet/src/lp`
- `plugins/plugin-wallet/src/chains/evm/dex`
- `plugins/plugin-wallet/src/chains/solana/dex`

TODO:
- [ ] Use existing `ILpService` as the base where possible.
- [ ] Add `LpManagementService` as the aggregator/registry for protocols.
- [ ] Convert Raydium, Orca, Meteora, Uniswap, Aerodrome, PancakeSwap into registered LP protocol providers.
- [ ] Collapse LP planner actions into one LP management action with `subaction`, `chain`, `dex`, `pool`, `position`, amounts/ranges.
- [ ] Delete `MockLpService` or move to tests only.
- [ ] Deduplicate identical reposition evaluators.
- [ ] Add tests for protocol registration, pool listing, open/close/reposition, no matching protocol.

Acceptance:
- One LP management surface with network/protocol registrations.

## Workstream 27 - app-2004scape And app-scape Game Action Routers

Owner paths:
- `plugins/app-2004scape`
- `plugins/app-scape`

TODO:
- [ ] Deduplicate overlapping actions: `ATTACK_NPC`, `DROP_ITEM`, `EAT_FOOD`, `WALK_TO`.
- [ ] Collapse 2004scape action table to routers: movement, interaction, combat, inventory, banking, shop, skilling, dialogue.
- [ ] Preserve autonomous loop behavior.
- [ ] Wrap autonomous game loop LLM calls in standalone trajectories.
- [ ] Render game state providers as TOON.
- [ ] Keep app-specific differences explicit; do not force shared abstraction if game APIs differ.
- [ ] Add tests for router dispatch and duplicate action names removed.

Acceptance:
- Each game exposes compressed action groups, not dozens of planner actions.

## Workstream 28 - Minecraft And Roblox Cleanup

Owner paths:
- `plugins/plugin-minecraft`
- `plugins/plugin-roblox`

TODO:
- [ ] Collapse Minecraft actions into `MC_ACTION` with subactions for connect, movement, look, scan, dig/place, chat, attack, waypoints.
- [ ] Move waypoint list/read state to provider where possible.
- [ ] Fix compressed descriptions.
- [ ] Remove empty Roblox provider output or make it real.
- [ ] Collapse Roblox actions into one router if still useful.
- [ ] Delete browser/server stubs that ship pointless runtime surface.
- [ ] Add tests for Minecraft router and Roblox provider behavior.

Acceptance:
- No empty providers; game automation action surface is compact.

## Workstream 29 - LifeOps Router Compression A

Owner paths:
- `plugins/app-lifeops/src/actions/calendar.ts`
- `plugins/app-lifeops/src/actions/gmail.ts`
- `plugins/app-lifeops/src/actions/lifeops-google-helpers.ts`
- Related tests

TODO:
- [ ] Keep existing broad `CALENDAR_ACTION` / Gmail action router pattern.
- [ ] Reduce repeated `runtime.useModel` chains by centralizing extraction.
- [ ] Ensure every extraction/judgment LLM call traces.
- [ ] Convert planner prompts to TOON.
- [ ] Demote read-only list/status where provider context is sufficient.
- [ ] Add regression tests for common calendar/gmail subactions.

Acceptance:
- Fewer model calls per turn; all calls traced; action surface remains compressed.

## Workstream 30 - LifeOps Router Compression B

Owner paths:
- `plugins/app-lifeops/src/actions/lifeops-connector.ts`
- `plugins/app-lifeops/src/actions/cross-channel-send.ts`
- `plugins/app-lifeops/src/actions/inbox.ts`
- `plugins/app-lifeops/src/providers/cross-channel-context.ts`

TODO:
- [ ] Align LifeOps connector handling with the core connector registry.
- [ ] Remove duplicate send behavior now owned by `SEND_MESSAGE`, unless LifeOps needs approval/escalation policy semantics.
- [ ] Convert connector status reads to providers where possible.
- [ ] Ensure inbox triage/generation LLM calls trace.
- [ ] Render cross-channel context as TOON.

Acceptance:
- LifeOps does not duplicate connector routing; it adds policy/workflow semantics.

## Workstream 31 - LifeOps Router Compression C

Owner paths:
- `plugins/app-lifeops/src/actions/relationships.ts`
- `plugins/app-lifeops/src/actions/dossier.ts`
- `plugins/app-lifeops/src/actions/health.ts`
- `plugins/app-lifeops/src/actions/website-blocker.ts`
- `plugins/app-lifeops/src/actions/autofill.ts`
- `plugins/app-lifeops/src/followup`

TODO:
- [ ] Keep state-changing operations as actions.
- [ ] Move pure status/list views to providers where efficient.
- [ ] Collapse related operations into subactions where not already routered.
- [ ] Wrap all LLM calls in trajectories.
- [ ] Convert prompts/examples to TOON.
- [ ] Add focused tests per router.

Acceptance:
- LifeOps remains capable but main planning context is smaller.

## Workstream 32 - Music Library And Music Player Compression

Owner paths:
- `plugins/plugin-music-library`
- `plugins/plugin-music-player`
- `plugins/plugin-suno`

TODO:
- [ ] Collapse six music-library service classes into one domain service with internal helpers.
- [ ] Convert YouTube/Wikipedia lookup into search category registrations.
- [ ] Collapse music library actions into router groups: library, playlist, metadata/search.
- [ ] Move `MUSIC_PLAYER_INSTRUCTIONS` / `MUSIC_INFO_INSTRUCTIONS` out of provider registry into prompt templates or action docs.
- [ ] Collapse Suno generate/custom/extend into one `MUSIC_GENERATION` action with subactions.
- [ ] Wrap Suno provider raw fetch generation in `recordLlmCall`.
- [ ] Render provider output as TOON.
- [ ] Add tests for service consolidation and generation trajectory.

Acceptance:
- Music plugins expose compact actions and no instruction-only providers.

## Workstream 33 - Browser And Computer Use Cleanup

Owner paths:
- `plugins/app-browser`
- `plugins/plugin-browser-bridge`
- `plugins/plugin-computeruse`
- `plugins/plugin-vision`

TODO:
- [ ] Delete dead nested ternary/slop in `plugins/app-browser/src/action.ts`.
- [ ] Keep browser action router compact; avoid re-expanding into many planner actions.
- [ ] Ensure computer-use/vision model calls trace.
- [ ] Convert model-facing prompts to TOON.
- [ ] Demote read-only browser state to providers when possible.
- [ ] Add tests for browser router parsing and trajectory capture.

Acceptance:
- Browser/computer use remains one compact tool surface with traced model calls.

## Workstream 34 - Coding/Agent Orchestration Trajectory

Owner paths:
- `plugins/plugin-agent-orchestrator`
- `plugins/plugin-app-control`
- `plugins/plugin-claude-code-workbench`
- `plugins/plugin-agent-skills`
- `plugins/plugin-executecode`

TODO:
- [ ] Use `spawnWithTrajectoryLink` for spawned coding agents/workbench/app-control paths.
- [ ] Keep `plugin-executecode` trajectory behavior as reference; do not regress it.
- [ ] Link child task/agent trajectories to parent step IDs.
- [ ] Collapse list/status actions into providers if they are read-only.
- [ ] Ensure skill search migrates to unified `SEARCH`.
- [ ] Convert prompts to TOON.
- [ ] Add tests for parent-child linkage.

Acceptance:
- Spawned agent work is trace-linked to the parent request.

## Workstream 35 - Automation/Productivity Plugins

Owner paths:
- `plugins/plugin-linear`
- `plugins/plugin-github`
- `plugins/plugin-n8n-workflow`
- `plugins/plugin-mcp`
- `plugins/plugin-google-meet-cute`
- `plugins/plugin-calendly`
- `plugins/plugin-shopify`

TODO:
- [ ] Collapse Linear actions into router groups: issue, project/team, comment, workflow/search category.
- [ ] Move Linear/GitHub/Shopify searches to unified `SEARCH`.
- [ ] Remove Google Meet placeholder report strings or replace with real implementation.
- [ ] Collapse MCP read/list/resource actions where appropriate.
- [ ] Fix Calendly compressed descriptions.
- [ ] Convert prompts/examples to TOON.
- [ ] Ensure all LLM calls trace.
- [ ] Add tests for routers and search categories.

Acceptance:
- Productivity plugins expose fewer, more semantically dense actions.

## Workstream 36 - System/Runtime Slop Deletion

Owner paths:
- `plugins/plugin-ngrok`
- `plugins/app-workflow-builder`
- `packages/examples`
- `plugins/plugin-wallet/src/lp/services/MockLpService.ts`
- `cloud/packages/lib/eliza`
- Template directories if they ship runtime actions

TODO:
- [ ] Delete empty `plugin-ngrok`.
- [ ] Delete or complete `app-workflow-builder/src/register.ts`; no placeholder registration.
- [ ] Remove example services from runtime/package exports.
- [ ] Delete stale cloud duplicate plugin copies if not used by active build.
- [ ] Ensure template placeholder action `__PLUGIN_NAME___HELLO` cannot ship in runtime docs/registries.
- [ ] Add/adjust knip or static checks to keep these out.

Acceptance:
- No placeholder/test/example code is registered in production runtime.

## Workstream 37 - Trust/Security Evaluator Disablement

Owner paths:
- `packages/core/src/features/trust`
- Any trust evaluator registration files/tests

TODO:
- [ ] Disable `trustChangeEvaluator`.
- [ ] Disable `securityEvaluator`.
- [ ] Ensure neither has `alwaysRun: true` in active registrations.
- [ ] Keep code only if tests or explicit opt-in feature flags need it.
- [ ] Add tests that default evaluator list excludes both.

Acceptance:
- These evaluators do not run on every message.

## Workstream 38 - ServiceType Collision Guard And Collision Fixes

Owner paths:
- `packages/core/src/runtime.ts`
- `packages/core/src/plugin-lifecycle.ts`
- Collision sites:
  - form service
  - SAM TTS
  - tailscale tunnel services
  - trust-engine wrapper/service

TODO:
- [ ] Add runtime/plugin lifecycle warning or error for duplicate serviceType registrations where overwrite or ambiguous `getService` behavior would occur.
- [ ] Fix `FORM` via plugin-form workstream.
- [ ] Fix `SAM_TTS` via voice workstream.
- [ ] Split or merge tailscale serviceTypes (`tunnel:cloud`, `tunnel:local`) if both are legitimate.
- [ ] Fix trust-engine wrapper collision by deleting wrapper or giving it a distinct serviceType.
- [ ] Add a static test that scans service classes for duplicate `serviceType` values and allowlists intentional multi-service types only.

Acceptance:
- Duplicate serviceType hazards are caught before runtime.

## Workstream 39 - DescriptionCompressed Quality Sweep

Owner paths:
- Bad-description plugins identified by audit:
  - `plugins/plugin-calendly`
  - `plugins/plugin-minecraft`
  - `plugins/plugin-roblox`
  - `plugins/plugin-wallet/src/analytics/birdeye`
  - `plugins/plugin-mysticism`
  - Any generated specs that include empty/broken compressed descriptions

TODO:
- [ ] Add a lint/check for empty, duplicated, overlong, keyword-soup, or ungrammatical `descriptionCompressed`.
- [ ] Hand-write high-signal descriptions for the worst offenders.
- [ ] Prefer verb + object + disambiguator.
- [ ] Remove filler: "this action", "allows user", "used to", "simply", "currently".
- [ ] Ensure descriptions preserve semantic routing terms: chain, category, connector, source, subaction, live/read/write.
- [ ] Add CI script or unit test.

Acceptance:
- Worst compressed descriptions are fixed and future regressions fail locally.

## Workstream 40 - Generated Docs And Spec Regeneration

Owner paths:
- `packages/core/src/generated`
- `plugins/**/generated/specs`
- Build scripts that generate specs/action docs

TODO:
- [ ] Wait until code-owning agents finish action renames/deletions locally, then regenerate docs.
- [ ] Remove docs for deleted actions.
- [ ] Ensure umbrella actions include compact examples and parameter schemas.
- [ ] Ensure generated docs preserve TOON examples.
- [ ] Add snapshot updates only where action surface intentionally changed.

Acceptance:
- Generated docs match the final runtime action/provider/evaluator surface.

## Workstream 41 - Duplicate Component Static Audit

Owner paths:
- New or existing scripts under `scripts/`, `packages/core/scripts`, or repo tooling
- Tests/check scripts

TODO:
- [ ] Add a script that scans `packages/` and `plugins/` for instantiated/exported `Action`, `Provider`, `Evaluator`, and `Service` definitions.
- [ ] Report duplicate action/provider/evaluator names.
- [ ] Report duplicate serviceTypes.
- [ ] Report instruction-only providers.
- [ ] Report empty providers.
- [ ] Report actions without params that should be routers/list providers by naming heuristics.
- [ ] Report XML/JSON planner prompts where TOON should be used.
- [ ] Report raw `runtime.useModel`, SDK `generateText`, SDK `generateObject`, and `fetch` generation paths without trajectory wrapper markers.
- [ ] Add CI-friendly output and allowlist intentional cases.

Acceptance:
- Future slop/dedup regressions are machine-detectable.

## Workstream 42 - Verification And Integration

Owner paths:
- No feature ownership; this agent integrates returned patches and owns test execution.

TODO:
- [ ] Keep a live merge board of workstream ownership and conflicts.
- [ ] After each returned patch, run targeted tests for that package.
- [ ] Run `bun run verify`.
- [ ] Run package tests affected by changed plugins.
- [ ] Run duplicate component static audit.
- [ ] Run TOON/description lint.
- [ ] Run trajectory strict-mode tests.
- [ ] Re-run serviceType collision scan.
- [ ] Smoke-test runtime with plugin-form, plugin-web-search, plugin-wallet, and at least two message connectors registered.
- [ ] Smoke-test a context-routed wallet request, a connector send request, and a search request.

Acceptance:
- Main branch compiles/tests.
- Action/provider/evaluator/service duplicates are gone or explicitly allowlisted.
- Planner context is smaller, TOON-formatted, and capability-routed.
- All LLM-like calls are traceable.
