# Convergence, Annotation, and Deletion Audit

Generated: 2026-05-17T17:53:44.862Z

Branch: codex/phase-11-event-bridge-wip

Ahead/behind origin/develop: 22	0

Dirty status at generation:

- M packages/app-core/platforms/electrobun/scripts/generate-convergence-audit.ts

## Executive Summary

This audit stops the infrastructure-building spiral. Plugins stay plugins, app plugins stay app/product bundles, connectors stay connector plugins, Electrobun remains the desktop shell, AgentManager remains the runtime owner, and Satellites remain limited to desktop/system capability providers.

The current local branch may still contain multiple phases, but it should not be pushed blindly as a broad mega-PR unless maintainers explicitly want that review shape. The stack recommendation below keeps the work reviewable without changing the architectural boundary decisions.

No Swift host/controller path is part of this architecture. The only retained boundary pattern is typed RPC/local API/SSE between layers.

## Summary Counts

### By Category

| Category | Count |
| --- | --- |
| core-runtime | 4 |
| desktop-shell | 5 |
| production-ui | 1 |
| app-plugin | 36 |
| connector-plugin | 35 |
| model-plugin | 8 |
| voice-plugin | 4 |
| native-semantic-plugin | 35 |
| desktop-capability | 6 |
| data-memory-plugin | 4 |
| dev-tooling | 12 |
| provider-plugin | 8 |

### By Recommended Next Action

| Action | Count |
| --- | --- |
| leave-alone | 37 |
| add-trace-hooks | 74 |
| add-dynamic-view-manifest | 13 |
| route-through-runtime-broker | 21 |
| connect-to-voice-pipeline | 4 |
| connect-to-local-model | 8 |
| needs-owner-decision | 1 |

## Hard No-Migration List

- packages/app
- packages/core
- packages/agent
- packages/app-core
- packages/app-core/platforms/electrobun core shell
- packages/electrobun-carrots
- connector plugins
- provider plugins
- app plugins
- core runtime plugins

## Current Satellites

- eliza.fs
- eliza.git
- eliza.local-model
- eliza.pty
- eliza.runtime
- eliza.surface

eliza.surface remains dev/admin only and is not a production UI replacement.

## Future Satellite Candidates

- future.eliza.computer

This list is intentionally short. Do not turn connector, provider, or app plugins into Satellites.

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
- plugin-mlx
- plugin-native-llama
- plugin-native-talkmode
- plugin-ollama
- plugin-omnivoice
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

## Proposed Annotation Plan

- Add README-level role annotations to trace-first candidates before wiring behavior.
- Use `docs/trace-first-annotations.md` as the first review-boundary map for top trace-first packages.
- Add dynamic-view manifests only for contextual inspection surfaces, not fixed dashboards.
- Keep connector/provider package metadata unchanged unless maintainers already have a metadata convention.
- Keep Satellite manifests focused on capability boundaries and trusted/full-permission status.
- Do not add source comments unless a hidden constraint or security boundary would otherwise be unclear.

## PR Stack Recommendation

Do not blindly push every local phase into the platform convergence PR unless maintainers explicitly ask for a mega-PR. Recommended stack:

1. Platform convergence PR
   - first-party Satellites
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
| eliza.fs | desktop-capability | satellite | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.git | desktop-capability | satellite | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.local-model | desktop-capability | satellite | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.pty | desktop-capability | satellite | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.runtime | desktop-capability | satellite | leave-alone | no | yes | yes | low | Already a desktop/system capability provider. Keep scoped and brokered through host APIs. |
| eliza.surface | dev-tooling | satellite | leave-alone | yes | no | no | medium | Dev/admin only. Do not turn into production UI. |
| future.eliza.computer | desktop-capability | needs-review | needs-owner-decision | no | yes | yes | medium | Only future Satellite candidate. Do not create until a concrete host capability boundary is required. |
| packages/agent | core-runtime | core | leave-alone | no | no | no | low | AgentManager/Electrobun may own lifecycle, but agent runtime code stays in runtime packages. |
| packages/app | production-ui | core | leave-alone | no | no | no | low | Hard no-migration item. Do not replace with eliza.surface or fixed dynamic-view panels. |
| packages/app-core | core-runtime | core | leave-alone | no | no | no | low | Hard no-migration item. Electrobun platform code can add host docs, not absorb app-core ownership. |
| packages/app-core/platforms/electrobun | desktop-shell | core | leave-alone | no | no | no | low | Electrobun is the shell, not the agent runtime. Keep AgentManager as runtime lifecycle owner. |
| packages/app-core/platforms/electrobun/src/dynamic-views | desktop-shell | core | leave-alone | yes | no | no | low | Contextual view substrate only. Do not convert into dashboard navigation. |
| packages/app-core/platforms/electrobun/src/trace | desktop-shell | core | leave-alone | yes | yes | no | low | Observability spine. Plugins should emit trace events; trace should not become a static dashboard. |
| packages/app-core/platforms/electrobun/src/voice | desktop-shell | core | leave-alone | yes | yes | no | low | Voice is a pipeline. Keep live behavior gated and report through trace. |
| packages/core | core-runtime | core | leave-alone | no | no | no | low | Hard no-migration item. Runtime semantics stay here. |
| packages/electrobun-carrots | desktop-shell | core | leave-alone | no | no | no | low | Keep as module runtime substrate. Do not turn into a second plugin system. |
| packages/shared/src/local-inference | model-plugin | model-pipeline-participant | connect-to-local-model | no | yes | no | medium | Source of truth for Eliza-1 and voice metadata. Do not duplicate in Electrobun. |
| plugin-2004scape | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-action-bench | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-agent-orchestrator | dev-tooling | plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-agent-skills | dev-tooling | plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-anthropic | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-anthropic-proxy | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-aosp-local-inference | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-app-control | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-app-manager | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-feed | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-background-runner | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-benchmarks | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-bluebubbles | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-bluesky | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-browser | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-calendly | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-capacitor-bridge | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-clawville | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-cli | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-codex-cli | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-coding-tools | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-commands | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-companion | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-computeruse | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-contacts | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-defense-of-the-agents | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-device-filesystem | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-device-settings | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-discord | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-discord-local | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-documents | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-edge-tts | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | no | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-elevenlabs | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | no | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-eliza-classic | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-elizacloud | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-elizamaker | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-farcaster | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-feishu | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-form | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-github | connector-plugin | connector | add-dynamic-view-manifest | yes | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-google | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-google-chat | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-google-genai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-google-meet-cute | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-groq | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-health | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-hyperliquid-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-hyperscape | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-imessage | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-inmemorydb | data-memory-plugin | plugin | leave-alone | no | no | no | low | Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun. |
| plugin-instagram | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-lifeops | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
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
| plugin-mlx | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-music | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-mysticism | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-native-activity-tracker | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-agent | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-appblocker | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-bun-runtime | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-calendar | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-camera | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-canvas | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-native-contacts | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-desktop | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-eliza-tasks | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-gateway | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-llama | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-native-location | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-macosalarm | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-messages | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-mobile-agent-bridge | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-mobile-signals | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-network-policy | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-phone | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-screencapture | native-semantic-plugin | plugin | add-dynamic-view-manifest | yes | yes | yes | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-native-shared-types | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-swabble | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-system | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-talkmode | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | yes | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-native-websiteblocker | native-semantic-plugin | plugin | add-trace-hooks | no | yes | no | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-native-wifi | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-ngrok | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-nostr | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-ollama | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-omnivoice | voice-plugin | voice-pipeline-participant | connect-to-voice-pipeline | no | no | no | medium | Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace. |
| plugin-openai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-openrouter | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-pdf | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-phone | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-polymarket-app | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-registry | dev-tooling | plugin | leave-alone | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-rlm | model-plugin | model-pipeline-participant | connect-to-local-model | no | no | no | medium | Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers. |
| plugin-roblox | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-scape | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-screenshare | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-shell | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
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
| plugin-video | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-vincent | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-vision | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-wallet | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-wallet-ui | app-plugin | app-plugin | add-trace-hooks | no | no | no | medium | Needs owner review before any migration, deletion, or dynamic-view work. |
| plugin-web-search | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-wechat | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-whatsapp | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-wifi | native-semantic-plugin | plugin | route-through-runtime-broker | no | yes | yes | medium | Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Satellite when needed. |
| plugin-workflow | app-plugin | app-plugin | add-dynamic-view-manifest | yes | yes | no | medium | Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard. |
| plugin-x | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-x402 | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-xai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| plugin-xmtp | connector-plugin | connector | add-trace-hooks | no | yes | no | medium | Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful. |
| plugin-zai | provider-plugin | plugin | leave-alone | no | no | no | low | Keep as a provider plugin. Do not move provider routing into Electrobun or a Satellite. |
| repo-root | core-runtime | core | leave-alone | no | no | no | low | Keep as workspace root. Do not use Electrobun convergence to change global repo ownership. |
