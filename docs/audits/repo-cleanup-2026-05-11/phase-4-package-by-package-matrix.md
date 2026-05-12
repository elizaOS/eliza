# Phase 4 - Package-By-Package Cleanup Matrix

Read-only scan date: 2026-05-11.

Scope: repo-owned package manifests under `packages/`, `plugins/`, and
`cloud/packages`. Generated and vendored package manifests under `.vite`,
`.next`, `packages/inference/llama.cpp`, and
`packages/app-core/test/contracts/lib` were excluded from package ownership
classification.

No source files were modified for this report.

## Source Reports

This matrix intentionally indexes the existing specialist reports instead of
duplicating every finding:

- `phase-4-package-family-core.md`
- `phase-4-package-family-lifeops-apps.md`
- `phase-4-package-family-plugins.md`
- `phase-4-package-family-examples-benchmarks-inference-cloud.md`
- `phase-4-json-data-generated-artifacts.md`
- `phase-4-ignores-suppressions-quality.md`
- `VALIDATION_STATUS.md`

## Current Validation Baseline

Use `VALIDATION_STATUS.md` as the current truth:

- Passing: `bun run lint`, `bun run typecheck`, `bun run build`, focused DFlash
  cache/stress tests, `madge --circular`, and `git diff --check`.
- Blocked: `bun run knip` fails before analysis because the local
  `@oxc-resolver/binding-darwin-arm64` native binding is rejected by macOS.
- Blocked: root `bun run test` hangs in the app-core Vitest segment after other
  suites progress.

## Priority Matrix

| Package | Missing local gates | Artifact, doc, data cleanup | Shim, re-export, compat, legacy cleanup | Boundary or package ownership concern | Next validation | Source |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/agent` / `@elizaos/agent` | none | Remove tracked `dist-mobile-ios*` bundles only after mobile build pipeline regenerates them. | Classify `compat-utils.ts`, `music-player-route-fallback.ts`, `pglite-error-compat.ts`, `version-compat.ts`. | Several app/plugin imports are optional runtime registry data but look like hard deps; expose `tool-call-cache` through a public package boundary. | `cd packages/agent && bun run build:mobile && bun run typecheck && bun run test`; then root build. | Core C1, C4, C5, C8; JSON EBI-03 |
| `packages/app` / `@elizaos/app` | none | Keep native build outputs ignored; review generated iOS public assets and Playwright `test-results` artifacts. | Native stub bundles in `ios/App/App/public/assets` are generated output, not hand source. | App imports many app/plugin packages by design; ensure plugin bundle generation owns those artifacts. | `cd packages/app && bun run typecheck && bun run build && bun run test:e2e` when UI lane is enabled. | Core findings; JSON artifact report |
| `packages/app-core` / `@elizaos/app-core` | none | Review `.tmp`, `action-benchmark-report`, generated manifests, Electrobun artifacts, and vendored OpenZeppelin tree. | Classify `*-compat-routes.ts`, `ui-compat.ts`, `browser.ts`, AOSP/FFI/native shims, Playwright API stubs. | Package owns API server, local inference, mobile tooling, packaging, benchmark tooling, and platform glue; split responsibilities when cleanup becomes architectural. | `cd packages/app-core && bun run typecheck && bun run build`; focused app-core tests; root test hang must be resolved. | Core C5-C8; JSON artifact report; quality report |
| `packages/app-core/platforms/electrobun` / `@elizaos/electrobun` | none | `.generated` and `artifacts` should remain generated and ignored. | `src/bridge/electrobun-stub.ts` is platform bridge code; rename only if it is canonical behavior. | Keep Electrobun platform code out of app-core source imports except via explicit package entrypoints. | `cd packages/app-core/platforms/electrobun && bun run build && bun run typecheck`. | Core; examples/inference/cloud report |
| `packages/app-core/deploy/cloud-agent-template` / `eliza-cloud-agent` | `build`, `lint`, `typecheck`, `test` | none found | none found | Template package needs explicit validation policy or no-op scripts with reason. | Template smoke install/build after adding scripts. | Package scan |
| `packages/core` / `@elizaos/core` | none | Decide ownership for generated specs and i18n generated files. | `schema-compat.ts` and `crypto-compat.ts` require consumer classification before rename/delete. | Keep generated contract/schema data reproducible; avoid downstream packages reaching into `core/src`. | `cd packages/core && bun run typecheck && bun run build && bun run test`. | Core C5, C7 |
| `packages/shared` / `@elizaos/shared` | none | `src/i18n/generated` needs source-vs-generated ownership call. | `src/utils/sql-compat.ts` should become the single canonical SQL compat helper. | Canonical owner for UI/shared config duplicates and shared contracts. | `cd packages/shared && bun run typecheck && bun run build`. | Core C2, C3, C7 |
| `packages/ui` / `@elizaos/ui` | none | Review training component data under `src/components/training`; most JSON is source/config. | Remove byte-identical config copies or make them narrow re-exports; delete/repoint `sql-compat.ts`; classify `agent-client-type-shim.ts` and `useOnboardingCompat.ts`. | `src/types/index.ts` reaches into `../../../shared/src/types/index`; replace with package export. | `cd packages/ui && bun run typecheck && bun run build && bun run test`. | Core C2-C5 |
| `packages/elizaos` / `elizaos` | none | Decide whether `templates-manifest.json` is generated or source; document generation if tracked. | Template stubs are probably intentional scaffold code; rename only if they are canonical optional app hooks. | Templates must not hide missing runtime dependency boundaries. | `cd packages/elizaos && bun run typecheck && bun run build && bun run test`; template smoke generation. | Core C7 |
| `packages/docs` / `@elizaos/docs` | `build`, `lint`, `typecheck` | Keep docs-site markdown; delete generated launch QA artifacts and report outputs if reproducible. | `rest/v1-compat.md` is docs content, not source slop, unless v1 compat is sunset. | Docs package needs explicit build/lint scripts if it remains a workspace package. | Docs site build plus link/content lint after artifact cleanup. | JSON artifact report; markdown/doc audit |
| `packages/inference` / `@elizaos/inference` | `build`, `lint`, `typecheck`, `test` | Delete untracked run reports; split tracked reports, bench results, hardware results, and Android Vulkan smoke outputs into fixtures vs run evidence. | `vulkan-fallback-*` and codec fallback reports are evidence/output unless promoted to curated docs. | Inference package currently mixes source, native upstream, result evidence, and verification outputs. | Local inference smoke gates, `eliza1:gates`, and artifact regeneration checks. | Examples/inference/cloud EBI-01, EBI-02; JSON report |
| `packages/benchmarks/configbench` / `@elizaos/configbench` | none | 12 markdown files and reporting helpers should be classified as benchmark docs vs generated reports. | none found | Keep benchmark output separate from package source. | `cd packages/benchmarks/configbench && bun run build && bun run test`. | Examples/benchmarks report |
| `packages/benchmarks/interrupt-bench` / `@elizaos/interrupt-bench` | `build`, `lint` | JSON snapshots need fixture/output classification. | none found | Private benchmark workspace should expose explicit no-op or real build/lint gates. | Package-local test plus root benchmark runner. | Examples/benchmarks report |
| `packages/benchmarks/lib` / `@elizaos-benchmarks/lib` | `lint`, `test` | Remove `__pycache__` from git if tracked; keep ignored otherwise. | none found | Benchmark helper library is imported from LifeOps tests by source path; consider a public test-support export. | `cd packages/benchmarks/lib && bun run typecheck`; consumers after export cleanup. | LifeOps apps report; examples/benchmarks report |
| `packages/benchmarks/evm/skill_runner` / `evm-skill-runner` | `test` | none found | none found | Private runner needs explicit test policy. | Build/typecheck plus runner smoke. | Package scan |
| `packages/benchmarks/framework/typescript` / `@elizaos/benchmark-framework` | `test` | none found | none found | Publish metadata is light; add test policy before publishing. | `cd packages/benchmarks/framework/typescript && bun run build && bun run typecheck`. | Package scan |
| `packages/benchmarks/solana/.../skill_runner` / `solana-swap-environment` | none | Test fixtures should stay small and deterministic. | none found | Confirm this is intentionally publishable; otherwise mark private. | Package build/test. | Package scan |
| `packages/training/local-corpora/scambench-github` / `@elizaos/scambench` | `build` | Generated scenario catalog and corpus data need externalization or fixture policy. | `scenario-catalog-unified-merged.json` naming should become canonical if it is source. | Training corpus should not be a publishable workspace unless intentionally maintained. | Dataset validation and training-format tests. | Examples/benchmarks report |
| `plugins/app-training` / `@elizaos/app-training` | `lint`, `typecheck` | `datasets`, `assets`, and generated training JSON need fixture/output split. | `test/plugin-discord.stub.ts` can be deleted only after imports hit zero. | Training app owns data-heavy material; keep generated corpora out of package source. | `cd plugins/app-training && bun run test`; dataset validation. | LifeOps apps report; JSON report |
| `packages/browser-bridge` / `@elizaos/browser-bridge-extension` | `lint`, `typecheck` | none found | `entrypoints/wallet-shim.ts` is likely real browser bridge code. | Add read-only lint/typecheck gates or explain extension-specific validation. | Browser bridge package tests and extension smoke. | Package scan |
| `packages/bun-ios-runtime` / `@elizaos/bun-ios-runtime` | `build`, `lint`, `typecheck`, `test` | none found | C shim appears native runtime code, not removable slop. | Native runtime package has no package-local validation despite publish metadata. | iOS runtime build/test smoke. | Package scan |
| `packages/native-plugins/*` | many lack `lint`, `typecheck`, and/or `test` | none found beyond generated native outputs owned by platform builds. | Native shims appear real platform bridges. | Standardize minimal gates across all Capacitor/native packages. | Package-local native build/typecheck where available; mobile integration build. | Package scan |
| `packages/os` / `@elizaos/distro-android-os` | `build`, `lint`, `typecheck`, `test` | Android OS distribution files should be explicitly release artifacts or source inputs. | none found | Private distribution workspace needs explicit validation/packaging policy. | Android distro packaging smoke. | Package scan |
| `packages/prompts` / `@elizaos/prompts` | `test` | none found | none found | Add package test policy for prompt contract changes. | `cd packages/prompts && bun run build && bun run typecheck`. | Package scan |
| `packages/scenario-runner` / `@elizaos/scenario-runner` | `lint` | none found | Source imports LifeOps benchmark helpers by source path; confirm test-only or move to benchmark package. | Scenario runner should not depend on app-lifeops test internals. | `cd packages/scenario-runner && bun run typecheck && bun run build && bun run test`. | Core package report; import scan |
| `packages/scenario-schema` / `@elizaos/scenario-schema` | `build`, `lint`, `typecheck`, `test` | none found | none found | Single-source schema package needs explicit packaging metadata/gates if publishable. | Add build/typecheck gate or mark as generated/schema-only with reason. | Package scan |
| `packages/registry` / `elizaos-plugins` | `build`, `lint`, `typecheck`, `test` | Registry JSON should be source or generated, not ambiguous. | none found | Publishability is unclear; add validation or mark private/non-workspace. | Registry generation/check script. | Package scan |
| `packages/registry/site` / `vite-react-tailwind-starter` | `typecheck`, `test` | Site generated output should stay ignored. | none found | Starter name suggests scaffold residue; confirm package purpose. | Site build/lint and root build. | Package scan |
| `packages/skills` / `@elizaos/skills` | `typecheck` | 57 markdown skill/docs files are likely package source; avoid blanket markdown wipe. | none found | Markdown is product data here, not docs slop. | `cd packages/skills && bun run build && bun run test`; add typecheck if applicable. | Core package report |
| `packages/vault` / `@elizaos/vault` | `lint` | none found | `test/vitest-assertion-shim.ts` is test-only; delete only after assertion imports migrate. Legacy vault migration code is live migration behavior. | Backward compatibility is current migration behavior, not no-change deletion. | `cd packages/vault && bun run typecheck && bun run build && bun run test`. | Core C5; quality report |
| `cloud/packages/db` / `@elizaos/cloud-db` | `build`, `test` | none found | `drop_legacy_*` migrations are immutable migration history, not deletion candidates. | Private cloud package should still expose validation gates if workspace-managed. | `bun run --cwd cloud typecheck && bun run --cwd cloud test`. | Package scan |
| `cloud/packages/lib` / `@elizaos/cloud-lib` | `build`, `test` | Review package-local cache folders and ensure ignored. | `compat-envelope.ts`, `adapter-compat.ts`, `app-domains-compat.ts`, and S3-compatible client are live API/provider compatibility unless sunset. | Very broad cloud runtime package; route/storage/app-domain ownership should be clear. | `bun run --cwd cloud verify`; targeted cloud lib tests. | Package scan; quality report |
| `cloud/packages/types` / `@elizaos/cloud-types` | `build`, `test` | none found | `workspace-shims.d.ts` should be documented as generated/ambient type bridge or removed. | Private type package should expose a typecheck gate. | `bun run --cwd cloud typecheck`. | Package scan |
| `cloud/packages/ui` / `@elizaos/cloud-ui` | none | none found | `vitest.shims.d.ts` is test infra; keep if required. | Publish metadata exists and scripts are complete. | Cloud UI build/test. | Package scan |
| `plugins/app-lifeops` / `@elizaos/app-lifeops` | `lint`, `typecheck` | Keep audit docs; fixture JSON must remain fixture-only. | High-confidence fresh grep target: `src/lifeops/entities/resolver-shim.ts`; do not delete `inbox-unified` without action metadata approval. Collapse `contract-stubs.ts` only after canonical contracts exist. | Must preserve `ScheduledTask` as the only task primitive and keep health internals out of LifeOps. | `cd plugins/app-lifeops && bun run test && bun run lint:default-packs`; root typecheck. | LifeOps LHA-01, LHA-02 |
| `plugins/plugin-health` / `@elizaos/plugin-health` | `typecheck` | Move/delete `src/health-bridge/health-platform-fallback.md` if obsolete. | `contract-stubs.ts` files need canonical contract owner; do not make Health import LifeOps internals. | Health contributes through registries only. | `cd plugins/plugin-health && bun run test`; root typecheck. | LifeOps LHA-02 |
| `plugins/app-steward` / `@elizaos/app-steward` | `lint`, `typecheck`, `test` | none found | `*-compat-routes.ts` are active route aliases; delete only with route sunset tests. | Route ownership should be explicit across app-core/cloud/steward. | Package tests plus backend route E2E. | LifeOps apps report |
| `plugins/app-companion` / `@elizaos/app-companion` | none | VRM decoder public assets should stay ignored/source-classified. | `three-vrm-shim.d.ts` is likely needed until upstream types cover it. | Keep type shim local to app-companion. | `cd plugins/app-companion && bun run typecheck && bun run build && bun run test`. | LifeOps apps report |
| `plugins/app-*` app packages | many missing `lint`, `typecheck`, `test` | mostly none found | mostly none found | Standardize publishable app package scripts or explicit no-op gates with reason. | `bun run test:client` plus package-local gates once added. | LifeOps apps report |
| `plugins/plugin-wallet` / `@elizaos/plugin-wallet` | `typecheck` | EVM contract artifacts and generated chain specs need generated/fixture policy. | Keep browser shim; `unified-wallet-provider.ts` needs product/API rename approval before canonical rename. | Largest plugin suppression hotspot; consolidate LP/DEX transaction types and typed SDK wrappers. | `cd plugins/plugin-wallet && bun run test`; add package typecheck; root typecheck/build. | Plugins report; quality report; JSON report |
| `plugins/plugin-agent-orchestrator` / `@elizaos/plugin-agent-orchestrator` | none | none found | `src/actions/sandbox-stub.ts` should be deleted or renamed if it is now a real action. | Action registry/spec should prove whether the stub is live. | Package test plus action registry/spec check. | Plugins report |
| `plugins/plugin-discord` / `@elizaos/plugin-discord` | none | generated specs should be reproducible or source-classified. | `compat.ts` is active core-version compatibility; keep until version floor changes. | Keep compatibility bridge explicit and dated. | `cd plugins/plugin-discord && bun run test`; root plugin tests. | Plugins report |
| `plugins/plugin-elizacloud` / `@elizaos/plugin-elizacloud` | none | generated specs should be reproducible or source-classified. | `src/routes/cloud-compat-routes.ts` is active API compatibility. | Route ownership cleanup belongs with backend route wave. | Package tests plus backend route E2E. | Plugins report |
| `plugins/plugin-mcp` / `@elizaos/plugin-mcp` | none | generated specs should be reproducible or source-classified. | `tool-compatibility` is active provider translation unless product removes it. | Provider protocol compatibility should be named canonical if not temporary. | Package tests and MCP provider translation tests. | Plugins report |
| `plugins/plugin-music` / `@elizaos/plugin-music` | none | none found | Audit `route-fallback.ts`, `streamFallback.ts`, `ytdlpFallback.ts` for masking missing route/dependency ownership. | Fallbacks should be explicit product behavior or hard errors. | Music package tests and route tests before deletion. | Plugins report |
| `plugins/plugin-workflow` / `@elizaos/plugin-workflow` | none | Fixture data should stay small. | `legacy-task-migration.ts` and `legacy-text-trigger-migration.ts` are data migrations; keep while installed users may carry legacy rows. | Credential provider tests reach into many plugin `src` trees; consider public credential-provider exports. | `cd plugins/plugin-workflow && bun run test`; root typecheck. | Plugins report; import scan |
| `plugins/plugin-sql` / `@elizaos/plugin-sql` | none | generated specs should be reproducible or source-classified. | none found | Duplicate package manifest at `plugins/plugin-sql/src/package.json` has same package name; verify build/package structure is intentional. | `cd plugins/plugin-sql && bun run build && bun run typecheck && bun run test`; pack dry-run. | Package scan |
| `plugins/plugin-shell` / `@elizaos/plugin-shell` | none | generated specs should be reproducible or source-classified. | `bun-shims.d.ts` should live in a type-stubs folder if kept. | Keep Bun-specific ambient types isolated. | Package build/typecheck/test. | Plugins report |
| `plugins/plugin-zai` / `@elizaos/plugin-zai` | none | none found | `openai-compatible.ts` is provider protocol compatibility; keep if product feature. | Consider shared OpenAI-compatible provider helpers only if two packages can import without cycles. | Package test and provider API tests. | Plugins report |

## Validation-Only Backlog

These packages mostly surfaced as missing package-local gates. Add real scripts
where possible; otherwise add explicit no-op scripts that explain why root or
external validation owns the package.

| Package | Missing scripts | Recommended next gate |
| --- | --- | --- |
| `packages/examples/agent-console` | `build`, `lint`, `test` | Example smoke or mark non-buildable. |
| `packages/examples/app/capacitor` | `test` | Capacitor example smoke. |
| `packages/examples/app/capacitor/frontend` | `test` | Frontend smoke. |
| `packages/examples/app/electron` | `test` | Electron example smoke. |
| `packages/examples/app/electron/frontend` | `test` | Frontend smoke. |
| `packages/examples/autonomous` | `test` | Example agent smoke. |
| `packages/examples/avatar` | `test` | VRM/avatar UI smoke. |
| `packages/examples/browser-extension` | `test` | Extension build plus Chrome/Safari smoke; split mutating lint into `lint:fix`. |
| `packages/examples/browser-extension/chrome` | `test` | Chrome extension smoke. |
| `packages/examples/browser-extension/safari` | `test` | Safari extension smoke; generated `.generated/extension` stays ignored. |
| `packages/examples/chat` | `test` | Example chat smoke. |
| `packages/examples/elizagotchi` | `test` | Example app smoke. |
| `packages/examples/farcaster` | `test` | Example integration smoke. |
| `packages/examples/form` | `test` | Form example smoke. |
| `packages/examples/game-of-life` | `test` | Example game smoke. |
| `packages/examples/gcp` | `test` | GCP example smoke. |
| `packages/examples/html` | `test` | Static HTML smoke. |
| `packages/examples/moltbook` | `test` | Example smoke. |
| `packages/examples/moltbook/bags-claimer` | `test` | Example smoke. |
| `packages/examples/next` | `test` | Next example build/smoke. |
| `packages/examples/react` | `test` | React example build/smoke. |
| `packages/examples/rest-api/elysia` | `test` | REST API smoke. |
| `packages/examples/rest-api/express` | `test` | REST API smoke. |
| `packages/examples/rest-api/hono` | `test` | REST API smoke. |
| `packages/examples/telegram` | `test` | Telegram example smoke; classify `shims.d.ts`. |
| `packages/examples/text-adventure` | `test` | Example smoke. |
| `packages/examples/tic-tac-toe` | `test` | Example smoke. |
| `packages/examples/trader` | `test` | Trader example smoke. |
| `packages/examples/twitter-xai` | `test` | Example smoke. |
| `plugins/app-2004scape` | `lint`, `typecheck`, `test` | Add package gates or mark app package root-validated. |
| `plugins/app-babylon` | `lint`, `typecheck`, `test` | Add package gates or mark app package root-validated. |
| `plugins/app-clawville` | `lint`, `typecheck`, `test` | Add package gates or mark app package root-validated. |
| `plugins/app-defense-of-the-agents` | `lint`, `typecheck` | Add package gates. |
| `plugins/app-documents` | `lint`, `typecheck`, `test` | Add package gates and document live-test lane. |
| `plugins/app-elizamaker` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-hyperliquid` | `lint`, `typecheck` | Add package gates. |
| `plugins/app-hyperscape` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-polymarket` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-scape` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-screenshare` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-shopify` | `lint`, `typecheck`, `test` | Add package gates and live API lane. |
| `plugins/app-task-coordinator` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-vincent` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/app-wallet` | `lint`, `typecheck`, `test` | Add package gates. |
| `plugins/plugin-agent-skills` | `test` | Add unit smoke. |
| `plugins/plugin-browser` | `lint`, `test` | Add lint and browser smoke lane. |
| `plugins/plugin-calendly` | `lint` | Add lint. |
| `plugins/plugin-capacitor-bridge` | `test` | Add bridge smoke. |
| `plugins/plugin-computeruse` | `lint` | Add lint; keep compat route tests. |
| `plugins/plugin-discord-local` | `test` | Add local plugin smoke. |
| `plugins/plugin-form` | `lint` | Add lint. |
| `plugins/plugin-github` | `lint` | Add lint. |
| `plugins/plugin-local-inference` | `test` | Add plugin smoke or delegate to inference package with explicit no-op. |
| `plugins/plugin-minecraft/mineflayer-server` | `lint`, `typecheck`, `test` | Add gates and package metadata check. |
| `plugins/plugin-shopify` | `lint`, `typecheck` | Add gates. |
| `plugins/plugin-telegram` | `typecheck` | Add typecheck. |
| `plugins/plugin-video` | `lint` | Add lint. |
| `plugins/plugin-web-search` | `test` | Add unit smoke. |
| `plugins/plugin-wechat` | `lint`, `typecheck` | Add gates. |
| `plugins/plugin-x402` | `test` | Add unit smoke. |

## Generated Spec Policy Backlog

The package scan found many `generated/specs` folders under provider and
utility plugins. These are not automatic deletion candidates because they may
be packaged source, but each package should declare one policy:

- generated at build time and ignored,
- committed deterministic source with a generator check,
- or test fixture data.

Affected packages include:

- `plugins/plugin-anthropic`
- `plugins/plugin-discord`
- `plugins/plugin-elizacloud`
- `plugins/plugin-farcaster`
- `plugins/plugin-google-genai`
- `plugins/plugin-groq`
- `plugins/plugin-inmemorydb`
- `plugins/plugin-instagram`
- `plugins/plugin-linear`
- `plugins/plugin-local-ai`
- `plugins/plugin-mcp`
- `plugins/plugin-minecraft`
- `plugins/plugin-ollama`
- `plugins/plugin-openai`
- `plugins/plugin-openrouter`
- `plugins/plugin-pdf`
- `plugins/plugin-roblox`
- `plugins/plugin-sql`
- `plugins/plugin-tee`
- `plugins/plugin-vision`
- `plugins/plugin-wallet`

Recommended validation:

```sh
rg -n "generated/specs" plugins packages
bun run build
git diff --exit-code -- plugins packages
```

## No Immediate Package-Structure Finding

These packages had complete local gates or no obvious package-structure
cleanup finding in this pass. They may still appear in the suppression or
quality-marker report for line-level cleanup.

- `cloud/packages/billing` / `@elizaos/billing`
- `cloud/packages/sdk` / `@elizaos/cloud-sdk`
- `packages/benchmarks/gauntlet/sdk/typescript` / `@solana-gauntlet/sdk`
- `packages/cloud-routing` / `@elizaos/cloud-routing`
- `packages/workflows` / `@elizaos/workflows`
- `packages/elizaos/templates/min-plugin`
- `packages/elizaos/templates/min-project`
- `packages/elizaos/templates/plugin`
- `packages/elizaos/templates/project/apps/app/electrobun`
- `packages/examples/_plugin`
- `packages/examples/a2a`
- `packages/examples/app/capacitor/backend`
- `packages/examples/app/electron/backend`
- `packages/examples/bluesky`
- `packages/examples/cloudflare`
- `packages/examples/code`
- `packages/examples/discord`
- `packages/examples/farcaster-miniapp`
- `packages/examples/lp-manager`
- `packages/examples/mcp`
- `packages/examples/vercel`
- `plugins/app-contacts`
- `plugins/app-phone`
- `plugins/app-trajectory-logger`
- `plugins/app-wifi`
- `plugins/plugin-aosp-local-inference`
- `plugins/plugin-background-runner`
- `plugins/plugin-bluebubbles`
- `plugins/plugin-bluesky`
- `plugins/plugin-cli`
- `plugins/plugin-codex-cli`
- `plugins/plugin-coding-tools`
- `plugins/plugin-commands`
- `plugins/plugin-device-filesystem`
- `plugins/plugin-edge-tts`
- `plugins/plugin-elevenlabs`
- `plugins/plugin-eliza-classic`
- `plugins/plugin-feishu`
- `plugins/plugin-google`
- `plugins/plugin-google-chat`
- `plugins/plugin-imessage`
- `plugins/plugin-line`
- `plugins/plugin-lmstudio`
- `plugins/plugin-local-embedding`
- `plugins/plugin-local-storage`
- `plugins/plugin-localdb`
- `plugins/plugin-matrix`
- `plugins/plugin-mlx`
- `plugins/plugin-ngrok`
- `plugins/plugin-nostr`
- `plugins/plugin-rlm`
- `plugins/plugin-signal`
- `plugins/plugin-slack`
- `plugins/plugin-social-alpha`
- `plugins/plugin-streaming`
- `plugins/plugin-suno`
- `plugins/plugin-tailscale`
- `plugins/plugin-todos`
- `plugins/plugin-tunnel`
- `plugins/plugin-twitch`
- `plugins/plugin-whatsapp`
- `plugins/plugin-x`
- `plugins/plugin-xai`

## Implementation Order From This Matrix

1. Apply no-source-risk cleanup first: delete untracked inference run reports,
   ensure ignored generated output patterns are durable, and run `git status`.
2. Normalize package validation scripts across app, plugin, native, example,
   and cloud packages. Prefer real gates; use explicit no-op gates only when
   another package owns validation.
3. Consolidate byte-identical UI/shared duplicates: config modules and
   `sql-compat`.
4. Remove cross-package source reach-through imports by adding public exports or
   moving shared test helpers into a dedicated package.
5. Classify compat/shim/fallback files. Delete only fresh-grep-clean dead files
   such as the LifeOps resolver shim; keep live migrations, route aliases, and
   provider protocol compatibility until their product/API owners sunset them.
6. Split artifact-heavy benchmark, inference, training, and mobile bundle
   outputs into source fixtures, reproducible generated outputs, and external
   datasets.
7. Re-run the validation baseline from `VALIDATION_STATUS.md`, then re-run
   `knip` after the local native binding blocker is fixed.
