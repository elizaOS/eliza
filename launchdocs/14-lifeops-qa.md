# TODO 14 QA LifeOps

## Current state

LifeOps is implemented as a broad app plugin in `apps/app-lifeops`. The plugin registers LifeOps actions for browser bridge management, calendar/inbox, X, approvals, routines, relationships/followups, Twilio, remote desktop, cross-channel send, intent sync, password/autofill, health, subscriptions, unsubscribe, payments, connector management, and mutations (`apps/app-lifeops/src/plugin.ts:207`). It also registers providers/services for browser bridge context, blockers, LifeOps context, health, inbox triage, cross-channel context, activity profile, browser bridge service, website blocker service, activity tracking, and presence signal bridging (`apps/app-lifeops/src/plugin.ts:254`).

The HTTP surface is explicit and large: Google, calendar, Gmail, X, iMessage, Telegram, Signal, Discord, WhatsApp, channel policies, phone consent, reminders, workflows, schedule, permissions, screen time, health, money, smart features, subscriptions, unsubscribe, definitions, goals, and feature toggles are all present in the LifeOps route plugin (`apps/app-lifeops/src/routes/plugin.ts:153`, `apps/app-lifeops/src/routes/plugin.ts:297`). Browser companion routes have moved out of LifeOps into `@elizaos/plugin-browser-bridge` under `/api/browser-bridge/*` (`apps/app-lifeops/src/routes/plugin.ts:251`).

The service layer is a mixin facade. Google auth is composed before Calendar/Gmail/Drive, then reminders/browser/workflows/goals, then messaging/social connectors and status surfaces (`apps/app-lifeops/src/lifeops/service.ts:45`). Persistent state includes connector grants with `side`, `mode`, `executionTarget`, `sourceOfTruth`, `preferredByAgent`, and `cloudConnectionId` (`apps/app-lifeops/src/lifeops/schema.ts:34`), plus calendar events/sync state, Gmail messages/sync state, inbox messages, local intents, relationships, and follow-ups (`apps/app-lifeops/src/lifeops/schema.ts:609`, `apps/app-lifeops/src/lifeops/schema.ts:657`, `apps/app-lifeops/src/lifeops/schema.ts:691`, `apps/app-lifeops/src/lifeops/schema.ts:955`, `apps/app-lifeops/src/lifeops/schema.ts:1004`).

Background scheduling is partly bootstrapped. The proactive worker and LifeOps scheduler worker are both registered and ensured with task rows after runtime init (`apps/app-lifeops/src/plugin.ts:287`, `apps/app-lifeops/src/plugin.ts:321`). The follow-up tracker worker is registered, but I did not find a corresponding task-row ensure path (`apps/app-lifeops/src/plugin.ts:308`).

## Evidence reviewed with file refs

- Plugin wiring: `apps/app-lifeops/src/plugin.ts:207`, `apps/app-lifeops/src/plugin.ts:254`, `apps/app-lifeops/src/plugin.ts:287`, `apps/app-lifeops/src/plugin.ts:308`, `apps/app-lifeops/src/plugin.ts:321`.
- Route declarations and handlers: `apps/app-lifeops/src/routes/plugin.ts:153`, `apps/app-lifeops/src/routes/plugin.ts:297`, `apps/app-lifeops/src/routes/lifeops-routes.ts:118`, `apps/app-lifeops/src/routes/lifeops-routes.ts:170`, `apps/app-lifeops/src/routes/lifeops-routes.ts:1879`, `apps/app-lifeops/src/routes/lifeops-routes.ts:1941`, `apps/app-lifeops/src/routes/lifeops-routes.ts:2005`, `apps/app-lifeops/src/routes/lifeops-routes.ts:2094`, `apps/app-lifeops/src/routes/lifeops-routes.ts:2208`, `apps/app-lifeops/src/routes/lifeops-routes.ts:2306`.
- Service and schema: `apps/app-lifeops/src/lifeops/service.ts:45`, `apps/app-lifeops/src/lifeops/schema.ts:34`, `apps/app-lifeops/src/lifeops/schema.ts:609`, `apps/app-lifeops/src/lifeops/schema.ts:657`, `apps/app-lifeops/src/lifeops/schema.ts:691`, `apps/app-lifeops/src/lifeops/schema.ts:955`, `apps/app-lifeops/src/lifeops/schema.ts:1040`.
- Google connections: `apps/app-lifeops/src/lifeops/google-oauth.ts:35`, `apps/app-lifeops/src/lifeops/google-oauth.ts:150`, `apps/app-lifeops/src/lifeops/google-oauth.ts:186`, `apps/app-lifeops/src/lifeops/google-oauth.ts:688`, `apps/app-lifeops/src/lifeops/google-scopes.ts:22`, `apps/app-lifeops/src/lifeops/service-mixin-google.ts:618`, `apps/app-lifeops/src/lifeops/service-mixin-google.ts:1058`, `apps/app-lifeops/src/lifeops/service-mixin-google.ts:1153`.
- Client/hook mappings: `apps/app-lifeops/src/api/client-lifeops.ts:1906`, `apps/app-lifeops/src/api/client-lifeops.ts:2065`, `apps/app-lifeops/src/api/client-lifeops.ts:2125`, `apps/app-lifeops/src/api/client-lifeops.ts:2169`, `apps/app-lifeops/src/api/client-lifeops.ts:2255`, `apps/app-lifeops/src/api/client-lifeops.ts:2311`, `apps/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:32`, `apps/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:428`, `apps/app-lifeops/src/hooks/useWhatsAppPairing.ts:30`, `packages/app-core/src/api/client-skills.ts:273`, `packages/app-core/src/api/client-skills.ts:1123`.
- Browser setup: `apps/app-lifeops/src/provider.ts:41`, `apps/app-lifeops/src/lifeops/service-constants.ts:140`, `apps/app-lifeops/src/lifeops/service-mixin-core.ts:214`, `apps/app-lifeops/src/lifeops/service-mixin-core.ts:238`.
- Calendar/email/reminders/followups/notifications: `apps/app-lifeops/src/lifeops/service-mixin-calendar.ts:201`, `apps/app-lifeops/src/lifeops/runtime.ts:43`, `apps/app-lifeops/src/lifeops/scheduler-task.ts:192`, `apps/app-lifeops/src/followup/followup-tracker.ts:48`, `apps/app-lifeops/src/followup/followup-tracker.ts:160`, `apps/app-lifeops/src/followup/followup-tracker.ts:290`, `apps/app-lifeops/src/lifeops/notifications-push.ts:21`, `apps/app-lifeops/src/actions/cross-channel-send.ts:1`, `apps/app-lifeops/src/actions/cross-channel-send.ts:619`.
- Remote sessions: `apps/app-lifeops/src/actions/owner-remote-desktop.ts:54`, `apps/app-lifeops/src/remote/remote-session-service.ts:1`, `apps/app-lifeops/src/remote/remote-session-service.ts:148`, `apps/app-lifeops/src/remote/tailscale-transport.ts:109`.
- Targeted tests: `apps/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts:67`, `apps/app-lifeops/src/components/BrowserBridgeSetupPanel.test.tsx`, `apps/app-lifeops/test/followup-tracker.test.ts:234`, `apps/app-lifeops/test/remote-session-service.test.ts:87`, `apps/app-lifeops/test/notifications-push.integration.test.ts:1`, `apps/app-lifeops/src/routes/lifeops-routes.test.ts`.

## What I could validate

- Static route/client coverage exists for Google, X, iMessage, Telegram, Signal, Discord, WhatsApp, calendar, Gmail, reminders, channel policies, and status surfaces.
- Non-public LifeOps routes rely on the framework auth check before route execution and then require runtime context before constructing `LifeOpsService` (`apps/app-lifeops/src/routes/lifeops-routes.ts:118`).
- Sensitive sends and connector writes have dedicated rate-limit buckets, including Gmail send at 2/min and generic outbound messaging at 5/min (`apps/app-lifeops/src/routes/lifeops-routes.ts:170`).
- Google supports cloud-managed, local loopback, and remote OAuth modes; capabilities map to calendar/Gmail scopes; agent-side Gmail grants are explicitly rejected in favor of the Gmail plugin (`apps/app-lifeops/src/lifeops/service-mixin-google.ts:1071`).
- Calendar listing aggregates Google grants and supports per-calendar feed inclusion (`apps/app-lifeops/src/lifeops/service-mixin-calendar.ts:201`).
- Browser context is owner-only and defaults to tracking current tab with browser control disabled; state-changing browser actions are rejected unless control is enabled (`apps/app-lifeops/src/provider.ts:41`, `apps/app-lifeops/src/lifeops/service-constants.ts:148`, `apps/app-lifeops/src/lifeops/service-mixin-core.ts:238`).
- Cross-channel send drafts first and requires a confirmed reinvocation before dispatch; notifications are routed through Ntfy only when `NTFY_BASE_URL` is configured (`apps/app-lifeops/src/actions/cross-channel-send.ts:1`, `apps/app-lifeops/src/actions/cross-channel-send.ts:619`).
- Remote sessions require explicit confirmation; non-local mode requires a one-time pairing code; absent data plane returns structured `data-plane-not-configured` instead of pretending the session is usable (`apps/app-lifeops/src/remote/remote-session-service.ts:148`).
- Targeted bounded test run passed:
  - Command: `bunx vitest run --config apps/app-lifeops/vitest.config.ts apps/app-lifeops/src/hooks/useGoogleLifeOpsConnector.test.ts apps/app-lifeops/src/components/BrowserBridgeSetupPanel.test.tsx apps/app-lifeops/test/followup-tracker.test.ts apps/app-lifeops/test/remote-session-service.test.ts apps/app-lifeops/test/notifications-push.integration.test.ts apps/app-lifeops/src/routes/lifeops-routes.test.ts`
  - Result: `Test Files 5 passed (5)`, `Tests 84 passed (84)`, duration `86.26s`.

## What I could not validate

- Real connected-account OAuth or pairing flows: Google cloud/local/remote OAuth, X, Telegram login/2FA, Signal pairing, Discord authorization, WhatsApp QR, and iMessage Full Disk Access.
- Real Gmail, Calendar, Drive, X DM, iMessage, Telegram, Signal, Discord, and WhatsApp read/send side effects against connected accounts.
- Real Chrome/Safari Agent Browser Bridge extension install, tab capture, permission prompts, browser-control sessions, or account-affecting confirmation flows.
- Real reminder delivery across in-app, SMS/voice, email, chat, and push notification channels.
- Ntfy live delivery; the live block is intentionally skipped unless `NTFY_BASE_URL` is set and would publish real notifications (`apps/app-lifeops/test/notifications-push.integration.test.ts:13`).
- Real Twilio SMS/voice delivery and phone-consent workflows.
- Remote desktop data-plane usability over Tailscale or cloud tunnel.
- Multi-device intent replication. The implementation is explicitly a local database queue, not a wire-level replication bridge (`apps/app-lifeops/src/lifeops/intent-sync.ts:5`).

## Bugs/risks P0-P3

### P0

- None found in this bounded review.

### P1

- Follow-up tracker is registered but appears not to be scheduled on clean startup. `plugin.ts` registers `registerFollowupTrackerWorker(runtime)` (`apps/app-lifeops/src/plugin.ts:308`), while proactive and scheduler workers also call ensure functions that create/update task rows (`apps/app-lifeops/src/plugin.ts:294`, `apps/app-lifeops/src/plugin.ts:327`). `rg` found no `ensureFollowup...` task creation path. The follow-up worker tests validate registration/manual execution only (`apps/app-lifeops/test/followup-tracker.test.ts:234`). On a fresh runtime, hourly follow-up reconciliation may never run unless some other path creates the `FOLLOWUP_TRACKER_RECONCILE` task row.

### P2

- Google OAuth callback refresh fallbacks use mismatched channel/storage keys. The hook listens on `elizaos:lifeops:google-connector` and `elizaos:lifeops:google-connector-refresh` (`apps/app-lifeops/src/hooks/useGoogleLifeOpsConnector.ts:32`), but callback HTML posts to `eliza:lifeops:google-connector` and `eliza:lifeops:google-connector-refresh` (`apps/app-lifeops/src/routes/lifeops-routes.ts:800`). `window.opener.postMessage`, focus, visibility, and polling can still hide this, but the BroadcastChannel/localStorage fallback path is broken and can leave the connector UI stale after OAuth.
- Intent sync wording and behavior are easy to overread as cross-device sync, but the implementation says it is local-only and not wire-replicated (`apps/app-lifeops/src/lifeops/intent-sync.ts:5`). Scheduler code escalates unacknowledged intents to mobile by writing more local intent records (`apps/app-lifeops/src/lifeops/runtime.ts:61`). Launch QA should treat remote/mobile intent delivery as unvalidated unless another device-bus layer is present.
- WhatsApp pairing for LifeOps uses the generic app-core WhatsApp routes with `{ authScope: "lifeops", configurePlugin: false }` (`apps/app-lifeops/src/hooks/useWhatsAppPairing.ts:30`, `packages/app-core/src/api/client-skills.ts:1123`), while LifeOps routes expose only status/send/messages (`apps/app-lifeops/src/routes/plugin.ts:233`). This can be correct, but launch depends on the generic WhatsApp route/plugin being loaded and preserving LifeOps-vs-platform auth separation.

### P3

- Ntfy push has config/unit coverage but no CI-safe HTTP integration coverage; the live test is skipped in CI and warns not to run against a public broker (`apps/app-lifeops/test/notifications-push.integration.test.ts:13`).
- Remote session control-plane tests cover pairing and explicit no-data-plane responses, but actual remote usability depends on Tailscale/cloud tunnel configuration (`apps/app-lifeops/src/remote/remote-session-service.ts:11`, `apps/app-lifeops/src/remote/tailscale-transport.ts:109`).
- Browser Bridge routes have moved to `@elizaos/plugin-browser-bridge`; LifeOps launch must verify that plugin is included wherever `app-lifeops` is enabled, or browser setup UI/actions will be present without their route backend.

## Codex-fixable work

- Add `ensureFollowupTrackerTask(runtime)` mirroring `ensureLifeOpsSchedulerTask` / `ensureProactiveAgentTask`, schedule it after runtime init, and add an init test that all three recurring worker task rows are created or updated.
- Share Google connector refresh constants between callback route and hook, or dual-listen for the current `eliza:` and `elizaos:` keys. Add a regression test that callback HTML refreshes the hook through `postMessage`, `BroadcastChannel`, and `storage`.
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
- Browser Bridge fake companion route tests and UI smoke tests that fail if `@elizaos/plugin-browser-bridge` routes are absent.
- Scheduler fake-clock tests for reminder attempts across in-app, push, email, SMS/voice, and chat channels with consent/channel-policy gates.
- Remote-session tests with fake Tailscale/cloud data-plane resolver and UI/action assertions that null ingress is treated as non-usable.
- Local HTTP-server Ntfy integration test.
- Intent-sync test that asserts local-only semantics, plus a separate device-bus contract test if cross-device delivery is expected.

## Changed paths

- `launchdocs/14-lifeops-qa.md`
