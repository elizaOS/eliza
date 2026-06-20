# Convergence, Annotation, and Deletion Audit

Generated: 2026-06-20T19:58:51.166Z

Branch: develop

Ahead/behind origin/develop: 1	0

Dirty status at generation:

- M bun.lock
- M knip.json
- M packages/agent/src/__tests__/game-tui-mounted-surfaces.test.tsx
- M packages/agent/src/__tests__/plugin-tui-view-coverage.test.ts
- M packages/agent/src/__tests__/view-agent-surface-coverage.test.ts
- M packages/agent/src/__tests__/view-bundle-lifecycle.test.ts
- M packages/agent/src/__tests__/view-user-journeys.ts
- M packages/agent/src/runtime/view-action-affinity.test.ts
- M packages/agent/src/runtime/view-action-affinity.ts
- M packages/agent/src/services/app-package-modules.ts
- M packages/agent/src/services/registry-client-app-meta.ts
- M packages/app-core/platforms/android/app/capacitor.build.gradle
- M packages/app-core/platforms/android/capacitor.settings.gradle
- M packages/app-core/platforms/electrobun/docs/convergence-audit.json
- M packages/app-core/platforms/electrobun/docs/convergence-audit.md
- M packages/app-core/platforms/electrobun/scripts/generate-convergence-audit.ts
- M packages/app-core/platforms/electrobun/src/native/canvas.ts
- M packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs
- M packages/app-core/scripts/release-check.ts
- D packages/app-core/src/registry/entries/apps/2004scape.json
- D packages/app-core/src/registry/entries/apps/hyperscape.json
- D packages/app-core/src/registry/entries/apps/scape.json
- M packages/app/capacitor.config.ts
- M packages/app/docs/EXTERNAL_API_MOCK_VALIDATION.md
- M packages/app/package.json
- M packages/app/src/plugin-registrations.test.ts
- M packages/app/src/plugin-registrations.ts
- M packages/app/src/types/app-plugin-modules.d.ts
- M packages/app/src/types/side-effect-app-modules.d.ts
- M packages/app/test/electrobun-packaged/mock-api.ts
- M packages/app/test/external-api-mock-validation.test.ts
- M packages/app/test/fixtures/plugin-view-visual-review.md
- M packages/app/test/hmr/hmr-dependency-levels.spec.ts
- M packages/app/test/route-coverage.test.ts
- M packages/app/test/ui-smoke/apps-session-route-cases.ts
- D  packages/app/test/ui-smoke/game-operator-gui-interactions.spec.ts
- M packages/app/test/ui-smoke/plugin-view-cases.ts
- M packages/app/test/view-interaction-coverage.test.ts
- M packages/app/tsconfig.typecheck.json
- M packages/app/vite.config.ts
- M packages/cloud-shared/src/lib/services/eliza-sandbox.ts
- M packages/cloud-shared/src/lib/services/provisioning-jobs-delete-enqueue.test.ts
- M packages/cloud-shared/src/lib/services/provisioning-jobs.ts
- M packages/core/src/generated/action-docs.ts
- M packages/core/src/runtime.ts
- M packages/core/src/services/message.ts
- M packages/core/src/types/runtime.ts
- M packages/docs/action-catalog.md
- M packages/docs/apps/mobile.md
- M packages/docs/apps/overview.md
- M packages/docs/dashboard/apps.md
- M packages/elizaos/templates/project/apps/app/capacitor.config.ts
- M packages/elizaos/templates/project/apps/app/test/electrobun-packaged/mock-api.ts
- M packages/elizaos/templates/project/apps/app/tsconfig.json
- M packages/prompts/specs/actions/plugins.generated.json
- M packages/shared/src/contracts/apps.ts
- M packages/shared/src/i18n/keywords/action-search.generated.keywords.json
- M packages/shared/src/i18n/keywords/shared.keywords.json
- M packages/ui/src/components/apps/GameView.tsx
- M packages/ui/src/components/apps/helpers.ts
- M packages/ui/src/components/shell/ContinuousChatOverlay.test.tsx
- M packages/ui/src/components/shell/ContinuousChatOverlay.tsx
- M packages/ui/src/components/views/ViewIcon.tsx
- D plugins/plugin-2004scape/AGENTS.md
- D plugins/plugin-2004scape/CLAUDE.md
- D plugins/plugin-2004scape/README.md
- D plugins/plugin-2004scape/package.json
- D plugins/plugin-2004scape/src/__tests__/detail-extension.test.tsx
- D plugins/plugin-2004scape/src/__tests__/fixtures.ts
- D plugins/plugin-2004scape/src/__tests__/interact.test.ts
- D plugins/plugin-2004scape/src/__tests__/operator-surface.test.tsx
- D plugins/plugin-2004scape/src/__tests__/telemetry-parser.contract.test.ts
- D plugins/plugin-2004scape/src/__tests__/tui-view.test.tsx
- D plugins/plugin-2004scape/src/actions/game-service.ts
- D plugins/plugin-2004scape/src/actions/index.ts
- D plugins/plugin-2004scape/src/actions/rs2004.ts
- D plugins/plugin-2004scape/src/components/TwoThousandFourScapeSpatialView.test.tsx
- D plugins/plugin-2004scape/src/components/TwoThousandFourScapeSpatialView.tsx
- D plugins/plugin-2004scape/src/gateway/index.ts
- D plugins/plugin-2004scape/src/index.ts
- D plugins/plugin-2004scape/src/providers/bot-state.ts
- D plugins/plugin-2004scape/src/providers/goals.ts
- D plugins/plugin-2004scape/src/providers/index.ts
- D plugins/plugin-2004scape/src/providers/map-area.ts
- D plugins/plugin-2004scape/src/providers/service-access.ts
- D plugins/plugin-2004scape/src/providers/world-knowledge.ts
- D plugins/plugin-2004scape/src/register-terminal-view.tsx
- D plugins/plugin-2004scape/src/routes.ts
- D plugins/plugin-2004scape/src/sdk/actions-helpers.ts
- D plugins/plugin-2004scape/src/sdk/actions.ts
- D plugins/plugin-2004scape/src/sdk/index.ts
- D plugins/plugin-2004scape/src/sdk/types.ts
- D plugins/plugin-2004scape/src/services/autonomous-loop-prompt.ts
- D plugins/plugin-2004scape/src/services/bot-manager.ts
- D plugins/plugin-2004scape/src/services/game-service.ts
- D plugins/plugin-2004scape/src/shared-state.ts
- D plugins/plugin-2004scape/src/ui/2004scape-view-bundle.ts
- D plugins/plugin-2004scape/src/ui/TwoThousandFourScapeDetailExtension.tsx
- D plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.helpers.ts
- D plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.interact.ts
- D plugins/plugin-2004scape/src/ui/TwoThousandFourScapeOperatorSurface.tsx
- D plugins/plugin-2004scape/src/ui/game-surface-shell.tsx
- D plugins/plugin-2004scape/src/ui/index.ts
- D plugins/plugin-2004scape/tsconfig.build.json
- D plugins/plugin-2004scape/tsconfig.json
- D plugins/plugin-2004scape/vite.config.views.ts
- D plugins/plugin-2004scape/vitest.config.ts
- M plugins/plugin-app-manager/AGENTS.md
- M plugins/plugin-app-manager/CLAUDE.md
- M plugins/plugin-app-manager/src/api/apps-routes.ts
- M plugins/plugin-app-manager/src/services/app-manager.ts
- M plugins/plugin-facewear/app-xr/e2e/all-views-crud.spec.ts
- M plugins/plugin-facewear/src/__tests__/feature-parity.test.ts
- M plugins/plugin-facewear/src/__tests__/view-host-http.test.ts
- M plugins/plugin-facewear/src/__tests__/view-host.test.ts
- M plugins/plugin-facewear/src/actions/view-actions.ts
- M plugins/plugin-facewear/src/actions/xr-view-actions.ts
- M plugins/plugin-feed/src/ui/FeedDetailExtension.render.test.tsx
- M plugins/plugin-feed/src/ui/FeedOperatorSurface.render.test.tsx
- D plugins/plugin-hyperscape/AGENTS.md
- D plugins/plugin-hyperscape/CLAUDE.md
- D plugins/plugin-hyperscape/README.md
- D plugins/plugin-hyperscape/package.json
- D plugins/plugin-hyperscape/src/components/HyperscapeSpatialView.test.tsx
- D plugins/plugin-hyperscape/src/components/HyperscapeSpatialView.tsx
- D plugins/plugin-hyperscape/src/index.ts
- D plugins/plugin-hyperscape/src/register-terminal-view.tsx
- D plugins/plugin-hyperscape/src/routes.contract.test.ts
- D plugins/plugin-hyperscape/src/routes.ts
- D plugins/plugin-hyperscape/src/ui/HyperscapeDetailExtension.test.tsx
- D plugins/plugin-hyperscape/src/ui/HyperscapeDetailExtension.tsx
- D plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.interact.test.ts
- D plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.interact.ts
- D plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.test.tsx
- D plugins/plugin-hyperscape/src/ui/HyperscapeOperatorSurface.tsx
- D plugins/plugin-hyperscape/src/ui/HyperscapeTuiView.test.tsx
- D plugins/plugin-hyperscape/src/ui/hyperscape-view-bundle.ts
- D plugins/plugin-hyperscape/src/ui/index.ts
- D plugins/plugin-hyperscape/src/ui/test-support.ts
- D plugins/plugin-hyperscape/tsconfig.build.json
- D plugins/plugin-hyperscape/tsconfig.json
- D plugins/plugin-hyperscape/vite.config.views.ts
- D plugins/plugin-hyperscape/vitest.config.ts
- D plugins/plugin-scape/AGENTS.md
- D plugins/plugin-scape/CLAUDE.md
- D plugins/plugin-scape/README.md
- D plugins/plugin-scape/elizaos.plugin.json
- D plugins/plugin-scape/package.json
- D plugins/plugin-scape/src/actions/index.ts
- D plugins/plugin-scape/src/actions/param-parser.ts
- D plugins/plugin-scape/src/actions/scape.ts
- D plugins/plugin-scape/src/components/ScapeSpatialView.test.tsx
- D plugins/plugin-scape/src/components/ScapeSpatialView.tsx
- D plugins/plugin-scape/src/index.ts
- D plugins/plugin-scape/src/journal/journal-store.ts
- D plugins/plugin-scape/src/journal/types.ts
- D plugins/plugin-scape/src/providers/bot-state.ts
- D plugins/plugin-scape/src/providers/goals.ts
- D plugins/plugin-scape/src/providers/index.ts
- D plugins/plugin-scape/src/providers/inventory.ts
- D plugins/plugin-scape/src/providers/journal.ts
- D plugins/plugin-scape/src/providers/nearby.ts
- D plugins/plugin-scape/src/register-terminal-view.tsx
- D plugins/plugin-scape/src/routes.telemetry.test.ts
- D plugins/plugin-scape/src/routes.ts
- D plugins/plugin-scape/src/sdk/index.ts
- D plugins/plugin-scape/src/sdk/json.ts
- D plugins/plugin-scape/src/sdk/types.ts
- D plugins/plugin-scape/src/services/agent-identity.ts
- D plugins/plugin-scape/src/services/autonomous-loop-prompt.ts
- D plugins/plugin-scape/src/services/bot-manager.ts
- D plugins/plugin-scape/src/services/game-service.ts
- D plugins/plugin-scape/src/services/journal-service.ts
- D plugins/plugin-scape/src/shared-state.ts
- D plugins/plugin-scape/src/ui/ScapeOperatorSurface.interact.test.ts
- D plugins/plugin-scape/src/ui/ScapeOperatorSurface.interact.ts
- D plugins/plugin-scape/src/ui/ScapeOperatorSurface.test.tsx
- D plugins/plugin-scape/src/ui/ScapeOperatorSurface.tsx
- D plugins/plugin-scape/src/ui/ScapeTuiView.test.tsx
- D plugins/plugin-scape/src/ui/game-surface-shell.tsx
- D plugins/plugin-scape/src/ui/index.ts
- D plugins/plugin-scape/src/ui/scape-view-bundle.ts
- D plugins/plugin-scape/src/ui/test-support.ts
- D plugins/plugin-scape/tsconfig.build.json
- D plugins/plugin-scape/tsconfig.json
- D plugins/plugin-scape/vite.config.views.ts
- D plugins/plugin-scape/vitest.config.ts
- M plugins/plugin-trajectory-logger/package.json
- M plugins/plugin-trajectory-logger/src/index.ts
- M plugins/plugin-xr/src/__tests__/xr-bundle-coverage.test.ts
- M plugins/plugin-xr/src/__tests__/xr-feature-parity.test.ts
- M plugins/plugin-xr/src/__tests__/xr-functional-parity.test.ts
- M plugins/plugin-xr/src/__tests__/xr-view-host-http.test.ts
- M plugins/plugin-xr/src/__tests__/xr-view-host.test.ts
- M plugins/plugin-xr/src/actions/xr-view-actions.ts
- M scripts/spatial-convert-plugin-views.workflow.js
- M tsconfig.dist-paths.json
- M tsconfig.json
- ?? _railway_errors.mjs
- ?? _railway_inspect.mjs
- ?? a.out
- ?? packages/core/src/__tests__/compose-state-refresh-providers.test.ts
- ?? packages/ui/src/components/shell/ContinuousChatOverlay.fuzz.test.tsx
- ?? plugins/plugin-trajectory-logger/src/plugin.ts

## Executive Summary

This audit stops the infrastructure-building spiral. Plugins stay plugins, app plugins stay app/product bundles, connectors stay connector plugins, Electrobun remains the desktop shell, AgentManager remains the runtime owner, and Remotes remain limited to desktop/system capability providers.

The current local branch may still contain multiple phases, but it should not be pushed blindly as a broad mega-PR unless maintainers explicitly want that review shape. The stack recommendation below keeps the work reviewable without changing the architectural boundary decisions.

No Swift host/controller path is part of this architecture. The only retained boundary pattern is typed RPC/local API/SSE between layers.

## Summary Counts

### By Category

| Category | Count |
| --- | --- |
| core-runtime | 4 |
| desktop-shell | 5 |
| production-ui | 1 |
| app-plugin | 35 |
| connector-plugin | 35 |
| model-plugin | 7 |
| voice-plugin | 3 |
| native-semantic-plugin | 36 |
| desktop-capability | 6 |
| data-memory-plugin | 4 |
| dev-tooling | 12 |
| provider-plugin | 8 |
| unknown | 16 |

### By Recommended Next Action

| Action | Count |
| --- | --- |
| leave-alone | 37 |
| add-trace-hooks | 74 |
| add-dynamic-view-manifest | 13 |
| route-through-runtime-broker | 21 |
| connect-to-voice-pipeline | 3 |
| connect-to-local-model | 7 |
| needs-owner-decision | 17 |

## Hard No-Migration List

- packages/app
- packages/core
- packages/agent
- packages/app-core
- packages/app-core/platforms/electrobun core shell
- packages/electrobun-remote-plugins
- connector plugins
- provider plugins
- app plugins
- core runtime plugins

## Current Remotes

- eliza.fs
- eliza.git
- eliza.local-model
- eliza.pty
- eliza.runtime
- eliza.surface

eliza.surface remains dev/admin only and is not a production UI replacement.

## Future Remote Candidates

- future.eliza.computer

This list is intentionally short. Do not turn connector, provider, or app plugins into Remotes.

## Trace-First Candidates

- future.eliza.computer
- packages/app-core/platforms/electrobun/src/trace
- packages/app-core/platforms/electrobun/src/voice
- packages/shared/src/local-inference
- plugin-agent-orchestrator
- plugin-agent-skills
- plugin-bluebubbles
- plugin-bluesky
- plugin-browser
- plugin-calendly
- plugin-capacitor-bridge
- plugin-codex-cli
- plugin-coding-tools
- plugin-computeruse
- plugin-contacts
- plugin-device-filesystem
- plugin-device-settings
- plugin-discord
- plugin-discord-local
- plugin-documents
- plugin-farcaster
- plugin-feishu
- plugin-github
- plugin-google
- plugin-google-chat
- plugin-google-meet-cute
- plugin-imessage
- plugin-instagram
- plugin-line
- plugin-linear
- plugin-local-inference
- plugin-matrix
- plugin-mcp
- plugin-messages
- plugin-native-activity-tracker
- plugin-native-agent
- plugin-native-appblocker
- plugin-native-bun-runtime
- plugin-native-calendar
- plugin-native-camera
- plugin-native-canvas
- plugin-native-contacts
- plugin-native-desktop
- plugin-native-eliza-tasks
- plugin-native-gateway
- plugin-native-location
- plugin-native-macosalarm
- plugin-native-messages
- plugin-native-mobile-agent-bridge
- plugin-native-mobile-signals
- plugin-native-network-policy
- plugin-native-phone
- plugin-native-reminders
- plugin-native-screencapture
- plugin-native-shared-types
- plugin-native-swabble
- plugin-native-system
- plugin-native-talkmode
- plugin-native-websiteblocker
- plugin-native-wifi
- plugin-ngrok
- plugin-nostr
- plugin-screenshare
- plugin-shell
- plugin-shopify
- plugin-signal
- plugin-slack
- plugin-social-alpha
- plugin-tailscale
- plugin-task-coordinator
- plugin-telegram
- plugin-training
- plugin-tunnel
- plugin-twitch
- plugin-vincent
- plugin-web-search
- plugin-wechat
- plugin-whatsapp
- plugin-wifi
- plugin-workflow
- plugin-x
- plugin-x402
- plugin-xmtp

## Dynamic-View Candidates

- app-model-tester
- eliza.surface
- packages/app-core/platforms/electrobun/src/dynamic-views
- packages/app-core/platforms/electrobun/src/trace
- packages/app-core/platforms/electrobun/src/voice
- plugin-agent-orchestrator
- plugin-agent-skills
- plugin-browser
- plugin-coding-tools
- plugin-computeruse
- plugin-documents
- plugin-github
- plugin-native-canvas
- plugin-native-screencapture
- plugin-task-coordinator
- plugin-training
- plugin-workflow

## Voice/Local-Model Candidates

- packages/app-core/platforms/electrobun/src/voice
- packages/shared/src/local-inference
- plugin-aosp-local-inference
- plugin-edge-tts
- plugin-elevenlabs
- plugin-lmstudio
- plugin-local-inference
- plugin-native-llama
- plugin-native-talkmode
- plugin-ollama
- plugin-rlm

## Runtime-Broker Candidates

- eliza.fs
- eliza.git
- eliza.local-model
- eliza.pty
- eliza.runtime
- future.eliza.computer
- plugin-browser
- plugin-capacitor-bridge
- plugin-codex-cli
- plugin-coding-tools
- plugin-computeruse
- plugin-contacts
- plugin-device-filesystem
- plugin-device-settings
- plugin-native-activity-tracker
- plugin-native-appblocker
- plugin-native-bun-runtime
- plugin-native-calendar
- plugin-native-camera
- plugin-native-canvas
- plugin-native-contacts
- plugin-native-desktop
- plugin-native-location
- plugin-native-macosalarm
- plugin-native-messages
- plugin-native-phone
- plugin-native-screencapture
- plugin-native-system
- plugin-native-wifi
- plugin-screenshare
- plugin-shell
- plugin-wifi

## Delete/Deprecate Candidates

| Path | Reason | Confidence | Safe Now | Owner Decision | Validation |
| --- | --- | --- | --- | --- | --- |
packages/app-core/platforms/electrobun/build | Generated local build output. It should not be part of architecture or PR review scope. | medium | no | no | confirm ignored/untracked status, rerun build if removed
dist | Generated local build output. It should not be part of architecture or PR review scope. | medium | no | no | confirm ignored/untracked status, rerun build if removed
plugins/plugin-action-bench | Plugin-shaped directory without package.json. Needs owner review before deletion or restoration. | low | no | yes | search imports, check package registry references
plugins/plugin-google-meet-cute | Plugin-shaped directory without package.json. Needs owner review before deletion or restoration. | low | no | yes | search imports, check package registry references
plugins/plugin-xmtp | Plugin-shaped directory without package.json. Needs owner review before deletion or restoration. | low | no | yes | search imports, check package registry references

## Owner-Decision Items

- future.eliza.computer
- plugin-ainex
- plugin-blocker
- plugin-calendar
- plugin-facewear
- plugin-finances
- plugin-gitpathologist
- plugin-goals
- plugin-inbox
- plugin-nearai
- plugin-relationships
- plugin-reminders
- plugin-remote-desktop
- plugin-scheduling
- plugin-undesirables
- plugin-vector-browser
- plugin-xr

## Proposed Annotation Plan

- Add README-level role annotations to trace-first candidates before wiring behavior.
- Use `docs/trace-first-annotations.md` as the first review-boundary map for top trace-first packages.
- Add dynamic-view manifests only for contextual inspection surfaces, not fixed dashboards.
- Keep connector/provider package metadata unchanged unless maintainers already have a metadata convention.
- Keep Remote manifests focused on capability boundaries and trusted/full-permission status.
- Do not add source comments unless a hidden constraint or security boundary would otherwise be unclear.

## PR Stack Recommendation

Do not blindly push every local phase into the platform convergence PR unless maintainers explicitly ask for a mega-PR. Recommended stack:

1. Platform convergence PR
   - first-party Remotes
   - AgentManager-backed eliza.runtime
   - worker invoke/event bridge
   - dynamic view registry/session infrastructure

2. Trace PR
   - TraceStore and TraceService
   - dynamic agent.run.trace view
   - runtime and capability trace hooks

3. Voice instrumentation PR
   - VoiceService
   - mock/text pipeline
   - voice trace integration

4. Live voice adapter PR
   - VoiceRuntimeAdapter
   - live flags
   - ASR/TTS runtime route wiring

5. Voice latency PR
   - latency budgets
   - stream coordinator
   - TTS chunker
   - barge-in semantics

6. Voice validation PR
   - voice:validate scripts
   - structured validation reports

7. Convergence audit PR
   - this matrix and generator
   - no migration or production code changes

## Full Matrix

| ID | Category | Keep As | Next Action | Dynamic View | Trace | Broker | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| app-model-tester | app-plugin | app-plugin | add-dynamic-view-manifest | yes | no | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| eliza.fs | desktop-capability | remote | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.git | desktop-capability | remote | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.local-model | desktop-capability | remote | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.pty | desktop-capability | remote | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.runtime | desktop-capability | remote | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.surface | dev-tooling | remote | leave-alone | yes | no | no | medium | Dev/admin only. Do not turn into production UI. |
| future.eliza.computer | desktop-capability | needs-review | needs-owner-decision | no | yes | yes | medium | Only future Remote candidate. Do not create until a concrete host capability boundary is required. |
| packages/agent | core-runtime | core | leave-alone | no | no | no | low | AgentManager/Electrobun may own lifecycle, but agent runtime code stays in runtime packages. |
| packages/app | production-ui | core | leave-alone | no | no | no | low | Hard no-migration item. Do not replace with eliza.surface or fixed dynamic-view panels. |
| packages/app-core | core-runtime | core | leave-alone | no | no | no | low | Hard no-migration item. Electrobun platform code can add host docs, not absorb app-core ownership. |
| packages/app-core/platforms/electrobun | desktop-shell | core | leave-alone | no | no | no | low | Electrobun is the shell, not the agent runtime. Keep AgentManager as runtime lifecycle owner. |
| packages/app-core/platforms/electrobun/src/dynamic-views | desktop-shell | core | leave-alone | yes | no | no | low | Contextual view substrate only. Do not convert into dashboard navigation. |
| packages/app-core/platforms/electrobun/src/trace | desktop-shell | core | leave-alone | yes | yes | no | low | Observability spine. Plugins should emit trace events; trace should not become a static dashboard. |
| packages/app-core/platforms/electrobun/src/voice | desktop-shell | core | leave-alone | yes | yes | no | low | Voice is a pipeline. Keep live behavior gated and report through trace. |
| packages/core | core-runtime | core | leave-alone | no | no | no | low | Hard no-migration item. Runtime semantics stay here. |
| packages/electrobun-remote-plugins | desktop-shell | core | leave-alone | no | no | no | low | Keep as module runtime substrate. Do not turn into a second plugin system. |
| packages/shared/src/local-inference | model-plugin | model-pipeline-participant | connect-to-local-model | no | yes | no | medium | Source of truth for Eliza-1 and voice metadata. Do not duplicate in Electrobun. |
| plugin-action-bench | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-agent-orchestrator | dev-tooling | plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-agent-skills | dev-tooling | plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-ainex | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-anthropic | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-anthropic-proxy | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-aosp-local-inference | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-app-control | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-app-manager | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-background-runner | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-benchmarks | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-blocker | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-bluebubbles | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-bluesky | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-browser | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-calendar | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-calendly | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-capacitor-bridge | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-clawville | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-cli | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-codex-cli | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-coding-tools | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-commands | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-companion | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-computeruse | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-contacts | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-defense-of-the-agents | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-device-filesystem | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-device-settings | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-discord | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-discord-local | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-documents | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-edge-tts | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | no | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-elevenlabs | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | no | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-eliza-classic | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-elizacloud | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-elizamaker | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-facewear | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-farcaster | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-feed | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-feishu | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-finances | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-form | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-github | connector-plugin | connector | add-dynamic-view-manifest | yes | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-gitpathologist | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-goals | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-google | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-google-chat | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-google-genai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-google-meet-cute | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-groq | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-health | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-hyperliquid-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-imessage | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-inbox | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-inmemorydb | data-memory-plugin | plugin | leave-alone | no | no | no | low | Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun. |
| plugin-instagram | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-line | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-linear | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-lmstudio | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-local-inference | model-plugin | model-pipeline-participant | connect-to-local-model | no | yes | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-local-storage | data-memory-plugin | plugin | leave-alone | no | no | no | low | Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun. |
| plugin-localdb | data-memory-plugin | plugin | leave-alone | no | no | no | low | Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun. |
| plugin-matrix | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-mcp | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-messages | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-minecraft | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-music | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-mysticism | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-native-activity-tracker | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-agent | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-appblocker | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-bun-runtime | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-calendar | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-camera | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-canvas | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-native-contacts | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-desktop | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-eliza-tasks | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-gateway | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-llama | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-native-location | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-macosalarm | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-messages | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-mobile-agent-bridge | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-mobile-signals | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-network-policy | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-phone | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-reminders | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-screencapture | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-native-shared-types | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-swabble | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-system | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-talkmode | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | yes | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-native-websiteblocker | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-native-wifi | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-nearai | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-ngrok | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-nostr | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-ollama | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-openai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-openrouter | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-pdf | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-personal-assistant | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-phone | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-polymarket-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-registry | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-relationships | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-reminders | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-remote-desktop | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-rlm | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-roblox | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-scheduling | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-screenshare | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-shell | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-shopify | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-shopify-ui | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-signal | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-slack | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-social-alpha | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-sql | data-memory-plugin | plugin | leave-alone | no | no | no | low | Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun. |
| plugin-steward-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-streaming | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-suno | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-tailscale | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-task-coordinator | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-tee | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-telegram | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-todos | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-training | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-trajectory-logger | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-tunnel | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-twitch | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-undesirables | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-vector-browser | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-video | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-vincent | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-vision | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-waifu-imagegen-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-waifu-swap-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-wallet | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-wallet-ui | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-web-search | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-wechat | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-whatsapp | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-wifi | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed. |
| plugin-workflow | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-x | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-x402 | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-xai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| plugin-xmtp | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-xr | unknown | needs-review | needs-owner-decision | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-zai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote. |
| repo-root | core-runtime | core | leave-alone | no | no | no | low | Keep as workspace root. Do not use Electrobun convergence to change global repo ownership. |
