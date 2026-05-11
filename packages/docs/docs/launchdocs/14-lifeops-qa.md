# Launch Readiness 14: LifeOps QA

## Second-Pass Status (2026-05-05)

- Superseded: follow-up tracker task-row seeding and Google OAuth callback channel refresh drift are fixed and covered by tests.
- Still open: connected-account flows are mostly mocked or manual, local-only intent sync needs product signoff, and WhatsApp/Twilio/Ntfy/Discord/Signal/Telegram route parity needs deterministic fake-adapter coverage plus periodic live checks.
- Launch gate: `fake-connectors.contract`, follow-up tracker, and Google connector tests cover critical pieces; repair or delete the permanently skipped browser-settings defaults test before counting it as evidence.

## Current state

LifeOps is implemented as a broad app plugin in `plugins/app-lifeops`. The plugin registers LifeOps actions for browser bridge management, calendar/inbox, X, approvals, routines, relationships/followups, Twilio, remote desktop, cross-channel send, intent sync, password/autofill, health, subscriptions, unsubscribe, payments, connector management, and mutations (`plugins/app-lifeops/src/plugin.ts:207`). It also registers providers/services for browser bridge context, blockers, LifeOps context, health, inbox triage, cross-channel context, activity profile, browser bridge service, website blocker service, activity tracking, and presence signal bridging (`plugins/app-lifeops/src/plugin.ts:254`).

The HTTP surface is explicit and large: Google, calendar, Gmail, X, iMessage, Telegram, Signal, Discord, WhatsApp, channel policies, phone consent, reminders, workflows, schedule, permissions, screen time, health, money, smart features, subscriptions, unsubscribe, definitions, goals, and feature toggles are all present in the LifeOps route plugin (`plugins/app-lifeops/src/routes/plugin.ts:153`, `plugins/app-lifeops/src/routes/plugin.ts:297`). Browser companion routes have moved out of LifeOps into `@elizaos/plugin-browser` under `/api/browser-bridge/*` (`plugins/app-lifeops/src/routes/plugin.ts:251`).

The service layer is a mixin facade. Google auth is composed before Calendar/Gmail/Drive, then reminders/browser/workflows/goals, then messaging/social connectors and status surfaces (`plugins/app-lifeops/src/lifeops/service.ts:45`). Persistent state includes connector grants with `side`, `mode`, `executionTarget`, `sourceOfTruth`, `preferredByAgent`, and `cloudConnectionId` (`plugins/app-lifeops/src/lifeops/schema.ts:34`), plus calendar events/sync state, Gmail messages/sync state, inbox messages, local intents, relationships, and follow-ups (`plugins/app-lifeops/src/lifeops/schema.ts:609`, `plugins/app-lifeops/src/lifeops/schema.ts:657`, `plugins/app-lifeops/src/lifeops/schema.ts:691`, `plugins/app-lifeops/src/lifeops/schema.ts:955`, `plugins/app-lifeops/src/lifeops/schema.ts:1004`).

Background scheduling is partly bootstrapped. The proactive worker and LifeOps scheduler worker are both registered and ensured with task rows after runtime init (`plugins/app-lifeops/src/plugin.ts:287`, `plugins/app-lifeops/src/plugin.ts:321`). The follow-up tracker worker is registered, but I did not find a corresponding task-row ensure path (`plugins/app-lifeops/src/plugin.ts:308`).

## Evidence reviewed with file refs

- Plugin wiring: `plugins/app-lifeops/src/plugin.ts:207`, `plugins/app-lifeops/src/plugin.ts:254`, `plugins/app-lifeops/src/plugin.ts:287`, `plugins/app-lifeops/src/plugin.ts:308`, `plugins/app-lifeops/src/plugin.ts:321`.
- Route declarations and handlers: `plugins/app-lifeops/src/routes/plugin.ts:153`, `plugins/app-lifeops/src/routes/plugin.ts:297`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:118`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:170`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:1879`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:1941`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:2005`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:2094`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:2208`, `plugins/app-lifeops/src/routes/lifeops-routes.ts:2306`.
- Service and schema: `plugins/app-lifeops/src/lifeops/service.ts:45`, `plugins/app-lifeops/src/lifeops/schema.ts:34`, `plugins/app-lifeops/src/lifeops/schema.ts:609`, `plugins/app-lifeops/src/lifeops/schema.ts:657`, `plugins/app-lifeops/src/lifeops/schema.ts:691`, `plugins/app-lifeops/src/lifeops/schema.ts:955`, `plugins/app-lifeops/src/lifeops/schema.ts:1040`.
- Google connections: `plugins/app-lifeops/src/lifeops/google-oauth.ts:35`, `plugins/app-lifeops/src/lifeops/google-oauth.ts:150`, `plugins/app-lifeops/src/lifeops/google-oauth.ts:186`, `plugins/app-lifeops/src/lifeops/google-oauth.ts:688`, `plugins/app-lifeops/src/lifeops/google-scopes.ts:22`, `plugins/app-lifeops/src/lifeops/service-mixin-google.ts:618`, `plugins/app-lifeops/src/lifeops/service-mixin-google.ts:1058`, `plugins/app-lifeops/src/lifeops/service-mixin-google.ts:1153`.
- Client/hook mappings: `plugins/app-lifeops/src/api/client-lifeops.ts:1906`, `plugins/app-lifeops/src/api/client-lifeops.ts:2065`, `plugins/app-lifeops/src/api/client-lifeops.ts:2125`, `plugins/app-lifeops/src/api/client-lifeops.ts:2169`, `plugins/app-lifeops/src/api/client-lifeops.ts:2255`, `plugins/app-lifeops/src/api/client-lifeops.ts:2311`, `plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:32`, `plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:428`, `plugins/app-lifeops/src/hooks/useWhatsAppPairing.ts:30`, `packages/app-core/src/api/client-skills.ts:273`, `packages/app-core/src/api/client-skills.ts:1123`.
- Browser setup: `plugins/app-lifeops/src/provider.ts:41`, `plugins/app-lifeops/src/lifeops/service-constants.ts:140`, `plugins/app-lifeops/src/lifeops/service-mixin-core.ts:214`, `plugins/app-lifeops/src/lifeops/service-mixin-core.ts:238`.
- Calendar/email/reminders/followups/notifications: `plugins/app-lifeops/src/lifeops/service-mixin-calendar.ts:201`, `plugins/app-lifeops/src/lifeops/runtime.ts:43`, `plugins/app-lifeops/src/lifeops/scheduler-task.ts:192`, `plugins/app-lifeops/src/followup/followup-tracker.ts:48`, `plugins/app-lifeops/src/followup/followup-tracker.ts:160`, `plugins/app-lifeops/src/followup/followup-tracker.ts:290`, `plugins/app-lifeops/src/lifeops/notifications-push.ts:21`, `plugins/app-lifeops/src/actions/cross-channel-send.ts:1`, `plugins/app-lifeops/src/actions/cross-channel-send.ts:619`.
- Remote sessions: `plugins/app-lifeops/src/actions/remote-desktop.ts:54`, `plugins/app-lifeops/src/remote/remote-session-service.ts:1`, `plugins/app-lifeops/src/remote/remote-session-service.ts:148`, `plugins/app-lifeops/src/remote/tailscale-transport.ts:109`.
- Targeted tests: `plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts:67`, `plugins/app-lifeops/src/components/BrowserBridgeSetupPanel.test.tsx`, `plugins/app-lifeops/test/followup-tracker.test.ts:234`, `plugins/app-lifeops/test/remote-session-service.test.ts:87`, `plugins/app-lifeops/test/notifications-push.integration.test.ts:1`, `plugins/app-lifeops/src/routes/lifeops-routes.test.ts`.

## What I could validate

- Static route/client coverage exists for Google, X, iMessage, Telegram, Signal, Discord, WhatsApp, calendar, Gmail, reminders, channel policies, and status surfaces.
- Non-public LifeOps routes rely on the framework auth check before route execution and then require runtime context before constructing `LifeOpsService` (`plugins/app-lifeops/src/routes/lifeops-routes.ts:118`).
- Sensitive sends and connector writes have dedicated rate-limit buckets, including Gmail send at 2/min and generic outbound messaging at 5/min (`plugins/app-lifeops/src/routes/lifeops-routes.ts:170`).
- Google supports cloud-managed, local loopback, and remote OAuth modes; capabilities map to calendar/Gmail scopes; agent-side Gmail grants are explicitly rejected in favor of the Gmail plugin (`plugins/app-lifeops/src/lifeops/service-mixin-google.ts:1071`).
- Calendar listing aggregates Google grants and supports per-calendar feed inclusion (`plugins/app-lifeops/src/lifeops/service-mixin-calendar.ts:201`).
- Browser context is owner-only and defaults to tracking current tab with browser control disabled; state-changing browser actions are rejected unless control is enabled (`plugins/app-lifeops/src/provider.ts:41`, `plugins/app-lifeops/src/lifeops/service-constants.ts:148`, `plugins/app-lifeops/src/lifeops/service-mixin-core.ts:238`).
- Cross-channel send drafts first and requires a confirmed reinvocation before dispatch; notifications are routed through Ntfy only when `NTFY_BASE_URL` is configured (`plugins/app-lifeops/src/actions/cross-channel-send.ts:1`, `plugins/app-lifeops/src/actions/cross-channel-send.ts:619`).
- Remote sessions require explicit confirmation; non-local mode requires a one-time pairing code; absent data plane returns structured `data-plane-not-configured` instead of pretending the session is usable (`plugins/app-lifeops/src/remote/remote-session-service.ts:148`).
- Targeted bounded test run passed:
  - Command: `bunx vitest run --config plugins/app-lifeops/vitest.config.ts plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts plugins/app-lifeops/src/components/BrowserBridgeSetupPanel.test.tsx plugins/app-lifeops/test/followup-tracker.test.ts plugins/app-lifeops/test/remote-session-service.test.ts plugins/app-lifeops/test/notifications-push.integration.test.ts plugins/app-lifeops/src/routes/lifeops-routes.test.ts`
  - Result: `Test Files 5 passed (5)`, `Tests 84 passed (84)`, duration `86.26s`.

## What I could not validate

- Real connected-account OAuth or pairing flows: Google cloud/local/remote OAuth, X, Telegram login/2FA, Signal pairing, Discord authorization, WhatsApp QR, and iMessage Full Disk Access.
- Real Gmail, Calendar, Drive, X DM, iMessage, Telegram, Signal, Discord, and WhatsApp read/send side effects against connected accounts.
- Real Chrome/Safari Agent Browser Bridge extension install, tab capture, permission prompts, browser-control sessions, or account-affecting confirmation flows.
- Real reminder delivery across in-app, SMS/voice, email, chat, and push notification channels.
- Ntfy live delivery; the live block is intentionally skipped unless `NTFY_BASE_URL` is set and would publish real notifications (`plugins/app-lifeops/test/notifications-push.integration.test.ts:13`).
- Real Twilio SMS/voice delivery and phone-consent workflows.
- Remote desktop data-plane usability over Tailscale or cloud tunnel.
- Multi-device intent replication. The implementation is explicitly a local database queue, not a wire-level replication bridge (`plugins/app-lifeops/src/lifeops/intent-sync.ts:5`).

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- ~~Follow-up tracker is registered but appears not to be scheduled on clean startup.~~ **Resolved 2026-05-09.** `ensureFollowupTrackerTask` is imported and invoked at runtime init alongside the scheduler/proactive ensure paths; verified at `plugins/app-lifeops/src/plugin.ts:42` (import), `:44` (worker registration), `:450` (`registerFollowupTrackerWorker(runtime)`), `:456` (`await ensureFollowupTrackerTask(runtime)`).

### P2

- ~~Google OAuth callback refresh fallbacks use mismatched channel/storage keys.~~ **Resolved 2026-05-09.** The callback HTML now posts to BOTH `elizaos:` and `eliza:` BroadcastChannel + localStorage keys; verified at `plugins/app-lifeops/src/routes/lifeops-routes.ts:802-813` (BroadcastChannel dual-publish) and `:817-820` (localStorage dual-write). The hook continues to listen on the `elizaos:` keys.
- Intent sync wording and behavior are easy to overread as cross-device sync, but the implementation says it is local-only and not wire-replicated (`plugins/app-lifeops/src/lifeops/intent-sync.ts:5`). Scheduler code escalates unacknowledged intents to mobile by writing more local intent records (`plugins/app-lifeops/src/lifeops/runtime.ts:61`). Launch QA should treat remote/mobile intent delivery as unvalidated unless another device-bus layer is present.
- WhatsApp pairing for LifeOps uses the generic app-core WhatsApp routes with `{ authScope: "lifeops", configurePlugin: false }` (`plugins/app-lifeops/src/hooks/useWhatsAppPairing.ts:30`, `packages/app-core/src/api/client-skills.ts:1123`), while LifeOps routes expose only status/send/messages (`plugins/app-lifeops/src/routes/plugin.ts:233`). This can be correct, but launch depends on the generic WhatsApp route/plugin being loaded and preserving LifeOps-vs-platform auth separation.

### P3

- Ntfy push has config/unit coverage but no CI-safe HTTP integration coverage; the live test is skipped in CI and warns not to run against a public broker (`plugins/app-lifeops/test/notifications-push.integration.test.ts:13`).
- Remote session control-plane tests cover pairing and explicit no-data-plane responses, but actual remote usability depends on Tailscale/cloud tunnel configuration (`plugins/app-lifeops/src/remote/remote-session-service.ts:11`, `plugins/app-lifeops/src/remote/tailscale-transport.ts:109`).
- Browser Bridge routes have moved to `@elizaos/plugin-browser`; LifeOps launch must verify that plugin is included wherever `app-lifeops` is enabled, or browser setup UI/actions will be present without their route backend.

## Codex-fixable work

- ~~Add `ensureFollowupTrackerTask(runtime)` mirroring `ensureLifeOpsSchedulerTask` / `ensureProactiveAgentTask`, schedule it after runtime init.~~ **Done 2026-05-09**, see P1 above.
- ~~Share Google connector refresh constants between callback route and hook, or dual-listen for the current `eliza:` and `elizaos:` keys.~~ **Done 2026-05-09**, see P2 above.
- Add a route/client parity test for the LifeOps route table and all `client-lifeops` connector methods, including rate-limit bucket assignment for outbound sends.
- Add an offline Ntfy HTTP-server stub test so notification publishing can be covered without a public broker.
- Add a WhatsApp auth-scope contract test proving LifeOps QR pairing uses `authScope: "lifeops"` and does not mutate platform WhatsApp auth.
- Make intent sync UI/action copy explicitly say local queue unless a real device-bus layer is available; alternatively expose a replication-status probe and gate mobile escalation claims on it.

## Human connected-account QA needed

- Google: connect owner cloud-managed, local, and remote modes; confirm status/accounts, calendar list/feed inclusion, Gmail triage/search/draft/send with a test account, disconnect, and stale-token/reauth behavior.
- Agent/user split: verify owner Google Gmail works and agent-side Gmail grants reject with the documented Gmail-plugin message.
- Messaging: connect and send/read test messages for iMessage, Telegram including 2FA, Signal, Discord, WhatsApp QR, and X DMs. Confirm disconnect/reconnect paths and side-specific owner/agent behavior where supported.
- Browser: install/connect Chrome and Safari companions, verify current tab visibility, remembered tabs, permission status, disabled control rejection, enabled control confirmation, incognito/site-access settings, and account-affecting action confirmation.
- Reminders/followups: process due reminders, acknowledge/snooze/relock, verify escalation timing, channel policy routing, phone consent, Twilio SMS/voice, Ntfy mobile receipt, and follow-up digest/planner behavior after the scheduler fix.
- Remote sessions: issue pairing code, test missing/wrong/valid codes, confirm explicit consent requirement, validate Tailscale/cloud ingress URL, connect from another device, revoke, and verify persistence across restart.
- Mobile/remote intents: verify a real paired mobile device can see, acknowledge, and act on pending intents if launch claims cross-device support.

## Recommended automated coverage

- Recurring-task bootstrap test for proactive, scheduler, and follow-up tracker task rows.
- OAuth callback refresh integration test covering the hook against generated callback HTML.
- Fixture-backed Google OAuth/status tests for cloud/local/remote modes, preferred grant switching, disconnect, and token-missing/needs-reauth states.
- Fake-adapter tests for Telegram, Signal, Discord, iMessage, WhatsApp, and X status/start/send/disconnect flows with owner/agent side assertions.
- Browser Bridge fake companion route tests and UI smoke tests that fail if `@elizaos/plugin-browser` routes are absent.
- Scheduler fake-clock tests for reminder attempts across in-app, push, email, SMS/voice, and chat channels with consent/channel-policy gates.
- Remote-session tests with fake Tailscale/cloud data-plane resolver and UI/action assertions that null ingress is treated as non-usable.
- Local HTTP-server Ntfy integration test.
- Intent-sync test that asserts local-only semantics, plus a separate device-bus contract test if cross-device delivery is expected.

## AI QA Pass 2026-05-11 (static analysis)

**Scope:** Workstream 2 of the AI QA master plan (`23-ai-qa-master-plan.md`). READ-ONLY static analysis of every LifeOps connector + agent-facing integration. Live dev stack is currently down (pre-existing secrets refactor in `packages/core/src/features/index.ts` blocks `bun run build:web`), so OAuth round-trips, real send paths, and live UI rendering are marked `[needs-live-check]`.

**Method:** trace each connector through (1) HTTP route registration in `LIFEOPS_STATIC_ROUTES` / `LIFEOPS_DYNAMIC_ROUTES`, (2) handler body in `lifeops-routes.ts`, (3) UI surface in `MessagingConnectorCards.tsx` / `LifeOpsOperationalPanels.tsx` / `LifeOpsSettingsSection.tsx`, (4) registry contribution in `DEFAULT_CONNECTOR_CONTRIBUTIONS`, (5) auth/credential read site, (6) disconnect path.

### Connector matrix

| Connector | Route | Status shape | UI | Registry | Disconnect | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| gmail (Google) | ✅ multi-route, no `/connectors/gmail` — uses `/api/connectors/google/*` + `/api/lifeops/gmail/*` (`plugins/app-lifeops/src/routes/plugin.ts:497-521`, `lifeops-routes.ts:1115-1525`) | ⚠️ Google status is its own shape (`{connected, mode, side, ...}`) — does NOT match `ConnectorStatus {state, observedAt}` directly; translated by `legacyStatusToConnectorStatus` (`plugins/app-lifeops/src/lifeops/connectors/_helpers.ts:37-56`) | ✅ `useGoogleLifeOpsConnector` consumed in `LifeOpsOverviewSection.tsx:705`, `LifeOpsSettingsSection.tsx:1572-1576`, `LifeOpsSetupGate.tsx:71` | ✅ `createGoogleConnectorContribution` in `DEFAULT_CONNECTOR_CONTRIBUTIONS[0]` (`plugins/app-lifeops/src/lifeops/connectors/default-pack.ts:39`) | ✅ `disconnect` via `service.disconnectGoogleConnector` (`plugins/app-lifeops/src/lifeops/connectors/google.ts:65-70`) + hook `disconnect`/`disconnectAccount` (`plugins/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:844,859`) | OAuth callback HTML dual-publishes BroadcastChannel + localStorage on `elizaos:`/`eliza:` keys (`lifeops-routes.ts:791-820`). Agent-side Gmail explicitly rejected in favor of plugin-gmail (`service-mixin-google.ts:1071`). |
| google-calendar (Google) | ✅ `/api/lifeops/calendar/{feed,calendars,events,next-context}` (`lifeops-routes.ts:1024,1048,1100,1289,1302`) | ⚠️ Calendar endpoints return list/feed payloads, not `ConnectorStatus`; status comes from shared `getGoogleConnectorStatus` | ✅ rendered in `LifeOpsCalendarSection.tsx`, `LifeOpsOverviewSection.tsx` | ✅ same Google contribution covers calendar via capabilities (`google.calendar.read|write`) | ✅ same Google disconnect | Calendar list aggregates Google grants and supports per-calendar feed inclusion (`service-mixin-calendar.ts:201`). |
| telegram | ✅ status/start/submit/cancel/disconnect/verify (`lifeops-routes.ts:1906-2006`, registered `plugin.ts:300-305`) | ⚠️ Returns LifeOps Telegram shape (`{provider, side, state, error, status}`), NOT `ConnectorStatus`. Routes shadow the actual Telegram plugin — `start`/`submit` return "managed by `@elizaos/plugin-telegram`" rather than initiating login (`lifeops-routes.ts:1937,1960`). | ✅ `TelegramConnectorCard` in `MessagingConnectorCards.tsx:1002`, hook `useTelegramConnector.ts:60` | ✅ `createTelegramConnectorContribution` (`default-pack.ts:40`, `telegram.ts:23`) | ✅ POST `/api/lifeops/connectors/telegram/disconnect` (`lifeops-routes.ts:1980`), hook `disconnect` (`useTelegramConnector.ts:262`) | LifeOps cannot itself complete Telegram 2FA — the start/submit endpoints are stubs that defer to `@elizaos/plugin-telegram`. User must configure that plugin separately. `[needs-live-check]` for real 2FA. |
| discord | ✅ status/connect/disconnect/send/verify (`lifeops-routes.ts:2150-2243`, registered `plugin.ts:314-319`) | ⚠️ Returns LifeOps Discord shape with `connected/identity/dmInbox/browserAccess/available/reason/lastError`, NOT `ConnectorStatus`. | ✅ `DiscordConnectorCard` (`MessagingConnectorCards.tsx:671`), hook `useDiscordConnector.ts:16` | ✅ `createDiscordConnectorContribution` (`default-pack.ts:41`, `discord.ts:19`) | ✅ POST `/api/lifeops/connectors/discord/disconnect` (`lifeops-routes.ts:2187`), hook `disconnect` (`useDiscordConnector.ts:122`) | OAuth via `authorizeDiscordConnector`; depends on browser bridge + `plugin-browser` to detect Discord-desktop access. |
| signal | ✅ status/pair/pairing-status/stop/disconnect/messages/send (`lifeops-routes.ts:2012-2144`, registered `plugin.ts:307-313`) | ⚠️ Returns LifeOps Signal shape (`{connected, side, inbound, grantedCapabilities, identity.phoneNumber, ...}`), NOT `ConnectorStatus`. `pair` and `pairing-status` always return `plugin-managed:<side>` sessions deferring to `@elizaos/plugin-signal` — LifeOps does not own QR pairing (`lifeops-routes.ts:2046-2057`). | ✅ `SignalConnectorCard` (`MessagingConnectorCards.tsx:487`), hook `useSignalConnector.ts:82` | ✅ `createSignalConnectorContribution` (`default-pack.ts:42`, `signal.ts:19`) | ✅ POST `/api/lifeops/connectors/signal/disconnect` (`lifeops-routes.ts:2111`), hook `disconnect` (`useSignalConnector.ts:299`) | Signal pairing requires `@elizaos/plugin-signal` configured. macOS host required for native send. `[needs-live-check]` for QR scan. |
| imessage | ✅ status/chats/messages/send (`lifeops-routes.ts:1842-1900`, registered `plugin.ts:294-298`) | ⚠️ Returns LifeOps iMessage shape (`{connected, hostPlatform, bridgeType, sendMode, diagnostics, ...}`), NOT `ConnectorStatus`. | ✅ `IMessageConnectorCard` (`MessagingConnectorCards.tsx:1488`), hook `useIMessageConnector.ts:13` | ✅ `createIMessageConnectorContribution` (`default-pack.ts:43`, `imessage.ts:22`) | ❌ **No disconnect route. No disconnect in UI hook.** Connector contribution `disconnect()` is a no-op (`imessage.ts:32-35`). | iMessage has clean non-macOS state in UI (`MessagingConnectorCards.tsx:1573-1577` covers iOS / non-mac messaging). FDA-revoked state surfaces correctly (`MessagingConnectorCards.tsx:1499-1502`). Disconnect is "delete iCloud account from Messages.app" — outside our control by design. `[needs-live-check]` for FDA prompts on macOS. |
| whatsapp | ✅ status/send/messages (`lifeops-routes.ts:2244-2284`, registered `plugin.ts:320-323`) | ⚠️ Returns LifeOps WhatsApp shape, NOT `ConnectorStatus`. | ✅ `WhatsAppConnectorCard` (`MessagingConnectorCards.tsx:1317`), hook `useWhatsAppConnector.ts:6`, QR overlay `WhatsAppQrOverlay.tsx` | ✅ `createWhatsAppConnectorContribution` (`default-pack.ts:42`, `whatsapp.ts:21`) | ❌ **No disconnect route in `LIFEOPS_STATIC_ROUTES`.** Connector contribution `disconnect()` is a no-op (`whatsapp.ts:31-33`). LifeOps pairing routes are in `app-core` with `authScope:"lifeops"` (`useWhatsAppPairing.ts:30`). | Pairing managed via app-core (`packages/app-core/src/api/client-skills.ts:1123`). `[needs-live-check]` for QR scan + disconnect via app-core. |
| sms-twilio | ❌ **No `/api/lifeops/connectors/twilio/*` routes — not registered in `LIFEOPS_STATIC_ROUTES`.** Twilio is in-process only (env-driven). Outbound reachable via in-process registry only. | ✅ `ConnectorStatus` via `createTwilioConnectorContribution.status` (`twilio.ts:100-113`) — proper `{state, message, observedAt}` | ❌ **No Twilio config / status UI surface.** Only referenced as a *channel label* (e.g. `sms` icon mapping in `LifeOpsRemindersSection.tsx:227`, `LifeOpsOverviewSection.tsx:142`). | ✅ `createTwilioConnectorContribution` (`default-pack.ts:46`, `twilio.ts:84`) | ⚠️ `disconnect()` is a no-op — operator clears env (`twilio.ts:92-95`). No HTTP/UI surface to do so. | Credentials read from `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER` env (`twilio.ts:101`). Missing-config returns `disconnected` cleanly (no crash). |
| x-dm | ✅ status/start/disconnect/upsert + `/x/posts`, `/x/dms/digest`, `/x/dms/curate`, `/x/dms/send` (`lifeops-routes.ts:1696-1836`, registered `plugin.ts:280-293`) | ⚠️ Returns LifeOps X shape (`{connected, identity, ...}`), NOT `ConnectorStatus`. | ✅ `LifeOpsXPanel` (`LifeOpsOperationalPanels.tsx:562`), hook `useLifeOpsXConnector.ts`, gated through `dispatchFocusConnector("x")` and Connectors tab | ✅ `createXConnectorContribution` (`default-pack.ts:45`, `x.ts:19`) | ✅ POST `/api/lifeops/connectors/x/disconnect` (`lifeops-routes.ts:1751`), hook `disconnect` (`useLifeOpsXConnector.ts:116`) | OAuth `success` callback HTML rendered (`lifeops-routes.ts:1708-1730`). Agent-side X DM supported in both modes. |
| calendly | ❌ **No `/api/lifeops/connectors/calendly/*` routes.** In-process only. | ✅ `ConnectorStatus` via `createCalendlyConnectorContribution.status` (`calendly.ts:39-51`) — proper shape, `disconnected` if `readCalendlyCredentialsFromEnv()` null | ❌ **No Calendly UI in app-lifeops/src/components/.** Plugin-calendly owns the full OAuth flow. | ✅ `createCalendlyConnectorContribution` (`default-pack.ts:47`, `calendly.ts:19`) | ⚠️ `disconnect()` is a no-op — owned by `@elizaos/plugin-calendly` (`calendly.ts:33-35`). | Read-only connector (no send). Send is explicit refusal (`calendly.ts:55-62`). |
| duffel | ❌ **No `/api/lifeops/connectors/duffel/*` routes.** Travel-relay path lives at `/api/cloud/travel-providers/:provider/:providerPath*` (`plugin.ts:489-495`). | ✅ `ConnectorStatus` via `createDuffelConnectorContribution.status` (`duffel.ts:48-64`) — proper shape, reports `mode=…` on success or `disconnected` with `DuffelConfigError` | ❌ **No Duffel UI in app-lifeops/src/components/.** Travel relayed through cloud proxy. | ✅ `createDuffelConnectorContribution` (`default-pack.ts:48`, `duffel.ts:21`) | ⚠️ `disconnect()` is a no-op — env-driven (`duffel.ts:35-38`). | Read-only (search/orders). Send is explicit refusal (`duffel.ts:67-74`). |
| apple-health | ❌ **Route validator REJECTS `apple_health`.** `LIFEOPS_HEALTH_CONNECTOR_PROVIDERS = ["strava","fitbit","withings","oura"]` (`plugins/plugin-health/src/contracts/lifeops.ts:325-330`). Validator `parseHealthConnectorProviderPath` returns 400 for `apple_health` (`lifeops-routes.ts:372-375`). | ❌ Apple Health is listed in `HEALTH_CONNECTOR_KINDS` (`plugin-health/src/connectors/index.ts:39-46`) but **not in `LIFEOPS_HEALTH_CONNECTOR_PROVIDERS`** — so route handlers return 400 and UI hook `useLifeOpsHealthConnectors` (`hooks/useLifeOpsHealthConnectors.ts:245`) does not include it. | ❌ Not in `HEALTH_PROVIDER_META` (`LifeOpsSettingsSection.tsx:891-902`) — UI Card cannot render apple_health. | ⚠️ Stub-only — `buildConnectorContribution("apple_health")` from `plugin-health/src/connectors/index.ts:132-187` always returns `state:"disconnected"` with `"plugin-health Wave-1 stub: full dispatcher wiring lands when W1-F's runtime context shape is finalised."` | ⚠️ Stub `disconnect` is no-op (`plugin-health/src/connectors/index.ts:179-181`). | **Severe inconsistency**: stub registry advertises apple_health, but the route/UI/contracts layer only supports the 4 OAuth providers. Local HealthKit CLI path read from `ELIZA_HEALTHKIT_CLI_PATH` (`service-mixin-health.ts:132`) but never wired through the connector flow. |
| google-fit | ❌ **Route validator REJECTS `google_fit`** for same reason as apple_health. | ❌ Same — listed in `HEALTH_CONNECTOR_KINDS` but not `LIFEOPS_HEALTH_CONNECTOR_PROVIDERS`. | ❌ Not in `HEALTH_PROVIDER_META`. | ⚠️ Stub-only (`plugin-health/src/connectors/index.ts:132-187`). | ⚠️ Stub no-op. | Token read from `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` (`service-mixin-health.ts:133`) but never wired through connector. |
| strava | ✅ dynamic `/api/lifeops/connectors/health/:provider/{status,start,callback,success,disconnect}` (`plugin.ts:395-418`) handled at `lifeops-routes.ts:1540-1658` | ⚠️ Returns `LifeOpsHealthConnectorStatus`, NOT `ConnectorStatus`. Internally mapped through `getHealthDataConnectorStatus` (`service-mixin-health.ts:425`). | ✅ `HealthConnectorsCard` (`LifeOpsSettingsSection.tsx:1008`), entry in `HEALTH_PROVIDER_META` (`LifeOpsSettingsSection.tsx:898`) | ⚠️ Two-track: `plugin-health` registers a STUB contribution (`plugin-health/src/connectors/index.ts:132-187`) that returns `disconnected` always; the actual runtime path goes through `service-mixin-health.ts` + `health-oauth.ts` + `health-provider-registry.ts`. The registry contribution is therefore not the source of truth. | ✅ POST `/api/lifeops/connectors/health/strava/disconnect` (`lifeops-routes.ts:1631-1657`) | OAuth URLs in `DEFAULT_HEALTH_PROVIDER_SPECS` (`plugin-health/src/health-bridge/health-provider-registry.ts:93-108`). PKCE off. `[needs-live-check]` for OAuth round-trip. |
| fitbit | ✅ same dynamic-route pattern | ⚠️ same `LifeOpsHealthConnectorStatus` | ✅ entry in `HEALTH_PROVIDER_META` (`LifeOpsSettingsSection.tsx:899`) | ⚠️ same two-track | ✅ same dynamic disconnect | OAuth PKCE on, scopes `["profile","activity","heartrate","sleep","weight"]` (`health-provider-registry.ts:109-129`). |
| withings | ✅ same dynamic-route pattern | ⚠️ same | ✅ entry in `HEALTH_PROVIDER_META` (`LifeOpsSettingsSection.tsx:900`) | ⚠️ same two-track | ✅ same | OAuth uses Withings-specific token-request style; revokeUrl `null` (`health-provider-registry.ts:130-154`). |
| oura | ✅ same dynamic-route pattern | ⚠️ same | ✅ entry in `HEALTH_PROVIDER_META` (`LifeOpsSettingsSection.tsx:901`) | ⚠️ same two-track | ✅ same | OAuth scopes wide: `email/personal/daily/heartrate/workout/spo2` (`health-provider-registry.ts:155-183`). |

**Status-shape footnote.** Wave-1 `ConnectorStatus = {state: "ok"|"degraded"|"disconnected", message?, observedAt}` (`plugins/app-lifeops/src/lifeops/connectors/contract.ts:12-16`) is the contract for the dispatch-policy layer. The HTTP route handlers above return the legacy per-connector shapes that pre-date the contract; translation happens via `legacyStatusToConnectorStatus` inside the `ConnectorContribution.status()` body, not at the route layer. Both shapes are real and the UI consumes the legacy shape directly, but a planner/dispatch consumer that calls `connectorRegistry.get(kind).status()` gets the unified contract.

### Known-gap connectors (verified unregistered)

- **bluesky** — `@elizaos/plugin-bluesky` exists with `connector-account-provider.ts` and is published as a plugin, but is **NOT** registered in `DEFAULT_CONNECTOR_CONTRIBUTIONS` (`default-pack.ts:38-49`). No `/api/lifeops/connectors/bluesky/*` routes, no UI card, no LifeOps hook. Plugin is reachable only through its own service surface.
- **slack** — `@elizaos/plugin-slack/src/` exists (accounts/connector-account-provider) but **not** registered in LifeOps connector pack. Only a mockoon-port placeholder (`mockoon-redirect.ts:26`). No `/api/lifeops/connectors/slack/*`. No UI card.
- **github** — `@elizaos/plugin-github/src/` has its own routes + connector-account-provider but **not** registered in LifeOps connector pack. Status surfaces in `LifeOpsSettingsSection.tsx:405,1586,1598` reference a GitHub linked-account *status string*, not a connector. No LifeOps GitHub send/read path. Mockoon-port only (`mockoon-redirect.ts:29`).
- **notion** — Mockoon port reserved (`mockoon-redirect.ts:30`) but no LifeOps connector, no UI, no route handler. No `plugins/plugin-notion/`.
- **obsidian** — No `plugins/plugin-obsidian/`. No LifeOps connector. No UI.
- **spotify** — Mockoon port reserved (`mockoon-redirect.ts:40`). No `plugins/plugin-spotify/`. No LifeOps connector. No UI.
- **things** — No `plugins/plugin-things/`. No LifeOps connector. No UI.
- **apple-notes** — No `plugins/plugin-apple-notes/`. No LifeOps connector. No UI.
- **apple-reminders** — Mockoon port reserved (`mockoon-redirect.ts:33`). No `plugins/plugin-apple-reminders/` plugin source. No LifeOps connector. No UI.

### Findings

#### P0

- **P0-1 (apple_health/google_fit dead route)** — `HEALTH_CONNECTOR_KINDS` advertises `apple_health` and `google_fit` (`plugins/plugin-health/src/connectors/index.ts:39-46`) but `LIFEOPS_HEALTH_CONNECTOR_PROVIDERS` (`plugins/plugin-health/src/contracts/lifeops.ts:325-330`) only includes the 4 OAuth providers. As a result:
  - The route validator (`plugins/app-lifeops/src/routes/lifeops-routes.ts:367-376`) returns HTTP 400 for `apple_health` / `google_fit` calls.
  - The Settings UI map `HEALTH_PROVIDER_META` (`plugins/app-lifeops/src/components/LifeOpsSettingsSection.tsx:891-902`) does not include them.
  - `service-mixin-health.ts:130-135` reads `ELIZA_HEALTHKIT_CLI_PATH` and `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` from env but those configs cannot reach a status endpoint or a UI control.

  If a user has Apple Health on macOS / iOS or Google Fit configured, there is no way to surface that in LifeOps — and the agent-side Wave-1 stub (`plugins/plugin-health/src/connectors/index.ts:132-187`) hard-codes `state:"disconnected"` for both. P0 because the master plan lists Apple Health and Google Fit as user-facing connectors that ship.

- **P0-2 (Calendly/Duffel/Twilio have no UI surface)** — All three are registered in the connector registry (`default-pack.ts:46-48`) but the HTTP route table has no `/api/lifeops/connectors/{twilio,calendly,duffel}/*`. The components directory has no Twilio/Calendly/Duffel cards (verified via grep over `plugins/app-lifeops/src/components/*.tsx`). The only mention of `sms` in components is a *channel label* in reminder/inbox UI (`LifeOpsRemindersSection.tsx:227`, `LifeOpsInboxSection.tsx:116`). A user cannot:
  - See whether Twilio credentials are configured (despite `twilio.ts:100-113` having a clean status).
  - See whether Calendly OAuth is connected (despite `calendly.ts:39-51`).
  - See whether Duffel mode is `live`/`test` (despite `duffel.ts:48-64`).
  - Disconnect any of the three (all three `disconnect()` are no-ops).
  This violates Clean Arch Commandment #10 (every endpoint needs a client trigger) and breaks the master plan task "confirm UI surfaces the status (connected / disconnected / error)".

#### P1

- **P1-1 (WhatsApp + iMessage have no disconnect surface)** —
  - `lifeops-routes.ts` has no DELETE/POST disconnect route for `whatsapp` or `imessage`.
  - The connector contributions `whatsapp.ts:31-33` and `imessage.ts:32-35` both have no-op `disconnect()`.
  - The UI hooks `useWhatsAppConnector.ts` and `useIMessageConnector.ts` expose no `disconnect`.
  - For WhatsApp this is partly intentional — app-core owns pairing (`useWhatsAppPairing.ts:30`) — but the LifeOps UI then needs to surface "Disconnect via [Settings link]". For iMessage it's "disconnect via macOS Messages.app", which is correct behavior but undocumented in the UI.

  Without a disconnect path, a user who connects WhatsApp via LifeOps cannot revoke that grant from inside LifeOps; the agent retains send capability until app-core revokes pairing.

- **P1-2 (Telegram/Signal start endpoints are placebos)** — `lifeops-routes.ts:1937` and `lifeops-routes.ts:2056` always return `"Telegram setup is managed by @elizaos/plugin-telegram. Configure the Telegram connector plugin, then check status again."` / similar for Signal — i.e. the LifeOps `start` button does nothing actionable in itself. The user has to leave LifeOps, configure the platform plugin in onboarding/settings, and come back. The UI hooks (`useTelegramConnector.ts`, `useSignalConnector.ts`) consume these endpoints, so clicking "Start" yields a no-op message. The current copy is honest but the UX is broken — the user gets no link to the plugin settings.

- **P1-3 (`apple_health`/`google_fit` registry stubs lie about state)** — The Wave-1 stub `buildConnectorContribution` (`plugins/plugin-health/src/connectors/index.ts:132-187`) returns `state:"disconnected"` for every health kind regardless of whether the real OAuth grant exists. This means any planner that consults `connectorRegistry.byCapability("health.sleep.read")` will see all 6 health connectors as `disconnected` even when (e.g.) Oura has a live grant. The real status lives in `service-mixin-health.ts` and only the LifeOps HTTP route surface sees it. P1 because it silently breaks dispatch-policy decisions for health bus families.

- **P1-4 (Plugin-managed connectors leak past `connector_write` rate-limit)** — Telegram `disconnect` (`lifeops-routes.ts:1980`) and Signal `disconnect` (`lifeops-routes.ts:2111`) call through the `LifeOpsService` (`service.disconnectTelegram`/`service.disconnectSignal`), but `start`/`submit` for both Telegram (`lifeops-routes.ts:1928,1950`) and Signal (`lifeops-routes.ts:2046`) skip the `oauth_init` rate limit's effective check by replacing the real start with a stub status read. If a user spams the Start button, only the rate-limit counter increments — the action does nothing. Easy to overlook in QA.

#### P2

- **P2-1 (Status shapes diverge from contract)** — Every messaging route (`telegram/discord/signal/imessage/whatsapp/x` `/status`) returns the legacy LifeOps shape, not `ConnectorStatus`. The unified contract only takes effect inside `ConnectorContribution.status()` for in-process consumers. A future planner that calls the registry sees `{state, observedAt}`; a UI hook that calls the HTTP route sees the per-connector shape. Two contracts, two consumers — the wave1 audit (`docs/audit/wave1-interfaces.md`) flagged this as the agreed bridge but it remains a long-term maintenance risk.

- **P2-2 (Google connector `disconnect` always uses `{side: "owner", mode: "local"}`)** — `connectors/google.ts:65-70` hardcodes the disconnect args. If the user has both owner-local and agent-cloud grants, calling `connectorRegistry.get("google").disconnect()` only drops the owner-local one. The HTTP route has full-shape disconnect (`/api/connectors/google/accounts/:accountId`), so the UI is fine, but the registry contribution is incomplete.

- **P2-3 (LifeOps Discord registry hardcodes owner)** — `connectors/discord.ts:30-34` hardcodes `side: "owner"` for disconnect and `status`. Same issue as P2-2: the registry contribution cannot represent agent-side state.

- **P2-4 (X DM mode hardcoded to local)** — `connectors/x.ts:33,38,55` always passes `side: "owner"` and never the requested mode. Plugin-X side/mode handling at the route level (`lifeops-routes.ts:1700-1771`) is fine; only the registry contribution is narrow.

- **P2-5 (Calendly `read` swallows missing creds silently)** — `connectors/calendly.ts:64-68` returns `[]` when `readCalendlyCredentialsFromEnv()` is null. That collapses "no events" and "not configured" into the same UI signal. Better to throw a 503-like result so the dispatch policy can mark `userActionable: true`.

#### P3

- **P3-1 (No mockoon coverage for Calendly)** — Calendly is not in `mockoon-redirect.ts:23-42`. Tests against Calendly require live creds, which the test lane never has. Minor since Calendly is read-only.
- **P3-2 (`x/posts` and `x/dms/*` use `outbound_message` bucket but `x/dms/curate` uses `default`)** — `lifeops-routes.ts:1776,1803,1819`. A user who spam-curates DMs (`markRead`, `markReplied`) can exhaust the default bucket without exceeding any messaging limit. Probably intentional but worth checking against the rate-limit doc.
- **P3-3 (Empty `BLUESKY/SLACK/etc.` registry slots)** — The mockoon redirect file (`plugins/app-lifeops/src/lifeops/connectors/mockoon-redirect.ts:17-21`) lists slack/discord/github/notion/bluebubbles/apple-reminders/spotify as having "no env-var override" — strongly suggests an intended future expansion that hasn't landed. Document that gap explicitly so it doesn't read as an oversight.

### Agent-facing integrations

- **LLM providers (Anthropic / OpenAI / Cerebras / Groq / OpenRouter)** — Provider switch lives in `packages/agent/src/api/provider-switch-config.ts`. Default model names defined for anthropic/openai/google/groq (`provider-switch-config.ts:400-428`). Anthropic large default is `claude-opus-4-7` (matches CLAUDE.md). OpenAI large default is `gpt-5.5`. Recognized signal providers at `provider-switch-config.ts:644-659`: `anthropic, anthropic-subscription, deepseek, gemini, grok, groq, mistral, moonshot, ollama, openai, openai-subscription, openrouter, together, zai`. Cerebras is reachable through the OpenAI-compatible endpoint (no separate provider entry in this map — it speaks the OpenAI completions surface, see mockoon `cerebras` port). ✅ Configurable.

- **Embedding provider** — Not separately routed in LifeOps. The embedding model selection is part of the LLM persistence plan in `provider-switch-config.ts` (look for `nanoModel`/`smallModel` keys), but no LifeOps connector specifically exposes embeddings. `[needs-live-check]` for whether the runtime correctly falls back when a provider has no embedding endpoint.

- **Vector store** — No LifeOps-side vector-store connector. Memory/embedding is handled by core (`@elizaos/core`) via the database layer. `[needs-live-check]` for path resolution.

- **Vault for OAuth tokens** — `packages/vault/src/` is real and exports `createVault`, `VaultMissError`, `PgliteVaultImpl`, master-key resolvers, `encrypt/decrypt`. Sensitive entries encrypt at rest with the OS keychain master key (`packages/vault/src/index.ts:1-50`). The connector grants table (`plugins/app-lifeops/src/lifeops/schema.ts:34`) stores `tokenRef` references that resolve through the vault, not raw tokens. ✅ Real.

- **Database** — `@elizaos/plugin-sql` + `drizzle-orm` (`plugins/app-lifeops/package.json:67`). LifeOps schema in `plugins/app-lifeops/src/lifeops/schema.ts` (1000+ lines: connector_grants, calendar_events, gmail_messages, inbox_messages, local_intents, relationships, follow_ups, sleep episodes, …). ✅ Real.

- **Activity signal bus** — `plugins/app-lifeops/src/lifeops/signals/bus.ts:1-40`. Pub/sub for `LifeOpsBusFamily` events (calendar watcher, plugin-health emitter, time-window emitter, manual-override gateway). 24h sliding window per family, no persistence (separate from `LifeOpsRepository.insertTelemetryEvent`). ✅ Real.

### Verification status

- `bun run --cwd plugins/app-lifeops test` — **not run** in this pass. Pre-existing P0 secrets-refactor blocks the full live stack; module-level vitest is still runnable but skipped here per scope (READ-ONLY static analysis only).
- All `file:line` citations verified by `Read`/`Grep` on the develop branch at commit `8cf8ad0ac3`.

### Summary

**Severity totals:** P0=2, P1=4, P2=5, P3=3 (14 findings). **Top-3 connectors most at risk of user-visible failure:**
1. **apple-health** — `plugins/plugin-health/src/contracts/lifeops.ts:325-330` (provider list excludes it), `plugins/app-lifeops/src/components/LifeOpsSettingsSection.tsx:891-902` (no UI entry), `plugins/plugin-health/src/connectors/index.ts:132-187` (stub returns disconnected). A user on macOS/iOS with Apple Health configured cannot see or use the connector despite env vars being read.
2. **google-fit** — Same pattern as apple-health. `ELIZA_GOOGLE_FIT_ACCESS_TOKEN` is read at `plugins/app-lifeops/src/lifeops/service-mixin-health.ts:133` but never reaches a route or UI.
3. **sms-twilio** — `plugins/app-lifeops/src/lifeops/connectors/twilio.ts:84` is registered but no UI exists (`grep -rE "twilio|Twilio" plugins/app-lifeops/src/components/*.tsx` matches only `sms` channel-label glyphs). A user who sets `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER` cannot confirm LifeOps sees those credentials, and reminder-channel routing through `sms` will silently fail when env is absent.

Honourable mention: **calendly** and **duffel** are functionally equivalent to twilio (registered, no UI, no HTTP route) but read-only, so failure is less visible.

## Changed paths

- `launchdocs/14-lifeops-qa.md`
