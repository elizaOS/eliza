# Phase 4 - Ignores, Suppressions, And Quality Markers

Date: 2026-05-11

Scope: repository-wide inventory of quality suppressions and bad-practice
markers. This pass did not modify source code. It classifies suppressions and
markers into high-confidence cleanup work, justified exceptions, and areas that
need owner review before removal.

## Commands Used

```bash
rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!dist' --glob '!build' --glob '!coverage' --glob '!packages/inference/llama.cpp' --glob '!packages/agent/dist-mobile-ios/**' --glob '!packages/agent/dist-mobile-ios-jsc/**' --glob '!plugins/app-companion/public/vrm-decoders/**' --glob '!packages/app-core/test/contracts/**' 'biome-ignore|eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck' .
rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!dist' --glob '!build' --glob '!coverage' --glob '!packages/inference/llama.cpp' --glob '!packages/agent/dist-mobile-ios/**' --glob '!packages/agent/dist-mobile-ios-jsc/**' --glob '!plugins/app-companion/public/vrm-decoders/**' --glob '!packages/app-core/test/contracts/**' 'catch \([^)]*\) \{\s*\}|catch \{\s*\}|catch \([^)]*\) \{\s*//|catch \{\s*//|catch \([^)]*\) \{\s*return|catch \{\s*return' .
rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!dist' --glob '!build' --glob '!coverage' --glob '!packages/inference/llama.cpp' --glob '!packages/agent/dist-mobile-ios/**' --glob '!packages/agent/dist-mobile-ios-jsc/**' --glob '!plugins/app-companion/public/vrm-decoders/**' --glob '!packages/app-core/test/contracts/**' --glob '!docs/**' '\b(TODO|FIXME|HACK|XXX)\b' .
rg -n --hidden --glob '**/.gitignore' 'dist|build|coverage|reports|bench|data|models|cache|tmp|generated|artifacts|training|\.next|target|screenshots|test-results|playwright' .
```

## Headline Counts

These counts exclude `node_modules`, `.git`, normal build folders, coverage,
`packages/inference/llama.cpp`, generated mobile bundles, Draco decoder vendor
files, contract vendor files, and this audit folder.

| Marker | Count | Classification |
| --- | ---: | --- |
| `@ts-nocheck` | 120 | Too high. Mostly legacy wallet, LifeOps mixins, and local-ai. |
| `biome-ignore` | 91 | Mixed. Many justified, several UI/state suppressions need cleanup. |
| `eslint-disable` | 70 | Mixed. Generated files and dynamic `require` are expected; hook-deps/no-console need review. |
| `@ts-expect-error` | 42 | Mostly test runtime-guard probes, but a few production typing gaps remain. |
| `@ts-ignore` | 6 | Only one real source suppression; the rest are prose or guard-script text. |
| Empty or no-op `catch` candidates | 191 | Too high. Duplicate browser renderer registries account for 40. |
| Source TODO/FIXME/HACK/XXX candidates | 319 | Many are real deferred work, plus benchmark/training/vendor noise. |

## Highest Priority Cleanup TODOs

1. Remove the only real source `@ts-ignore`.
   - `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts:650`
   - Current context says the adapter dynamically imports `bun:ffi`.
   - Replace with an ambient declaration for `bun:ffi`, a typed adapter module,
     or a `const mod = await import("bun:ffi" as string)` style boundary that
     does not require `@ts-ignore`.
   - Keep the runtime AOSP/Bun-only behavior unchanged.

2. Burn down plugin-wallet `@ts-nocheck`.
   - 80 files under `plugins/plugin-wallet`.
   - All are line 1 suppressions, mostly marked as legacy absorbed plugin code.
   - Main clusters:
     - `plugins/plugin-wallet/src/analytics/lpinfo/**:1`
     - `plugins/plugin-wallet/src/analytics/news/**:1`
     - `plugins/plugin-wallet/src/analytics/dexscreener/**:1`
     - `plugins/plugin-wallet/src/analytics/birdeye/**:1`
     - `plugins/plugin-wallet/src/chains/evm/dex/**:1`
     - `plugins/plugin-wallet/src/chains/solana/dex/**:1`
     - `plugins/plugin-wallet/src/lp/**:1`
   - Cleanup path: first prove which absorbed plugin surfaces are still
     reachable from `plugins/plugin-wallet/src/index.ts` and action/provider
     registration, then delete dead surfaces or type the live ones. Do not
     simply replace `@ts-nocheck` with local `any`.

3. Replace LifeOps mixin-wide `@ts-nocheck` with typed composition.
   - 28 files under `plugins/app-lifeops/src/lifeops/service-mixin-*.ts:1`.
   - Examples:
     - `plugins/app-lifeops/src/lifeops/service-mixin-calendar.ts:1`
     - `plugins/app-lifeops/src/lifeops/service-mixin-discord.ts:1`
     - `plugins/app-lifeops/src/lifeops/service-mixin-drive.ts:1`
     - `plugins/app-lifeops/src/lifeops/service-mixin-gmail.ts:1`
     - `plugins/app-lifeops/src/lifeops/service-mixin-scheduled-task` is not present, which is good: do not introduce a second task primitive.
   - Required invariant: preserve the single `ScheduledTask` runner and the
     structural LifeOps behavior described in `AGENTS.md`.
   - Cleanup path: type the base `Constructor`/`MixinClass` helper once in
     `service-mixin-core.ts`, export narrow public method interfaces per mixin,
     and remove file-level suppression incrementally.

4. Decide whether `plugins/plugin-local-ai` is still a live package.
   - 8 `@ts-nocheck` files:
     - `plugins/plugin-local-ai/index.ts:1`
     - `plugins/plugin-local-ai/structured-output.ts:1`
     - `plugins/plugin-local-ai/environment.ts:1`
     - `plugins/plugin-local-ai/utils/platform.ts:1`
     - `plugins/plugin-local-ai/utils/tokenizerManager.ts:1`
     - `plugins/plugin-local-ai/utils/transcribeManager.ts:1`
     - `plugins/plugin-local-ai/utils/ttsManager.ts:1`
     - `plugins/plugin-local-ai/utils/visionManager.ts:1`
   - The header cites transformer 3 to 4 migration and core logger/API drift.
   - Cleanup path: either complete the migration and type it, or delete the
     package if `plugin-local-inference` is the canonical path.

5. Consolidate duplicate browser tab renderer registry code before touching
   catch blocks.
   - `packages/shared/src/utils/browser-tabs-renderer-registry.ts`
   - `packages/ui/src/utils/browser-tabs-renderer-registry.ts`
   - Both files have the same 20 no-op catch sites:
     - `:328`, `:378`, `:384`, `:399`, `:443`, `:629`, `:638`, `:642`, `:693`,
       `:706`, `:809`, `:818`, `:901`, `:906`, `:1028`, `:1033`, `:1039`,
       `:1056`, `:1062`, `:1082`
   - Cleanup path: make one package the canonical owner, delete the duplicate,
     then decide whether listener isolation should remain silent or use a local
     `callListenerSafely` helper with debug logging.

6. Replace empty catches in runtime/service code with fail-fast, logging, or
   named quiet-cleanup helpers.
   - `plugins/plugin-sql/src/pglite/manager.ts:72`, `:194`, `:201`, `:223`, `:344`
   - `plugins/plugin-discord/discord-avatar-cache.ts:122`, `:160`
   - `plugins/plugin-discord/profileSync.ts:192`
   - `plugins/plugin-openrouter/utils/helpers.ts:21`, `:27`, `:36`, `:44`
   - `packages/agent/src/api/wallet-capability.ts:78`, `:92`
   - `packages/agent/src/api/avatar-routes.ts:190`, `:217`
   - `packages/agent/src/api/nfa-routes.ts:124`
   - `packages/agent/src/runtime/owner-entity.ts:39`, `:41`
   - `packages/agent/src/providers/page-scoped-context.ts:194`
   - `packages/app-core/src/runtime/dev-server.ts:436`
   - `packages/app-core/src/runtime/eliza.ts:1143`
   - `packages/ui/src/state/startup-phase-poll.ts:285`
   - `cloud/packages/ui/src/runtime/navigation.ts:37`
   - `cloud/packages/ui/src/runtime/link.tsx:30`
   - Cleanup rule: keep silent catches only for best-effort close/kill/focus
     operations where the caller cannot act on failure, and encode that as a
     named helper. Everything else should log or propagate.

7. Remove stale TODO Wave comments in LifeOps once the current path is known.
   - `plugins/app-lifeops/src/actions/inbox-unified.ts:103`
   - `plugins/app-lifeops/src/actions/brief.ts:109`
   - `plugins/app-lifeops/src/actions/conflict-detect.ts:104`
   - `plugins/app-lifeops/src/actions/document.ts:517`
   - `plugins/app-lifeops/src/actions/owner-surfaces.ts:303`
   - `plugins/app-lifeops/src/lifeops/scheduled-task/types.ts:252`
   - Cleanup rule: do not leave wave-era comments in source. Either implement,
     convert to a tracked issue in generated docs, or remove if obsolete.

8. Clean real platform and app TODOs.
   - `packages/app-core/src/api/internal-routes.ts:17`, `:84`
   - `packages/app-core/src/connectors/capacitor-quickjs.ts:1`
   - `packages/app-core/src/connectors/capacitor-jsc.ts:1`
   - `packages/app-core/src/connectors/capacitor-sqlite.ts:1`
   - `packages/ui/src/state/useAppLifecycleEvents.ts:77`, `:83`
   - `packages/ui/src/components/shell/RuntimeGate.tsx:371`
   - `packages/shared/src/themes/presets.ts:161`
   - `packages/shared/src/utils/permission-deep-links.ts:94`
   - `packages/shared/src/contracts/apps.ts:141`, `:148`
   - `packages/agent/src/config/plugin-widgets.ts:9`
   - `packages/agent/src/runtime/conversation-compactor-runtime.ts:23`
   - `packages/agent/src/services/permissions/register-probers.ts:9`
   - `packages/agent/src/services/permissions/probers/screentime.ts:52`
   - `packages/agent/src/services/permissions/probers/health.ts:62`, `:80`
   - `packages/agent/src/services/permissions/probers/shell.ts:12`

9. Audit CI/workflow TODOs because several are no-op placeholders.
   - `.github/workflows/test-electrobun-release.yml:48`, `:52`, `:60`
   - `.github/workflows/scenario-matrix.yml:18`, `:219`
   - `.github/workflows/release-electrobun.yml:195`, `:241`, `:653`, `:747`,
     `:1079`, `:1654`
   - `.github/workflows/nightly.yml:134`
   - Cleanup path: either wire the real commands or delete the placeholder
     workflow steps. Green no-op CI is worse than no CI.

10. Tighten broad Biome rule disablement.
    - `biome.json:54-60` turns `useHookAtTopLevel` off for all `*.ts`, because
      runtime methods are named like hooks.
    - `cloud/biome.json:64-123` disables or downgrades a large rule surface,
      including explicit-any, array-index keys, a11y, dangerous HTML, and many
      correctness/style rules.
    - Package configs with broad `noExplicitAny: "off"`:
      - `plugins/plugin-local-inference/biome.json:11`
      - `plugins/plugin-bluebubbles/biome.json:11`
      - `plugins/plugin-capacitor-bridge/biome.json:11`
      - `plugins/plugin-app-control/biome.json:11`
      - `plugins/plugin-discord/biome.json:18`
      - `plugins/plugin-discord-local/biome.json:32`
      - `plugins/plugin-whatsapp/biome.json:35`
      - `plugins/plugin-cli/biome.json:11`
      - `plugins/plugin-commands/biome.json:11`
      - `packages/elizaos/templates/plugin/biome.json:20`
      - `packages/examples/_plugin/biome.json:20`
    - Cleanup path: move from package-wide off switches to targeted inline
      suppressions or typed wrappers.

## Suppressions That Look Justified

These should not be removed blindly.

| Path/line | Reason |
| --- | --- |
| `cloud/apps/api/src/_router.generated.ts:8`, `:9` | Generated router output; suppression belongs in generator. |
| `cloud/apps/api/src/_generate-router.mjs:186`, `:187` | Generator emits the corresponding suppressions. |
| `packages/examples/convex/convex/_generated/api.d.ts:1` | Convex generated declaration output. |
| `packages/examples/convex/convex/_generated/dataModel.d.ts:1` | Convex generated declaration output. |
| `packages/examples/convex/convex/_generated/server.d.ts:1` | Convex generated declaration output. |
| `packages/vault/test/*.test.ts` `@ts-expect-error` lines | Negative tests intentionally exercise runtime validation. |
| `packages/ui/src/onboarding/__tests__/flow.test.ts:113`, `:133`, `:161`, `:227`, `:240`, `:422`, `:588`, `:590`, `:593`, `:597`, `:603` | Runtime guard and fuzz probes. |
| `plugins/plugin-workflow/__tests__/unit/clarification.test.ts:70` | Malformed runtime input probe. |
| `plugins/plugin-workflow/__tests__/unit/workflow-clarification.test.ts:204` | Runtime guard probe. |
| `packages/app-core/platforms/electrobun/src/index.ts:765` | Bun fetch `duplex` typing gap. Recheck when Bun typings update. |
| `packages/app-core/platforms/electrobun/src/index.ts:904`, `:939` | Electrobun icon typing gap. Recheck when Electrobun exposes the type. |
| `packages/app-core/platforms/electrobun/src/native/canvas.ts:86`, `:429` | Electrobun partition option typing gap. |
| `packages/core/src/features/documents/url-ingest.ts:123` | DOM vs Node stream typing gap. |
| `packages/core/src/types/service.ts:83` | Module augmentation empty interface. |
| `packages/core/src/features/trust/services/db.ts:7` | Drizzle fluent API boundary. |
| `packages/shared/src/utils/assistant-text.ts:129` | Intentional ASCII/control-character regex. |
| `packages/ui/src/utils/assistant-text.ts:129` | Same regex logic as shared copy; still consider consolidating copies. |
| `plugins/plugin-agent-orchestrator/src/services/ansi-utils.ts:11-22` | ANSI control-character regex implementation. |
| `plugins/plugin-discord/banner.ts:76`, `:109` | Terminal ANSI formatting. |
| `packages/ui/src/styles/xterm.css:175` | xterm.js style override. |

## Suppressions That Need Owner Review

| Path/line | Concern | TODO |
| --- | --- | --- |
| `packages/ui/src/state/AppContext.tsx:1714`, `:1717`, `:1859` | Hook dependency suppressions in central app state. | Split effects or derive stable inputs so refresh hierarchy is explicit. |
| `packages/ui/src/state/useChatSend.ts:976` | Omits `conversations` to limit rerenders. | Replace with a ref/selector contract or move send state into a reducer. |
| `packages/ui/src/state/useChatCallbacks.ts:471` | Reads a ref to avoid dependency. | Verify one-time greeting semantics with test and remove suppression if possible. |
| `packages/ui/src/components/character/CharacterEditor.tsx:769` | Raw React hook dependency disable. | Extract stable callback or reducer. |
| `packages/ui/src/components/pages/ElizaCloudDashboard.tsx:436` | Comment says "see comment above"; not self-contained. | Rewrite effect or make the suppression explanation local. |
| `packages/ui/src/components/pages/AppsView.tsx:836` | One-time load effect. | Gate with explicit lifecycle state instead of dependency suppression. |
| `packages/ui/src/components/pages/RuntimeView.tsx:489`, `:506`, `:523` | A11y label suppressions. | Prefer real `htmlFor`/`id` association or a component abstraction. |
| `packages/ui/src/components/config-ui/config-field.tsx:890`, `:1667` | A11y label suppressions. | Same fix as RuntimeView. |
| `packages/ui/src/components/custom-actions/CustomActionsView.tsx:356` | A11y label suppression. | Same fix. |
| `packages/ui/src/components/custom-actions/CustomActionsPanel.tsx:309` | A11y label suppression. | Same fix. |
| `packages/ui/src/components/character/CharacterEditorPanels.tsx:436`, `:442`, `:602` | Array index keys due missing stable keys. | Introduce stable ids when editing lists. |
| `packages/ui/src/components/character/CharacterEditor.tsx:1132` | `useSemanticElements` "existing pattern" explanation is too weak. | Replace with semantic element or document the behavior constraint. |
| `packages/ui/src/components/config-ui/config-field.tsx:550` | Autofocus is intentional but should be owned by interaction state. | Verify focus trap and screen-reader behavior. |
| `packages/ui/src/components/pages/RelationshipsGraphPanel.tsx:1036`, `:1104` | Static element interaction suppressions. | Prefer keyboard-accessible graph affordances or isolate pure tooltip layer. |
| `packages/ui/src/components/pages/WorkflowGraphViewer.tsx:790` | React Flow owns interactions. | Verify keyboard focus semantics. |
| `packages/app-core/src/services/sensitive-requests/public-link-adapter.test.ts:13` | Unused var suppression in test. | Remove unused variable or assert it. |
| `cloud/packages/ui/src/components/layout/page-header-context.tsx:100` | Hook dependency suppression. | Check if context update can be reducer-driven. |
| `cloud/packages/ui/src/components/navigation-progress.tsx:21` | Hook dependency suppression looks intentional. | Keep only with focused test. |

## No-Op Catch Classification

### Likely justified, keep or wrap in quiet helper

These are mostly cleanup, focus, close, or kill operations where failure is not
actionable. They should still use a named helper so silent behavior is explicit.

- `packages/inference/verify/embedding_bench.mjs:292`, `:294`
- `plugins/app-vincent/src/routes.ts:618`
- `packages/examples/agent-console/server.ts:452`, `:796`
- `packages/examples/agent-console/public/index.html:440`
- `packages/app-core/platforms/electrobun/src/cloud-auth-window.ts:82`
- `packages/app-core/platforms/electrobun/src/native/screencapture.ts:159`, `:195`, `:266`, `:584`, `:638`
- `packages/app-core/platforms/electrobun/src/native/talkmode.ts:389`
- `packages/app-core/platforms/electrobun/src/native/swabble.ts:297`
- `packages/app-core/platforms/electrobun/src/native/gateway.ts:47`
- `packages/app-core/platforms/electrobun/src/native/whisper.ts:223`
- `packages/app-core/platforms/electrobun/src/native/location.ts:60`

### Actionable no-op catches

These should not silently swallow by default.

- `plugins/plugin-sql/src/index.browser.ts:58`
- `plugins/plugin-sql/src/pglite/manager.ts:72`, `:194`, `:201`, `:223`, `:344`
- `plugins/plugin-discord/discord-avatar-cache.ts:122`, `:160`
- `plugins/plugin-discord/profileSync.ts:192`
- `plugins/plugin-openrouter/utils/helpers.ts:21`, `:27`, `:36`, `:44`
- `plugins/plugin-browser/src/workspace/browser-capture.ts:212`, `:218`
- `plugins/plugin-capacitor-bridge/src/mobile-device-bridge-bootstrap.ts:783`, `:795`, `:813`
- `plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts:386`, `:396`, `:414`
- `plugins/plugin-x/src/client/accounts.ts:194`
- `plugins/plugin-x/src/client/errors.ts:35`
- `packages/agent/src/api/wallet-capability.ts:78`, `:92`
- `packages/agent/src/api/avatar-routes.ts:190`, `:217`
- `packages/agent/src/api/nfa-routes.ts:124`
- `packages/agent/src/runtime/owner-entity.ts:39`, `:41`
- `packages/agent/src/providers/page-scoped-context.ts:194`
- `packages/app-core/src/runtime/dev-server.ts:436`
- `packages/app-core/src/runtime/eliza.ts:1143`
- `packages/ui/src/state/startup-phase-poll.ts:285`
- `cloud/apps/api/src/steward/embedded.ts:47`
- `cloud/packages/lib/services/agent-github-return.ts:179`, `:185`, `:193`
- `cloud/packages/lib/hooks/use-job-poller.ts:157`
- `cloud/packages/ui/src/runtime/navigation.ts:37`
- `cloud/packages/ui/src/runtime/link.tsx:30`

### Generated/vendor no-op catches

Do not spend cleanup time on these until the generated or vendor directories are
removed from tracking.

- `packages/agent/dist-mobile-ios/**`
- `packages/agent/dist-mobile-ios-jsc/**`
- `plugins/app-companion/public/vrm-decoders/draco/**`
- `packages/app-core/test/contracts/lib/openzeppelin-contracts/**`

## Ignored And Generated Folder Findings

### Root ignore policy

Important root patterns:

- `.gitignore:37`, `:85`, `:89`, `:131` - repeated `dist` ignores.
- `.gitignore:67-68` - root `cache/*`, `models/*`.
- `.gitignore:154-163` - screenshots, test results, Playwright report/cache.
- `.gitignore:222-229` - broad `**/data/` with exceptions for cloud frontend
  data and plugin-mysticism engine data.
- `.gitignore:267-268` - generated i18n folders.
- `.gitignore:282-283` - generated training datasets.
- `.gitignore:336-352` - benchmark result and trajectory output.
- `.gitignore:443-456` - Android Gradle, Storybook static, Foundry, and
  Electrobun build outputs.
- `.gitignore:462-467` - generated mobile bundle output, but only
  `packages/agent/dist-mobile/` is ignored. The tracked `dist-mobile-ios` and
  `dist-mobile-ios-jsc` bundles should be evaluated for deletion/ignore.
- `.gitignore:488-493` - action benchmark report, artifacts, LifeOps bench
  results, AI QA reports.

### Biome ignore policy

- `.biomeignore:1-22` ignores dist, build, declarations, venvs, coverage,
  target, data, `.eliza`, `.cursor`, `.next`.
- `biome.json:13-24` has additional generated/vendor excludes.
- Risk: `.biomeignore:5` ignores all `*.d.ts`, including hand-written
  declarations. If hand-written declaration files are expected, narrow this to
  generated declarations only.
- Risk: `biome.json:54-60` disables hook detection for all `*.ts`; this is a
  repo-wide workaround for runtime method names that look like hooks.

### Package-level ignore drift

There are many package-level `.gitignore`, `.npmignore`, and `biome.json`
files. Most repeat standard `dist`, `node_modules`, `coverage`, `target`, and
Python cache patterns. Cleanup should standardize plugin templates and remove
copy-pasted ignores where package managers already respect the root policy.

Specific review targets:

- `packages/training/.gitignore:4`, `:11-17` keeps only selected benchmark
  files while ignoring generated data and benchmark outputs. Good policy, but
  audit tracked training outputs separately.
- `packages/benchmarks/.gitignore:46-68`, `:75-107` is intentionally broad for
  run outputs, caches, datasets, and SWE-bench workspaces. Good policy, but
  tracked benchmark snapshots still need a separate delete review.
- `packages/registry/site/.gitignore:28` ignores `public/generated-registry.json`.
  Confirm whether generated registry files should be tracked at package root or
  produced during build.
- `packages/examples/convex/.gitignore:3-6` tracks only generated Convex `.d.ts`
  files. That is reasonable if examples need typechecking out of the box.
- `packages/browser-bridge/safari/.gitignore:1` ignores `generated/`; root
  `.gitignore` also ignores the Safari Xcode project pbxproj churn.

## Broad Bad-Practice Markers

### Real TODO/FIXME/HACK work, not prose

- `cloud/services/gateway-discord/src/voice-message-handler.ts:10`, `:173`,
  `:267` - R2-backed upload/cleanup is not wired.
- `cloud/apps/api/training/vertex/tune/route.ts:1` - node-only route blocked
  from Workers.
- `cloud/apps/api/v1/admin/docker-containers/[id]/logs/route.ts:4` - node-only
  route blocked from Workers.
- `cloud/apps/api/my-agents/characters/[id]/route.ts:95` - cache revalidation
  dropped.
- `cloud/apps/api/my-agents/characters/[id]/share/route.ts:88` - cache
  revalidation TODO.
- `cloud/apps/api/my-agents/saved/[id]/route.ts:68` - cache revalidation TODO.
- `cloud/apps/api/invites/accept/route.ts:6` - cache invalidation TODO.
- `cloud/apps/api/organizations/members/[userId]/route.ts:6` - cache
  invalidation TODO.
- `cloud/apps/frontend/src/dashboard/apps/_components/app-domains.tsx:674` -
  placeholder DNS targets.
- `cloud/packages/lib/hooks/use-admin.ts:143` - wallet-connect work deferred.
- `cloud/packages/lib/services/containers/image-rollout-status.ts:209` -
  rollback requires persisted state and approval.
- `plugins/plugin-wallet/src/analytics/birdeye/service.ts:340`, `:512` -
  missing chain parameter and caching.
- `plugins/plugin-wallet/src/analytics/birdeye/providers/market.ts:66`, `:129`,
  `:144` - runtime settings, cache policy, and market-cap mapping gaps.
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/services/MeteoraLpService.ts:230`, `:363`
  - LP interface mismatch and missing price oracle.
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/utils/loadWallet.ts:25`
  - TEE mode disabled.
- `plugins/plugin-wallet/src/chains/solana/dex/meteora/providers/positionProvider.ts:152`
  - dynamic source required.
- `plugins/plugin-telegram/src/messageManager.ts:880` - split 4096 char
  Telegram payloads.
- `plugins/plugin-social-alpha/src/types.ts:506` - consolidate into `Entity`
  metadata.
- `plugins/plugin-discord/discord-local-service.ts:68` - multi-account
  accountId handoff.
- `packages/app-core/scripts/build-llama-cpp-dflash.mjs:616`, `:866`, `:872`,
  `:875`, `:878` - patch/kernel TODO anchors. Verify which are obsolete after
  current fork work.
- `packages/native-plugins/qjl-cpu/test/qjl_bench.c:344` - NEON throughput TBD.

### Marker noise to exclude from cleanup counts

- Generated action names named `TODO`:
  - `packages/prompts/specs/actions/plugins.generated.json`
  - `packages/core/src/generated/action-docs.ts`
  - `packages/registry/generated-registry.json`
  - `plugins/plugin-todos/**`
- Benchmark/vendor datasets:
  - `packages/benchmarks/OSWorld/**`
  - `packages/benchmarks/loca-bench/**`
  - `packages/benchmarks/HyperliquidBench/**`
- Skill templates that intentionally contain TODO placeholders:
  - `packages/skills/skills/skill-creator/**`
  - `packages/elizaos/templates/min-project/SCAFFOLD.md`
  - `packages/elizaos/templates/min-plugin/SCAFFOLD.md`

## Suggested Implementation Order

1. Delete or ignore tracked generated bundles/vendor outputs first:
   `packages/agent/dist-mobile-ios/**`, `packages/agent/dist-mobile-ios-jsc/**`,
   and any tracked generated reports found in the generated-artifact audit.
2. Replace the single source `@ts-ignore` in
   `plugins/plugin-aosp-local-inference/src/aosp-llama-adapter.ts:650`.
3. Consolidate `browser-tabs-renderer-registry` to one canonical package, then
   address its 40 duplicate no-op catches once.
4. Add a small local helper for allowed quiet cleanup catches, then convert
   actionable no-op catches to log or propagate.
5. Burn down LifeOps mixin `@ts-nocheck` in small batches, running
   `bun run lint:default-packs` and focused LifeOps tests after each batch.
6. Decide the fate of `plugins/plugin-local-ai` before typing it. If superseded,
   delete it rather than polishing legacy.
7. Triage `plugins/plugin-wallet` into reachable and unreachable surfaces, then
   delete unreachable absorbed-plugin code before typing the rest.
8. Tighten broad Biome config only after package-specific suppressions are
   fixed, so validation failures point to real remaining work.

## Validation Plan

For each implementation batch:

```bash
bun run lint
bun run typecheck
bun run build
bun run test
```

Additional focused validation:

```bash
bun run lint:default-packs
PATH=/Users/shawwalters/.bun/bin:$PATH bunx madge --circular --extensions ts,tsx --exclude '(dist|build|node_modules|.turbo|coverage|.claude|packages/inference/llama.cpp|packages/app-core/platforms/electrobun/build)' packages plugins test
rg -n '@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|catch \{\}|catch \\([^)]*\\) \{\}' packages plugins cloud scripts
```

Known validation caveats from this cleanup thread:

- `bun run lint`, `bun run typecheck`, and `bun run build` were previously
  passing after the DFlash mock metrics fix.
- `bun run knip` was blocked by a macOS native binding code-signature failure in
  `@oxc-resolver/binding-darwin-arm64`.
- Root `bun run test` hung in app-core after other suites passed; use focused
  package tests while the root hang is investigated.
