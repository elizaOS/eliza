# Phase 3 - Naming, Shims, And Re-exports Dry Run

Status: dry run only. No source, config, test, route, asset, generated, or implementation file was changed.

Scope: names containing `unified`, `consolidated`, `new`, `legacy`, `deprecated`, `compat`, or `shim`, plus re-export-only files, barrels, and shim entrypoints.

## Scan Summary

Read-only scan commands:

```bash
git status --short
rg --files packages plugins cloud scripts test docs \
  -g '!packages/inference/llama.cpp/**' \
  -g '!packages/benchmarks/**' \
  -g '!reports/**' \
  -g '!docs/audits/repo-cleanup-2026-05-11/**' \
  -g '!docs/audits/lifeops-2026-05-09/**' \
  -g '!docs/audits/lifeops-2026-05-11/**' \
  -g '!packages/app-core/platforms/electrobun/build/**' \
  -g '!packages/app-core/test/contracts/lib/openzeppelin-contracts/**' \
  | rg -i '(^|/|[-_.])(unified|consolidated|new|legacy|deprecated|compat|shim)([-_.]|/|$)'
node scripts/audit-package-barrels.mjs --check
```

Results at scan time:

- 158 matching filenames across the whole repo.
- 96 matching filenames after excluding vendored/generated/build/audit-output paths.
- 70 scoped TS/JS source or test matches.
- Per-term scoped filename counts: `compat` 57, `legacy` 23, `shim` 17, `unified` 5, `new` 4, `consolidated` 0, `deprecated` 0.
- 206 scoped re-export-only/barrel/shim candidates by a conservative line-shape probe.
- Existing Phase 2 barrel gate still reports 22 workspace subpath refs, 266 published subpath exports, and 630 re-export markers.

The worktree was already dirty, including unrelated modified and conflicted files. This report intentionally does not touch them.

## Highest Confidence Action

| File | Exported identifiers | Imports/usages found | Recommendation | Risk | Validation |
| --- | --- | --- | --- | --- | --- |
| `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` | `ResolvedContactShim`, `ContactResolverShim`, `createContactResolverShim` | No live imports found. Matches are the file itself plus historical audit references in `plugins/app-lifeops/docs/audit/IMPLEMENTATION_PLAN.md`. | Delete in an implementation PR if a fresh grep is still clean. This aligns with the file's own deletion note and the LifeOps one-graph-store direction. | Medium. It is under LifeOps entity resolution, so validate against the `EntityStore` and `RelationshipStore` contracts before removal. | `rg -n 'createContactResolverShim\|ContactResolverShim\|ResolvedContactShim\|resolver-shim' plugins/app-lifeops packages plugins test docs`; `bun run --cwd plugins/app-lifeops verify`; `bun run typecheck`. |

## Do Not Delete During Cleanup

These are active compatibility layers or public concepts. Some may be renamed later, but none are safe deletion candidates from naming alone.

| File(s) | Exported identifiers | Imports/usages found | Recommendation | Risk | Validation |
| --- | --- | --- | --- | --- | --- |
| `plugins/app-lifeops/src/actions/inbox-unified.ts`; `plugins/app-lifeops/test/inbox-unified-action.test.ts` | `InboxUnifiedPlatform`, `InboxUnifiedItem`, `InboxUnifiedSummaryEntry`, `InboxUnifiedResult`, `InboxUnifiedFetcher`, `InboxUnifiedFetchers`, `setInboxUnifiedFetchers`, `__resetInboxUnifiedFetchersForTests`, `inboxUnifiedAction` | Registered in `plugins/app-lifeops/src/plugin.ts`; unit tested by `inbox-unified-action.test.ts`; generated into `packages/prompts/specs/actions/plugins.generated.json` and `packages/core/src/generated/action-docs.ts`; documented in `packages/docs/action-prd-map.md`. | Do not rename until action API owners decide whether public action name `INBOX_UNIFIED` is permanent. If only filename cleanup is desired, rename source/test files while preserving the action name and generated specs. | High. Action names and generated prompt specs are externally visible behavior. | `rg -n 'inboxUnified\|InboxUnified\|INBOX_UNIFIED\|inbox-unified'`; `bun run --cwd plugins/app-lifeops verify`; regenerate action docs if any source action metadata changes. |
| `plugins/plugin-wallet/src/providers/unified-wallet-provider.ts` | `unifiedWalletProvider` | Exported from `plugins/plugin-wallet/src/index.ts`; imported by `plugins/plugin-wallet/src/plugin.ts` and registered in the provider list. | Keep unless product renames the provider concept. `unified` describes one provider surface over multiple wallet chains. | Low to medium. Rename is local but public plugin exports may be consumed downstream. | `rg -n 'unifiedWalletProvider\|unified-wallet-provider' plugins/plugin-wallet packages plugins test docs`; `bun run --cwd plugins/plugin-wallet test`; `bun run typecheck`. |
| `plugins/plugin-wallet/src/browser-shim/index.ts`; `plugins/plugin-wallet/src/browser-shim/build-shim.ts`; `plugins/plugin-wallet/src/browser-shim/shim.template.js`; `packages/browser-bridge/entrypoints/wallet-shim.ts` | `buildWalletShim`, `buildWalletShimFromTemplate`, `WalletShimConfig` from the barrel; content-script entrypoint exports none | `packages/browser-bridge/scripts/build.mjs` inlines/builds the wallet shim; wallet signing route comments reference `browser-shim`; UI vault client comments mirror the contract. | Keep. This is an actual browser injection shim, not a stale compatibility alias. The `index.ts` barrel is acceptable if the browser-shim directory remains a public submodule. | Medium. Browser extension load order and wallet injection timing are fragile. | `rg -n 'buildWalletShim\|WalletShimConfig\|browser-shim\|wallet-shim'`; `bun run test:browser-bridge`; `bun run --cwd plugins/plugin-wallet test`. |
| `plugins/plugin-discord/compat.ts` | `WorldCompat`, `RoomCompat`, `EnsureConnectionParams`, `ICompatRuntime`, `createCompatRuntime` | Used by `voice.ts`, `service.ts`, `messages.ts`, `discord-history.ts`, `discord-interactions.ts`, and tests; documented in `plugins/plugin-discord/README.md`. | Keep until the supported `@elizaos/core` version floor no longer needs `serverId` and `messageServerId` dual handling. Then remove in one PR with service constructor/runtime type cleanup. | High. A premature delete breaks Discord room/world creation across core versions. | `rg -n 'createCompatRuntime\|ICompatRuntime\|WorldCompat' plugins/plugin-discord`; `bun run --cwd plugins/plugin-discord typecheck`; `bun run --cwd plugins/plugin-discord test`. |
| `plugins/plugin-workflow/src/lib/legacy-task-migration.ts`; `plugins/plugin-workflow/src/lib/legacy-text-trigger-migration.ts`; `plugins/plugin-workflow/__tests__/unit/legacy-migrations.test.ts` | `LegacyTaskMigrationSummary`, `migrateLegacyWorkbenchTasks`, `LegacyTextTriggerMigrationSummary`, `migrateLegacyTextTriggers` | Imported via `plugins/plugin-workflow/src/lib/index.ts`; invoked during plugin init in `plugins/plugin-workflow/src/index.ts`; unit tested. | Keep while installed users may still have legacy task records. After an owner sets a migration sunset, replace boot-time migration with an explicit one-shot script and then remove. | High. Delete can strand existing workflow/task data. | `rg -n 'migrateLegacyWorkbenchTasks\|migrateLegacyTextTriggers\|legacy-.*migration' plugins/plugin-workflow`; `bun run --cwd plugins/plugin-workflow test:unit`; `bun run --cwd plugins/plugin-workflow typecheck`. |
| `cloud/apps/api/compat/**` | Route files export default Hono apps; helpers export `CompatAuthResult`, `requireCompatAuth`, `handleCompatCorsOptions`, `withCompatCors`, `handleCompatError` | File-path routed API surface for `/api/compat/*`; uses `compat-envelope` and auth/CORS/error helpers; covered by `cloud/packages/tests/e2e/v1/compat.test.ts` and unit tests. | Keep. This is a public compatibility API path, not internal cruft. Rename only as part of a versioned API deprecation plan. | High. Public route deletion breaks thin clients and bridge clients. | `bun run --cwd cloud test:e2e:v1`; `bun run --cwd cloud test:unit`; `bun run --cwd cloud typecheck`. |
| `cloud/packages/lib/api/compat-envelope.ts` | `CompatAgentShape`, `toCompatAgent`, `CompatCreateResultShape`, `toCompatCreateResult`, `CompatOpResultShape`, `toCompatOpResult`, `CompatJobShape`, `toCompatJob`, `CompatStatusShape`, `toCompatStatus`, `CompatUsageShape`, `toCompatUsage`, `mapStatus`, `envelope`, `errorEnvelope` | Exported from `cloud/packages/lib/index.ts`; imported by compat routes; covered by `cloud/packages/tests/unit/compat-envelope.test.ts`. | Keep while `/api/compat/*` exists. If the API becomes canonical, rename to `thin-client-envelope.ts` only with route and import updates. | High. Response shape is a wire contract. | `rg -n 'compat-envelope\|toCompatAgent\|toCompatJob\|errorEnvelope' cloud`; `bun run --cwd cloud test:unit`; `bun run --cwd cloud typecheck`. |
| `cloud/packages/lib/services/app-domains-compat.ts` | `SyncCustomDomainInput`, `setCustomDomain`, `clearCustomDomain`, `appDomainsCompat` | Imported by `cloud/apps/api/v1/apps/[id]/domains/buy/route.ts` and `cloud/apps/api/v1/apps/[id]/domains/route.ts`; unit tests mock `appDomainsCompat`. | Keep until the legacy `app_domains.custom_domain` read path is removed from dashboard/domain flows. Possible later rename: `sync-app-domain-legacy-row.ts`. | Medium. It bridges old and new domain tables; deletion can desync visible custom domains. | `rg -n 'appDomainsCompat\|setCustomDomain\|clearCustomDomain' cloud/apps cloud/packages`; `bun run --cwd cloud test:unit`; `bun run --cwd cloud typecheck`. |
| `cloud/packages/lib/eliza/runtime/database/adapter-compat.ts` | `applyLegacyDatabaseAdapterCompat` | Imported by `cloud/packages/lib/eliza/runtime/database/adapter-pool.ts`. | Keep unless the legacy database adapter API is fully removed. Consider renaming to `legacy-database-adapter.ts` only if the code remains long term. | Medium. Adapter pool behavior changes can affect cloud runtime boot. | `rg -n 'applyLegacyDatabaseAdapterCompat\|adapter-compat' cloud/packages/lib`; `bun run --cwd cloud typecheck`; cloud runtime tests. |
| `plugins/plugin-elizacloud/src/routes/cloud-compat-routes.ts` | `CloudCompatRouteState`, `resolveCloudBaseUrl`, `handleCloudCompatRoute` | Exported by plugin root and node entrypoint; imported by `packages/app-core/src/api/server.ts`, `packages/agent/src/api/server-route-dispatch.ts`, and route registry typing. | Keep while app-core/agent dispatches cloud compatibility paths. Rename only with server route ownership cleanup. | High. Server route dispatch depends on it. | `rg -n 'handleCloudCompatRoute\|cloud-compat-routes' packages plugins`; `bun run --cwd packages/app-core typecheck`; `bun run --cwd packages/agent typecheck`. |
| `plugins/plugin-computeruse/src/routes/computer-use-compat-routes.ts` | `handleComputerUseCompatRoutes`, `computerUseRouteHandler` | Self-used by route handler factory; exported from plugin route module. | Keep if route aliases are still supported. Treat as a route-ownership item, not naming cleanup. | Medium. Computer-use route compatibility can affect desktop/browser flows. | `rg -n 'handleComputerUseCompatRoutes\|computerUseRouteHandler' plugins packages`; plugin computer-use route smoke. |
| `plugins/app-steward/src/routes/*-compat-routes.ts` | `handleWalletTradeCompatRoutes`, `handleStewardCompatRoutes`, `safeParseBigInt`, `handleWalletBrowserCompatRoutes`, `handleWalletCompatRoutes` | Imported and registered in `plugins/app-steward/src/plugin.ts` across multiple wallet/steward routes. | Keep until route aliases are formally sunset. If renamed, keep route path compatibility separate from implementation filename cleanup. | High. Wallet/steward routes may be used by external clients and local app flows. | `rg -n 'handleWallet.*CompatRoutes\|handleStewardCompatRoutes' plugins/app-steward`; app-steward route tests/smoke. |
| `packages/app-core/src/api/*-compat-routes.ts`; `packages/app-core/src/api/compat-route-shared.ts` | `CompatRuntimeState`, `clearCompatRuntimeRestart`, `scheduleCompatRuntimeRestart`, `DATABASE_UNAVAILABLE_MESSAGE`, `isLoopbackRemoteAddress`, `isTrustedLocalRequest`, `readCompatJsonBody`, `hasCompatPersistedOnboardingState`, `getConfiguredCompatAgentName`, `getCompatDrizzleDb`, plus route handlers | Imported heavily by `packages/app-core/src/api/server.ts`, auth/session/bootstrap/payment/internal route modules, and tests. | Keep. This is an active local API compatibility layer. Later split shared helpers into neutral names and keep route aliases only at the boundary. | High. Shared helpers are used outside compat route files. | `rg -n 'compat-route-shared\|handle.*CompatRoutes' packages/app-core/src/api`; `bun run --cwd packages/app-core typecheck`; `bun run --cwd packages/app-core test`. |
| `packages/app-core/src/ui-compat.ts` | Re-export-only: `export * from "@elizaos/ui"` | Exported by `packages/app-core/src/index.ts`; appears in mobile/electrobun bundles. | Keep as a temporary public bridge for consumers still importing UI through `@elizaos/app-core`. Add a deprecation window before deleting. | High. Public package surface compatibility. | `rg -n 'ui-compat\|@elizaos/app-core' packages plugins cloud test`; `bun run --cwd packages/app-core typecheck`; `bun run --cwd packages/ui typecheck`; package export audit. |
| `packages/core/src/utils/crypto-compat.ts` | `createHash`, `createHashAsync`, `createCipheriv`, `createDecipheriv`, `encryptAsync`, `decryptAsync`, `encryptAes256Gcm`, `decryptAes256Gcm` | Imported by `packages/core/src/settings.ts` and `packages/core/src/runtime/context-hash.ts`; exported through core node/browser indexes. | Keep. `compat` here means cross-platform Node/browser crypto abstraction. | Medium. Crypto API changes are security-sensitive. | `rg -n 'crypto-compat\|createHashAsync\|encryptAes256Gcm' packages/core packages plugins`; `bun run --cwd packages/core test`; `bun run --cwd packages/core typecheck`. |
| `packages/core/src/runtime/schema-compat.ts` | `sanitizeFunctionNameForCerebras`, `normalizeSchemaForCerebras` | Exported by core node/browser indexes; imported by `plugins/plugin-openai/models/text.ts`; covered by `schema-compat.test.ts`. | Keep. Optional later rename to `provider-schema-normalization.ts` or `cerebras-schema-compat.ts` if owner wants provider-specific naming. | Medium. Strict grammar providers can regress if renamed incorrectly. | `rg -n 'schema-compat\|normalizeSchemaForCerebras\|sanitizeFunctionNameForCerebras' packages plugins`; `bun run --cwd packages/core test -- runtime/__tests__/schema-compat.test.ts`; `bun run --cwd plugins/plugin-openai typecheck`. |
| `packages/agent/src/services/version-compat.ts` | `PluginCompatResult`, `VersionCompatReport`, `AI_PROVIDER_PLUGINS`, `parseSemver`, `compareSemver`, `versionSatisfies`, `coreExportExists`, `getInstalledVersion`, `validatePluginCompat`, `diagnoseNoAIProvider` | Exported by `packages/agent/src/services/index.ts`; used by `update-checker.ts` and `runtime/plugin-resolver.ts`; documented in package docs. | Keep. Rename only if diagnostics become the canonical version policy module. | Medium. Affects plugin failure diagnostics. | `rg -n 'version-compat\|validatePluginCompat\|diagnoseNoAIProvider' packages/agent packages/docs`; `bun run --cwd packages/agent typecheck`; `bun run --cwd packages/agent test`. |
| `packages/agent/src/api/compat-utils.ts` | `extractCompatTextContent`, `OpenAiChatRole`, `OpenAiChatMessage`, `extractOpenAiSystemAndLastUser`, `AnthropicRole`, `AnthropicMessage`, `extractAnthropicSystemAndLastUser`, `resolveCompatRoomKey` | Exported by `packages/agent/src/api/index.ts`; imported by chat routes and helpers. | Keep. If OpenAI/Anthropic route support remains, the filename is accurate. | Medium. Chat API compatibility behavior is user-facing. | `rg -n 'compat-utils\|extractOpenAiSystemAndLastUser\|resolveCompatRoomKey' packages/agent`; `bun run --cwd packages/agent typecheck`; chat route tests. |
| `packages/agent/src/runtime/pglite-error-compat.ts` | `PGLITE_ERROR_CODES`, `PgliteErrorCode`, `PgliteInitError`, `createPgliteInitError`, `getPgliteErrorCode` | Imported by `packages/agent/src/runtime/eliza.ts`; duplicates logic from plugin-sql until published package exports it. | Keep until `@elizaos/plugin-sql` publishes the canonical error module. Then import from plugin-sql and delete this file. | Medium. Runtime recovery/error guidance depends on these codes. | `rg -n 'pglite-error-compat\|PgliteInitError\|createPgliteInitError' packages/agent plugins/plugin-sql`; `bun run --cwd packages/agent typecheck`; pglite runtime tests. |
| `packages/agent/src/test-utils/sqlite-compat.ts` | `SqliteValue`, `SqliteRow`, `SqliteRunResult`, `SqliteStatementCompat`, `SqliteDatabaseCompat`, `SqliteDatabaseSyncConstructor`, `hasSqlite`, `DatabaseSync`, `SqliteDatabaseSync` | Exported from `packages/agent/src/index.ts`; provides Bun/Node test compatibility. | Keep while tests run under both Node and Bun. Consider moving under a test-support-only package export if public root exposure is not needed. | Low to medium. Mostly test/runtime utility, but currently exported from agent root. | `rg -n 'sqlite-compat\|DatabaseSync' packages/agent packages/app-core plugins test`; `bun run --cwd packages/agent test`; package barrel audit. |

## Duplicate Or Rename Candidates

| File(s) | Exported identifiers | Imports/usages found | Recommendation | Risk | Validation |
| --- | --- | --- | --- | --- | --- |
| `packages/shared/src/utils/sql-compat.ts`; `packages/ui/src/utils/sql-compat.ts` | Both export `quoteIdent`, `sanitizeIdentifier`, `sqlLiteral`, `executeRawSql`, `ensureRuntimeSqlCompatibility` | Files are byte-identical, 171 lines each. Shared is exported by `packages/shared/src/index.ts`; UI is exported by `packages/ui/src/index.ts` and `packages/ui/src/utils/index.ts`. App-core imports SQL helpers from package barrels. | Choose `@elizaos/shared` as canonical. Convert the UI file to a compatibility re-export from shared, or update UI/root exports to forward shared without source duplication if the package graph allows it. | Medium. Avoid creating package cycles or changing UI public exports. | `diff -q packages/shared/src/utils/sql-compat.ts packages/ui/src/utils/sql-compat.ts`; `bun run --cwd packages/shared typecheck`; `bun run --cwd packages/ui typecheck`; `bun run --cwd packages/app-core typecheck`. |
| `packages/ui/src/api/agent-client-type-shim.ts` | `DatabaseProviderType`, `ReleaseChannel`, `CustomActionDef`, `CustomActionHandler`, `ConversationScope`, `ConversationAutomationType`, `ConversationMetadata`, `StreamEventType`, `TradePermissionMode`, `SignalPairingStatus`, `WhatsAppPairingStatus`, `TrajectoryExportFormat`, `TriggerLastStatus`, `TriggerRunRecord`, `TriggerType`, `TriggerWakeMode`, `TriggerTaskMetadata`, `TriggerSummary`, `TriggerHealthSnapshot`, `CreateTriggerRequest`, `UpdateTriggerRequest` | Same API types also appear in `packages/ui/src/api/client-types-core.ts` and are consumed by UI client/state/components. | Do not delete directly. Consolidate client trigger/config types first, then either remove this shim or turn it into a pure re-export with an expiry note. | Medium to high. Trigger and automation API types are shared across UI, agent, and workflow plugin. | `rg -n 'agent-client-type-shim\|CreateTriggerRequest\|TriggerSummary' packages/ui packages/agent plugins test`; `bun run --cwd packages/ui typecheck`; `bun run --cwd packages/agent typecheck`. |
| `packages/ui/src/components/ui/new-action-button.tsx` | `NewActionButtonProps`, `NewActionButton` | Re-exported by `packages/ui/src/components/composites/index.ts`; used by chat sidebar and Heartbeats view. | Rename to a semantic UI name only if design owners choose one, for example `CreateActionButton` or `AddItemButton`. Do not delete. | Low. Local UI rename plus exports, but component is in a public UI package. | `rg -n 'NewActionButton\|new-action-button' packages/ui`; `bun run --cwd packages/ui typecheck`; targeted UI smoke. |
| `cloud/apps/frontend/src/components/landing/landing-page-new.tsx` | `LandingPage` | Imported only by `cloud/apps/frontend/src/pages/page.tsx`; older homepage has `packages/homepage/src/components/landing/landing-page.tsx`. | Rename to `landing-page.tsx` inside cloud frontend only after verifying no collision in that folder. | Low. Single import, but cloud frontend route is public. | `rg -n 'landing-page-new\|LandingPage' cloud/apps/frontend packages/homepage`; `bun run --cwd cloud/apps/frontend typecheck`; `bun run --cwd cloud typecheck`. |
| `packages/vault/test/vitest-assertion-shim.ts`; `test/vitest/shims/*`; `cloud/packages/tests/support/bun-partial-module-shims.ts`; app/example shims | Test setup or environment shim exports vary by file | Used by test configs or example bundlers. | Keep unless a test config grep proves unused. Rename only if the shim no longer adapts anything. | Low to medium. Test shims are easy to misclassify as unused because config files load them indirectly. | `rg -n 'vitest-assertion-shim\|test/vitest/shims\|bun-partial-module-shims' .`; relevant package test command. |

## Re-export-Only And Barrel Findings

The repository has too many barrels to treat all re-export-only files as cleanup targets. A policy pass should separate intentional public entrypoints from accidental deep-import compatibility.

| File or group | Exported identifiers | Imports/usages found | Recommendation | Risk | Validation |
| --- | --- | --- | --- | --- | --- |
| Root package barrels such as `packages/app-core/src/index.ts`, `packages/agent/src/index.ts`, `packages/ui/src/index.ts`, `packages/shared/src/index.ts`, `packages/core/src/index.ts`, plugin root `index.ts` files | Mostly `export *` plus selected named exports | Package entrypoints, package `exports`, and downstream imports. Phase 2 package-barrel audit found 266 published subpath exports and 630 re-export markers. | Do not delete in naming cleanup. Define allowed public APIs and subpaths first; remove wildcard `./*` package exports last. | High. This is public package API. | `bun run audit:package-barrels`; `bun run audit:package-barrels:check`; package typechecks for affected owners. |
| Platform conditional barrels like `plugins/plugin-bluesky/index.node.ts`, `plugins/plugin-farcaster/index.node.ts`, `plugins/plugin-edge-tts/index.ts`, `plugins/plugin-edge-tts/index.browser.ts`, `plugins/plugin-xai/index.node.ts`, `plugins/plugin-local-ai/index.node.ts` | Usually `export * from "./index"` plus default export | Referenced by package conditional exports and bundlers. | Keep. These are not cleanup shims unless package exports prove they are unreachable. | Medium. Conditional exports are easy to break. | Inspect each package `exports`; run package build/typecheck. |
| `plugins/plugin-workflow/src/lib/index.ts` | Re-exports migration types/functions from legacy migration modules | Imported by `plugins/plugin-workflow/src/index.ts`. | Keep while migrations are active. Later make migrations private and import direct if they should not be public library API. | Medium. Changes migration boot path. | `bun run --cwd plugins/plugin-workflow test:unit`; `bun run --cwd plugins/plugin-workflow typecheck`. |
| `plugins/app-lifeops/src/contracts/index.ts`; `plugins/app-lifeops/src/contracts/lifeops.ts` | Re-export-only from `@elizaos/plugin-browser` and `@elizaos/shared` | LifeOps contract surface. | Do not delete without LifeOps/health contract owner signoff. This area is protected by AGENTS.md architecture rules. | High. Contract exports are cross-plugin boundaries. | `bun run --cwd plugins/app-lifeops verify`; `rg -n '@elizaos/app-lifeops.*contracts|src/contracts' plugins packages`. |
| `test/helpers/*.ts` re-exporting app-core test helpers | `export * from "../../packages/app-core/test/helpers/..."` | Shared test helper aliases. | Keep or consolidate under a single test-support package after test configs/imports are updated. | Low to medium. Deleting breaks tests that import root `test/helpers`. | `rg -n 'test/helpers/(conditional-tests|test-utils|live-provider|live-child-env|http|real-runtime)' test packages plugins`; `bun run test:ci`. |
| `packages/agent/src/config/types.*.ts` | Re-export-only from `@elizaos/shared` | Compatibility config type subpaths and generated declarations. | Keep until package subpath policy is settled. Then remove duplicated type mirrors behind root exports or approved subpaths. | Medium. Config type imports may be downstream public API. | `bun run audit:package-barrels:check`; `bun run --cwd packages/agent typecheck`; `bun run --cwd packages/shared typecheck`. |

## Excluded Buckets

These matches should not drive deletion or rename work in Phase 3:

- Vendored or third-party code under `packages/inference/llama.cpp/**`, including `public_legacy`, `convert_legacy_llama.py`, and upstream compatibility tests.
- Benchmark fixtures under `packages/benchmarks/**`, including `new_*` environment names and OSWorld tool files.
- Historical reports under `reports/**` and prior audit folders under `docs/audits/lifeops-*`.
- Built artifacts under `packages/app-core/platforms/electrobun/build/**` and mobile bundles under `packages/agent/dist-mobile*`.
- OpenZeppelin fixtures under `packages/app-core/test/contracts/lib/openzeppelin-contracts/**`.
- SQL migrations with `legacy` in their historical name, for example `0111_drop_legacy_privy_wallet_columns.sql` and `0114_backfill_app_databases_drop_legacy_app_columns.sql`. Migration filenames are immutable history.
- Ignored/generated declaration mirrors such as `packages/agent/src/services/version-compat.d.ts` if present locally. Do not edit generated `.d.ts` or `.d.ts.map` files by hand.

## Implementation Order

1. Delete `plugins/app-lifeops/src/lifeops/entities/resolver-shim.ts` only after the grep and LifeOps verify commands are clean.
2. Consolidate exact duplicate SQL compat implementation by making shared canonical and preserving UI's public export.
3. Decide public naming for `INBOX_UNIFIED`, `unifiedWalletProvider`, `NewActionButton`, and cloud `landing-page-new` before any rename.
4. Move route compatibility cleanup into the backend route ownership wave. Compatibility route filenames should not be renamed without route alias/deprecation policy.
5. Use the package-barrel audit to define allowed public subpaths before deleting barrels or re-export-only package entrypoints.

## Validation Command Set

Minimum no-delete validation before any implementation PR:

```bash
git status --short
rg -n 'createContactResolverShim\|ContactResolverShim\|ResolvedContactShim\|resolver-shim' plugins/app-lifeops packages plugins test docs
rg -n 'inboxUnified\|InboxUnified\|INBOX_UNIFIED\|inbox-unified' plugins/app-lifeops packages/prompts packages/core packages/docs
rg -n 'compat-route-shared\|handle.*CompatRoutes' packages/app-core/src/api plugins cloud
diff -q packages/shared/src/utils/sql-compat.ts packages/ui/src/utils/sql-compat.ts
bun run audit:package-barrels
bun run --cwd plugins/app-lifeops verify
bun run --cwd packages/shared typecheck
bun run --cwd packages/ui typecheck
bun run --cwd packages/app-core typecheck
bun run --cwd packages/agent typecheck
bun run --cwd cloud typecheck
```

Full cleanup gate after approved edits:

```bash
bun run lint:check
bun run typecheck
bun run test:ci
bun run audit:package-barrels:check
```
