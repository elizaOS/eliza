# Eliza Capability Map

Eliza capabilities come from the running elizaOS runtime plus this app's product services and Cloud integrations. A worker should reason in terms of loaded capabilities, not hardcoded assumptions.

## Runtime Capabilities

The parent Eliza runtime can expose:

- actions for tool-like operations and side effects
- providers for contextual state and prompt composition
- services for long-lived clients, caches, schedulers, connectors, and background work
- evaluators for post-response extraction and policy checks
- model handlers for text, embeddings, images, media, and provider routing
- plugin routes for HTTP surfaces owned by plugins
- persistent memory and knowledge stores

Use `USE_SKILL parent-agent {"mode":"list-actions"}` to inspect registered actions from a worker session.

## App Capabilities

This app adds local-first product behavior around elizaOS:

- CLI and desktop app startup
- dashboard and Electrobun shell
- onboarding, config, provider routing, and linked accounts
- runtime mode selection across local, remote, and Cloud targets
- local API routes for agent state, billing proxies, media, voice, and workspace features
- disk-backed skills that can be copied into a workspace store and edited

Use the `eliza-app-development` skill for repo layout and app-specific edit targets.

## Cloud Capabilities

Eliza Cloud can provide:

- app registration, API keys, app auth, redirect validation, and app users
- EVM wallet/SIWE sign-in for API-key bootstrap
- chat/messages/inference APIs for app-scoped user calls
- credits, billing summary, checkout/top-up flows, and payment methods
- app analytics, usage, earnings, and monetization settings
- container deployments, logs, health checks, and domains
- creator earnings, purchase-share flows, affiliate flows, app charge links,
  x402 payment requests, and hosting billing
- promotion assets, social/SEO/ad promotion, image generation, video
  generation, music generation, and TTS generation

Use `eliza-cloud` for the general Cloud API surface and `build-monetized-app` for new earn-from-inference or paid-action app builds.

## LifeOps And Health

LifeOps uses one task primitive: `ScheduledTask`. Reminders, check-ins, follow-ups, watchers, recaps, approvals, and outputs all route through the ScheduledTask runner. Health contributes through registries and default packs; LifeOps should not import health plugin internals.

For task-agent work tied to LifeOps, use `USE_SKILL lifeops-context ...` only when listed in `SKILLS.md`.

## External Connectors

Depending on the parent runtime's loaded plugins and account links, the parent may have access to:

- GitHub repositories, issues, PRs, CI, and code review context
- calendars, email, browser automation, and workspace/search connectors
- model providers, inference gateways, media, TTS, and embedding providers
- MCP servers or plugin-defined APIs

Workers should ask the parent for these via `parent-agent` instead of trying to recreate credentials or account state.

## Safety Boundary

Local code edits, tests, formatting, and repo inspection belong to the worker. Private account data, provider tokens, wallet private keys, payment signatures, paid operations, destructive external changes, and app/user account state belong to the parent runtime and its confirmation flow.
