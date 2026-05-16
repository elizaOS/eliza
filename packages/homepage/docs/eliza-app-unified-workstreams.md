# Eliza App Unified Workstreams

## Scope

This spec defines the implementation workstreams needed to make Eliza App feel
like one product across desktop downloads, mobile installs, social-message
onboarding, personal-agent provisioning, and release verification.

The product contract is one durable agent per user. Channel-specific onboarding
may start in iMessage, Discord, Telegram, WhatsApp, the homepage, or a native
app, but successful setup must converge on the same user account, same agent,
same runtime target, and same handoff semantics.

## Codebase Anchors

- Homepage distribution surface:
  `packages/homepage/src/pages/marketing.tsx`,
  `packages/homepage/src/generated/release-data.ts`,
  `packages/homepage/README.md`,
  `packages/homepage/tests/e2e/marketing-cloud-download.spec.ts`.
- Release metadata generation:
  `packages/app-core/scripts/write-homepage-release-data.mjs`,
  `packages/app-core/scripts/run-release-contract-suite.mjs`,
  `packages/app-core/platforms/electrobun/scripts/verify-windows-installer-proof.ps1`,
  `packages/app-core/platforms/electrobun/scripts/stage-macos-release-artifacts.sh`.
- Mobile runtime and sideload behavior:
  `packages/ui/src/onboarding/mobile-runtime-mode.ts`,
  `packages/ui/src/state/agent-runtime-target.ts`,
  `packages/app/src/mobile-bridges.ts`,
  `packages/app/scripts/mobile-local-chat-smoke.mjs`,
  `packages/app/scripts/ensure-capacitor-platform.mjs`.
- Provisioning and one-agent handoff:
  `packages/homepage/src/lib/hooks/use-eliza-app-provisioning-chat.ts`,
  `packages/cloud-api/eliza-app/provisioning-agent/route.ts`,
  `packages/cloud-api/eliza-app/provisioning-agent/chat/route.ts`,
  `packages/cloud-api/eliza-app/provision-agent/route.ts`,
  `packages/cloud-api/v1/eliza/agents/[agentId]/provision/route.ts`.
- Messaging gateways:
  `plugins/plugin-bluebubbles/src/service.ts`,
  `plugins/plugin-bluebubbles/src/setup-routes.ts`,
  `plugins/plugin-bluebubbles/src/data-routes.ts`,
  `packages/ui/src/components/connectors/BlueBubblesStatusPanel.tsx`,
  `packages/ui/src/components/connectors/IMessageStatusPanel.tsx`,
  `packages/ui/src/components/connectors/DiscordLocalConnectorPanel.tsx`,
  `packages/ui/src/components/connectors/TelegramBotSetupPanel.tsx`,
  `packages/ui/src/components/connectors/TelegramAccountConnectorPanel.tsx`,
  `packages/ui/src/components/connectors/WhatsAppQrOverlay.tsx`,
  `packages/cloud-api/eliza-app/webhook/_forward.ts`,
  `packages/cloud-api/eliza-app/webhook/discord/route.ts`,
  `packages/cloud-api/eliza-app/webhook/telegram/route.ts`,
  `packages/cloud-api/eliza-app/webhook/whatsapp/route.ts`,
  `packages/cloud-services/gateway-discord/src/index.ts`,
  `packages/cloud-services/gateway-webhook/src/webhook-handler.ts`.

## Workstream 1: Downloads And App Stores

Homepage downloads remain the canonical public install surface until each store
path is approved. The page must render GitHub release assets from generated
metadata, fall back only when metadata is unavailable, and keep store badges in
a status-driven "coming soon", "beta", or "available" state.

Implementation requirements:

- Extend the generated release payload consumed by
  `packages/homepage/src/pages/marketing.tsx` rather than hard-coding new
  release URLs in page components.
- Represent store targets as data with platform, status, URL, review state,
  rollout channel, and fallback artifact.
- Keep direct downloads for macOS, Windows, and Linux mapped to release assets
  produced by `packages/app-core/scripts/write-homepage-release-data.mjs`.
- Add iOS TestFlight/App Store and Android Play Store/APK states without making
  a store badge clickable until a valid URL and review state exist.
- Preserve static hosting constraints from `packages/homepage/README.md`.

Acceptance criteria:

- `/` renders current desktop artifact links from
  `releaseData.release.downloads` when release metadata is present.
- Store entries never point to placeholder URLs.
- Missing release metadata degrades to the existing GitHub latest-download
  fallback and visibly avoids claiming a fresh release.
- `bun run --cwd packages/homepage typecheck` and
  `bun run --cwd packages/homepage test:e2e` pass for the download surface.

## Workstream 2: iOS Sideload Installer

iOS sideload is a power-user bridge until TestFlight/App Store distribution is
approved. It must install or update the native app, preserve the selected mobile
runtime mode, and support local, cloud, cloud-hybrid, and tunnel-to-mobile
targets already modeled in `packages/ui/src/onboarding/mobile-runtime-mode.ts`.

Implementation requirements:

- Build the sideload installer around Capacitor artifacts produced through
  `packages/app/scripts/ensure-capacitor-platform.mjs` and app build scripts,
  not a separate mobile app.
- Use `MOBILE_RUNTIME_MODE_STORAGE_KEY` as the shared persisted mode contract.
- For local iOS, route WebView requests through `IOS_LOCAL_AGENT_IPC_BASE` and
  the Bun/ITTP bridge described in `packages/app/src/mobile-bridges.ts`.
- The sideload install page must explain signing profile, device trust, update,
  and rollback state without reusing App Store language.
- The installer must emit a verifiable installed-version and runtime-target
  signal that can be consumed by the release center and smoke scripts.

Acceptance criteria:

- Fresh sideload install can select cloud and local runtime modes and persists
  the selection across app restart.
- Updating a sideload build does not erase account, runtime mode, or local-agent
  credentials.
- `node packages/app/scripts/mobile-local-chat-smoke.mjs --platform ios
  --ios-select-local --ios-full-bun-smoke --require-installed` passes on the
  supported simulator/device lane.
- Failed signing, missing device trust, and stale build cases produce explicit
  user-facing recovery states.

## Workstream 3: iMessage Gateway Via BlueBubbles And Headscale

iMessage onboarding is an advanced self-hosted gateway: a Mac host runs
BlueBubbles, a spare iPhone supplies iMessage continuity, and Headscale provides
private network reachability. Product copy must call this "iMessage gateway",
while implementation uses the existing BlueBubbles plugin.

Implementation requirements:

- Use `plugins/plugin-bluebubbles` as the only iMessage transport integration.
- Add Headscale configuration as deployment/runtime infrastructure around the
  BlueBubbles server URL and webhook URL; do not fork BlueBubbles behavior.
- Gateway setup must flow through the existing setup/data route model in
  `plugins/plugin-bluebubbles/src/setup-routes.ts` and
  `plugins/plugin-bluebubbles/src/data-routes.ts`.
- Account ownership must stay explicit: BlueBubbles credentials represent the
  user's Mac/iMessage bridge and should use the connector-account provider in
  `plugins/plugin-bluebubbles/src/connector-account-provider.ts`.
- Incoming iMessage events must enter the same provisioning and handoff path as
  Discord, Telegram, and WhatsApp.

Acceptance criteria:

- Gateway health reports BlueBubbles reachability, webhook URL, Headscale node
  identity, and last inbound/outbound message timestamp.
- A new iMessage user can complete onboarding and is handed to the user's agent,
  not left attached to a gateway bootstrap agent.
- Loss of Headscale or BlueBubbles connectivity marks the channel degraded
  without disabling the user's other channels.
- Existing BlueBubbles tests and setup-route contract tests continue to pass.

## Workstream 4: Discord, Telegram, And WhatsApp Bot Onboarding

Bot onboarding must be channel-specific at the edge and channel-neutral after
identity is linked. Discord uses the Discord gateway service, Telegram and
WhatsApp use the webhook gateway, and all three forward into the same Eliza App
provisioning contract.

Implementation requirements:

- Homepage entry points in `packages/homepage/src/pages/get-started.tsx` should
  keep using environment-driven bot identifiers documented in
  `packages/homepage/README.md`.
- Cloud API webhook routes under `packages/cloud-api/eliza-app/webhook/` remain
  thin forwarders to gateway services; channel logic belongs in
  `packages/cloud-services/gateway-discord` or
  `packages/cloud-services/gateway-webhook`.
- Account linking must route through existing auth/connection endpoints under
  `packages/cloud-api/eliza-app/auth/` and
  `packages/cloud-api/eliza-app/connections/`.
- Telegram bot and Telegram account setup remain separate UI concepts:
  `TelegramBotSetupPanel.tsx` for bot onboarding and
  `TelegramAccountConnectorPanel.tsx` for user account linking.
- WhatsApp onboarding must distinguish official Business Platform opt-in from
  QR/session style local connector setup in `WhatsAppQrOverlay.tsx`.

Acceptance criteria:

- Discord invite, Telegram start, and WhatsApp opt-in each create or recover the
  same authenticated Eliza App user when the same verified identity is used.
- OAuth/callback state validates origin, nonce/state, and platform before
  account linking completes.
- Webhook retries are idempotent: duplicate platform events do not create extra
  agents or duplicate onboarding sessions.
- Gateway service tests pass:
  `bun test packages/cloud-services/gateway-discord/tests` and
  `bun test packages/cloud-services/gateway-webhook/__tests__`.

## Workstream 5: One-Agent-Per-User Handoff

The provisioning agent is temporary. It may answer setup questions and collect
preferences, but it must hand the thread to the user's real agent once the agent
is running.

Implementation requirements:

- Treat `packages/homepage/src/lib/hooks/use-eliza-app-provisioning-chat.ts` as
  the browser-side handoff contract: `agentId`, `bridgeUrl`, and
  `containerStatus` must be enough to transition from setup to real chat.
- Replace demo-only in-memory agent provisioning in
  `packages/cloud-api/eliza-app/provision-agent/route.ts` with persistent
  account-bound provisioning before production launch.
- Enforce one active personal agent per user at the provisioning boundary.
  Additional channel connections attach to that agent.
- Preserve channel transcript continuity by recording source platform, platform
  user ID, setup session ID, and target agent ID.
- Sub-agents may exist internally, but onboarding and channel setup should not
  ask the user to choose between multiple agents.

Acceptance criteria:

- Re-running onboarding for an existing user returns the existing agent ID or an
  explicit recovery state, not a second personal agent.
- A completed setup conversation has an auditable handoff record from
  provisioning session to user agent.
- After handoff, inbound messages from every connected channel route to the
  user's agent runtime target inferred by
  `packages/ui/src/state/agent-runtime-target.ts`.
- Provisioning route tests cover new user, existing user, duplicate webhook, and
  failed runtime-start recovery.

## Workstream 6: Release Pipeline

Release readiness is a product surface and a CI contract. Homepage metadata,
desktop artifacts, mobile sideload builds, store-review state, gateway deploys,
and smoke tests must advance together.

Implementation requirements:

- Keep release metadata generation in
  `packages/app-core/scripts/write-homepage-release-data.mjs`.
- Extend release contracts in
  `packages/app-core/scripts/run-release-contract-suite.mjs` when adding new
  artifact types or store metadata.
- Desktop release status remains visible in the app release center under
  `packages/ui/src/components/release-center/`.
- Mobile release lanes must publish build number, runtime modes supported,
  sideload URL, store review status, and rollback URL.
- Gateway releases must include image tag, environment, webhook base URL,
  Discord gateway URL, and health-check URL.

Acceptance criteria:

- A release candidate cannot be marked ready unless homepage metadata,
  desktop artifacts, mobile sideload artifacts, and gateway deploy metadata are
  internally consistent.
- `node packages/app-core/scripts/run-release-contract-suite.mjs` passes before
  public release.
- Homepage build uses freshly generated release data:
  `bun run --cwd packages/homepage build`.
- Rollback instructions exist for desktop, iOS sideload, Android APK, and
  gateway services.

## Workstream 7: Verification Gates

Verification gates should prove user journeys, not only units. Each gate maps
to a failure mode users would otherwise experience during install, onboarding,
handoff, messaging, or update.

Required gates:

- Homepage download gate: Playwright verifies primary downloads, store states,
  no placeholder links, and generated release labels.
- iOS sideload gate: install/update smoke verifies runtime selection,
  persisted mode, background runner configuration, and a local chat turn where
  supported.
- Android APK gate: install/update smoke verifies local agent token, runtime
  target, staged smoke model, and background health.
- Gateway gate: Discord, Telegram, WhatsApp, and iMessage webhooks each verify
  signature/auth handling, idempotency, forwarding, and user-agent routing.
- Handoff gate: provisioning chat verifies temporary session creation, user
  agent readiness, thread transfer, and duplicate-onboarding recovery.
- Release gate: release contract suite verifies artifacts, checksums, static
  asset metadata, CDN paths, and homepage release-data generation.

Acceptance criteria:

- Every workstream above has at least one automated gate and one manual release
  checklist item.
- Gates fail closed: missing secrets, missing webhook URLs, unavailable release
  metadata, or unapproved store links block release instead of silently falling
  back to production claims.
- Test output names the broken platform/channel and the recovery owner.
- Manual release notes include artifact versions, gateway versions, store
  review state, and known degraded channels.

## Non-Goals

- Do not introduce a second personal-agent concept for channel bootstrap.
- Do not build a parallel iMessage transport outside `plugin-bluebubbles`.
- Do not put channel-specific business logic into homepage components.
- Do not claim App Store, Play Store, Mac App Store, or Microsoft Store
  availability before approved URLs exist.
- Do not bypass existing mobile runtime-target and onboarding-mode contracts.
