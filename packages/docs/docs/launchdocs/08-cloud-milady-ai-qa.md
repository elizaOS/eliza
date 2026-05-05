# Launch Readiness 08: Cloud milady.ai QA

## Second-Pass Status (2026-05-05)

- Superseded: pairing-token 202 server-side tests exist.
- Still open: the Web UI client still lacks 202 retry handling, custom `dockerImage` is sent by the UI but stripped by API schema, raw dashboard `fetch` calls bypass shared bearer-token injection, and authenticated cloud lifecycle e2e remains missing.
- Launch gate: cloud API-key client/redaction coverage is wired into launch QA; live login, agent creation, web UI open/resume, billing, and migration flows still need credentialed validation.

Review timestamp: 2026-05-04 PDT. Scope was repo inspection plus public, non-mutating network checks. I did not create accounts, provision agents, open checkout, or spend money.

## Current state

The launch surface is split across several products:

- `https://milady.ai` currently serves a GitHub Pages SPA titled `Milady | Local-First Control`, with copy about opening Milady locally, signing into Eliza Cloud, and controlling remote runtimes.
- `packages/homepage` is a separate phone-first onboarding site with `/get-started`, `/login`, and `/connected` routes that link Telegram, iMessage, Discord, and WhatsApp identities to Eliza Cloud.
- `cloud/apps/frontend` contains the authenticated Eliza Cloud dashboard, including login and managed agent list/detail/create flows.
- `packages/app` and `packages/app-core` contain the desktop/mobile app migration path through Cloud login, direct Cloud API agents, mobile runtime modes, and one-time launch sessions.

The cloud API is publicly reachable at `https://api.elizacloud.ai` and `https://www.elizacloud.ai`; `/api/health` returned `{"status":"ok"}`. Unauthenticated agent listing returned `authentication_required`, which is expected.

## Evidence reviewed with file refs/URLs

- Public root: `https://milady.ai` returned HTTP 200 from GitHub Pages, `content-length: 1651`, title `Milady | Local-First Control`, and bundle `/assets/index-CDqUh6p6.js`.
- Public canonical redirect: `https://www.milady.ai` returned HTTP 301 to `https://milady.ai/`.
- Public deep links: `https://milady.ai/login`, `/get-started`, `/connected`, `/terms`, `/privacy`, and `/help` returned HTTP 404 with a GitHub Pages redirect shim that rewrites to `/?p=<path>&q=<query>&h=<hash>`.
- Public installer: `https://milady.ai/install.sh` returned a shell installer script.
- Public API checks: `https://milady.ai/api/health` returned GitHub Pages 404; `https://api.elizacloud.ai/api/health` and `https://www.elizacloud.ai/api/health` returned HTTP 200 JSON health.
- Homepage routes: `packages/homepage/src/App.tsx:26` defines only `/`, `/leaderboard`, `/login`, `/connected`, and `/get-started`.
- Homepage Eliza Cloud API base: `packages/homepage/src/lib/api/client.ts:1` defaults to `https://www.elizacloud.ai`.
- Homepage auth context: `packages/homepage/src/lib/context/auth-context.tsx:250` fetches `/api/eliza-app/user/me`; Telegram/Discord/WhatsApp auth starts at `:313`, `:385`, and `:461`.
- Homepage onboarding: `packages/homepage/src/pages/get-started.tsx:38` hardcodes `+14245074963`; method routing and Discord callback handling start around `:247`; iMessage opens the `sms:` handoff at `:803`.
- Homepage connected state: `packages/homepage/src/pages/connected.tsx:193` requires auth; communication channel actions are rendered from `:386` through `:627`; footer links to `/terms`, `/privacy`, `/help` at `:640`.
- Cloud frontend routes: `cloud/apps/frontend/src/App.tsx:480` defines `/login`; dashboard agent routes are at `:576`.
- Cloud auth wrapper: `cloud/apps/frontend/src/lib/api-client.ts:125` injects `steward_session_token` and uses `credentials: "include"`.
- Cloud dashboard guard: `cloud/apps/frontend/src/dashboard/DashboardLayout.tsx:88` redirects unauthenticated dashboard users to `/login?returnTo=...`.
- Cloud agent list/detail data hooks: `cloud/apps/frontend/src/lib/data/eliza-agents.ts:14` and `:27`.
- Agent create dialog: `cloud/packages/ui/src/components/containers/create-eliza-agent-dialog.tsx:315` builds the create body and `:322` posts it.
- Agent table/actions: `cloud/packages/ui/src/components/containers/eliza-agents-table.tsx:245`, `:333`, `:383`, and `:408`; `cloud/packages/ui/src/components/containers/agent-actions.tsx:37`.
- Web UI pairing client: `cloud/packages/lib/hooks/open-web-ui.ts:29`.
- Web UI pairing server contract: `cloud/apps/api/v1/eliza/agents/[agentId]/pairing-token/route.ts:20` documents 202/retry behavior and `:68` implements it.
- Agent create API schema: `cloud/apps/api/v1/eliza/agents/route.ts:27` accepts `agentName`, `characterId`, `agentConfig`, and `environmentVars`; create handler begins at `:97`.
- Provisioning API: `cloud/apps/api/v1/eliza/agents/[agentId]/provision/route.ts:43` starts async provisioning and returns job ids.
- Managed launch sessions: `cloud/packages/lib/services/eliza-managed-launch.ts:253` creates one-time launch sessions; `cloud/apps/api/v1/eliza/launch-sessions/[sessionId]/route.ts:35` consumes them once.
- App launch consume path: `packages/app/src/main.tsx:846` applies managed Cloud launch before platform init; `packages/app-core/src/platform/browser-launch.ts:170` consumes `cloudLaunchSession`.
- Mobile runtime modes: `packages/app-core/src/onboarding/mobile-runtime-mode.ts:16` defines `remote-mac`, `cloud`, `cloud-hybrid`, and `local`; `packages/app/src/ios-runtime.ts:44` resolves Cloud/mobile runtime env.
- Desktop Cloud account page: `packages/app-core/src/components/pages/ElizaCloudDashboard.tsx:495` renders connect/disconnect/billing Cloud account controls.

## What I could validate

- `milady.ai` root is online and serves a static SPA over HTTPS.
- `www.milady.ai` canonicalizes to the apex domain.
- Public health for the Cloud API is online on both `api.elizacloud.ai` and `www.elizacloud.ai`.
- Unauthenticated `/api/v1/eliza/agents` is protected and returns `authentication_required`.
- The repo has code paths for Cloud login, dashboard agent create/list/detail/provision/open, and desktop/mobile Cloud launch-session handoff.
- The homepage package has messaging-based onboarding and connected-channel UI for Telegram, iMessage, WhatsApp, and Discord.

## What I could not validate

- I could not validate authenticated login, create agent, provision agent, open Web UI, credits, billing, or migration from cloud agent to desktop/phone app without Cloud credentials and potential spend.
- I could not confirm whether the deployed `milady.ai` bundle exactly matches any current repo source. The deployed index title/copy did not match `packages/homepage`, and source search found only partial related references.
- I could not validate the GitHub Pages redirect shim in a real browser session with app-side route restoration. Curl sees HTTP 404 for deep links, then a JavaScript redirect body.
- I could not validate Telegram, Discord, WhatsApp, or iMessage account linking end to end because that would require real accounts and message delivery.

## Bugs/UX risks P0-P3

### P0

- None found from non-mutating review.

### P1

- Cloud Web UI pairing client does not implement the server's 202 retry contract. The server intentionally returns HTTP 202 with `status: "starting"` and `retryAfterMs` when a stopped/pending agent needs provisioning, but `openWebUIWithPairing` treats any OK response without `redirectUrl` as failure and closes the popup. This can make "Open Web UI" fail exactly when it should start/resume the agent. Evidence: `cloud/packages/lib/hooks/open-web-ui.ts:29`; `cloud/apps/api/v1/eliza/agents/[agentId]/pairing-token/route.ts:20`.

### P2

- Agent create type/custom Docker selection appears ignored by the API. The dialog sends a top-level `dockerImage`, but the API create schema strips unknown fields and does not accept `dockerImage`; custom/default flavor choice may silently deploy the default managed agent. Evidence: `cloud/packages/ui/src/components/containers/create-eliza-agent-dialog.tsx:315`; `cloud/apps/api/v1/eliza/agents/route.ts:27`.
- Several Cloud dashboard components use raw `fetch` instead of the shared `api`/`apiFetch` wrapper. Cookie auth may still work, but localStorage `steward_session_token` auth will be skipped, causing inconsistent 401s in create/provision/suspend/delete/poll/open flows. Evidence: `cloud/apps/frontend/src/lib/api-client.ts:125`; raw fetch sites in create dialog, agent table, agent actions, Web UI open hook, sandbox poller, and job poller.
- `milady.ai` direct routes return HTTP 404. The body is a redirect shim, but direct `/login`, `/get-started`, `/connected`, `/terms`, `/privacy`, and `/help` links have 404 status until JavaScript runs. This is risky for launch links, auth return URLs, previews, crawlers, and any client that blocks inline script.
- The current deployed `milady.ai` bundle appears different from `packages/homepage`, so launch QA has an ownership risk: repo-side fixes to `packages/homepage` may not affect the deployed apex site.

### P3

- Homepage connected footer links point to `/terms`, `/privacy`, and `/help`, but the homepage router does not define those paths. If that package is deployed, the links land in the SPA fallback/Not Found state. Evidence: `packages/homepage/src/pages/connected.tsx:640`; `packages/homepage/src/App.tsx:26`.
- `packages/app-core/src/platform/browser-launch.ts:90` has duplicate launch-session exchange URLs, so the intended fallback path is likely missing.
- `useJobPoller` reloads the page after job completion/failure, while callers also refresh state. This can interrupt the user and hide job-specific feedback. Evidence: `cloud/packages/lib/hooks/use-job-poller.ts:160`.
- Agent list rows intentionally null out detail-only runtime fields, so the list can show limited or ambiguous provisioning state until detail/poll data arrives. Evidence: `cloud/apps/frontend/src/dashboard/agents/Page.tsx:17`.

## Codex-fixable work

- Update `openWebUIWithPairing` to handle 202 by polling/retrying until `redirectUrl` is returned, timeout is reached, or a terminal error occurs. Keep the popup open with a visible "starting agent" state.
- Align create dialog payload with API schema. Either send image/flavor through an accepted `agentConfig`/`environmentVars` contract or extend the API schema intentionally and test custom image provisioning.
- Replace raw dashboard `fetch` calls with the shared API client so bearer-token and cookie auth behavior are consistent.
- Add tests for pairing-token 202 handling, create custom image payload, and bearer-token auth on create/provision/open flows.
- Add or align homepage legal/help routes, or update footer links to the deployed Cloud legal paths.
- Remove duplicate launch-session exchange URL and add a regression test for `cloudLaunchSession` URL construction.
- Decide whether GitHub Pages deep-link 404 statuses are acceptable. If not, deploy with a 200 SPA fallback host or adjust static routing.

## Human/cloud credential QA needed

- Login with a real Cloud account on `https://milady.ai` and `https://www.elizacloud.ai`; verify return URLs and session persistence after reload.
- Create a new managed agent with minimum credits; confirm the selected flavor/image matches the running sandbox.
- Provision/start the agent, wait for async job completion, and confirm list/detail status transitions.
- Open Web UI from a stopped/pending agent and from a running agent; confirm 202 retry UX, one-time token exchange, and no popup blocker failure.
- Verify message-channel onboarding with test Telegram, Discord, WhatsApp, and iMessage accounts.
- Verify desktop app Cloud login, Cloud agent listing, agent launch session handoff, and local app boot into the selected Cloud runtime.
- Verify iOS/Android runtime modes for `cloud` and `cloud-hybrid`, including device bridge startup and disconnect/reconnect behavior.
- Verify billing/credits screens with test billing credentials only. Do not use production money for this launch QA.

## Recommended end-to-end test plan

1. Public routing smoke: open `https://milady.ai`, `https://milady.ai/login`, `https://milady.ai/privacy`, and `https://milady.ai/install.sh` in a browser and confirm final route, HTTP status expectations, console errors, and visible CTA copy.
2. Auth smoke: sign in to Cloud from the public launch path and from `https://www.elizacloud.ai/login`; reload and confirm session survives.
3. Agent lifecycle: create agent, confirm credit gate/cost notice, provision/start, observe job status, open detail, inspect logs, suspend, resume, and delete a disposable test agent.
4. Web UI pairing: open Web UI for running and stopped agents; verify 202 retry, one-time pairing token consumption, and token cannot be reused.
5. Desktop migration: from Cloud agent detail, launch/open in Milady desktop app; verify `cloudLaunchSession` is consumed once, Cloud API base/token are applied, and the app lands on the correct runtime.
6. Phone migration: repeat for iOS and Android using `cloud` and `cloud-hybrid` modes; verify bridge startup, background/foreground recovery, and reconnect after app restart.
7. Messaging onboarding: link and unlink Telegram, Discord, WhatsApp, and iMessage identities with disposable accounts; verify connected page reflects each channel and deep links open the right native app.
8. Negative paths: no credits, expired login, deleted agent, stopped sandbox, popup blocked, invalid launch session, reused launch session, offline mobile, and auth token revoked.

## Changed paths

- `launchdocs/08-cloud-milady-ai-qa.md`
