# #8621 / #10823 — mobile cloud-agent app wiring (LEG W4, wave 3)

Branch `feat/ui-mobile-gap-burndown` @ develop `5471346e7a6`. Evidence for the
app-side dedicated/shared cloud-agent wiring tracked by #8621 and the #10823
deep-link/shell leg.

## Findings inventory (re-verified against develop tip, 2026-07-02)

### Already landed (do NOT rebuild)

1. **Cloud-side unified auth proxy** — `packages/cloud/api/src/dedicated-agent-proxy.ts`
   (#8628 `5ac3a2a6d5e`, WS leg #8639 `65bd4d02504`). Validates the cloud token,
   confirms org ownership, swaps in the container's `ELIZA_API_TOKEN`, proxies to
   `https://<agentId>.elizacloud.ai/*`. Auto-resumes a non-`running` dedicated
   agent and answers `202 {status:"starting", retryAfterMs}` + `Retry-After`.
2. **Client 202/Retry-After honor** — `packages/ui/src/api/client-base.ts`
   (#8641): every client fetch retries a 202 up to `RESUME_MAX_RETRIES = 6` ×
   ≤10 s (~60 s budget) and surfaces `waking` chat status via `onResuming`.
3. **`web_ui_url` preference** — `resolveCloudAgentApiBase` (client-cloud.ts)
   prefers `webUiUrl` over raw `bridgeUrl`; the cloud list/detail routes return
   the public dedicated subdomain (`resolvePublicWebUiUrl`) for dedicated agents,
   so live reuse flows already bind the unified proxy base, not the tailnet
   `http://100.64.x.x:<port>` bridge. Its doc comment was STALE (claimed the
   subdomain gateway is not deployed — it is, verified live 2026-06-19 in #8621).
4. **Shared-runtime REST adapter (#8387 gap, cloud side)** —
   `packages/cloud/api/v1/eliza/agents/[agentId]/api/*` now serves
   `/api/health`, `/api/conversations`, `/api/conversations/:id/messages(/stream)`
   for shared agents, and the create/provision routes return a REST-serving
   `webUiUrl` (`<origin>/api/v1/eliza/agents/<id>`). Client side,
   `selectOrProvisionCloudAgent` + `resolveCloudAgentApiBase` +
   `buildCloudSharedAgentApiBase` derive that adapter base even when the list
   DTO carries no URL (shared list items have `webUiUrl: null`).
5. **Shared→dedicated handoff supervisor** (`startCloudAgentHandoff`, #9843/#9854/#9902)
   and startup resume (`resumePendingCloudHandoff` in startup-phase-poll — epic A's
   file, untouched here).

### Verified gaps (this leg's work)

- **G1 — dedicated cold boot fails the connect flow.** The reuse branch of
  `selectOrProvisionCloudAgent` returns the dedicated subdomain base immediately
  even when the picked agent is `stopped`/`pending`/`disconnected`. A dedicated
  cold boot takes ~5 min (#8621, verified live 2026-06-19); the client's 202
  resume budget is ~60 s — so the first chat call exhausts it and errors
  ("Agent is still starting up") instead of showing boot progress. No connect
  flow (JoinPage web, `bindCloudAgent` native first-run, agent switch) waits
  for `running`.
- **G2 — no e2e proof of the shared-runtime chat-bridge wiring (#8387 → #8621).**
  The derivation chain (no URLs in list DTO → REST adapter base → chat REST
  round-trip) had no test driving the real client code against a real HTTP
  server.
- **G3 — #10823 shell leg: no deep-link / in-app entry for the Apps Deploy UI.**
  `resolveDeepLinkNavigationIntent` (packages/app/src/deep-link-routing.ts) knows
  settings/wallet/browser/connectors only; nothing routes to the registered
  `cloud-apps` app-shell page (NativeAppsStudio → ApplicationsPage →
  ApplicationDetailPage → Deploy/Redeploy button). The extracted
  `createDeepLinkHandler` (deep-link-handler.ts) also lacked the top-level-surface
  intent dispatch that main.tsx's live handler has (parity drift).
- **G4 — stale client comment** on `resolveCloudAgentApiBase` documenting the
  pre-proxy world (subdomain "not deployed", bridgeUrl preferred rationale).

### Non-gaps / explicitly out of scope

- `provisionCloudSandbox` (client-cloud.ts) has **zero live callers** (tests
  only) and still returns the raw tailnet bridgeUrl on its dedicated fast path.
  Legacy; removing a declared `ElizaClient` interface method is out of this
  leg's blast radius (flagged for cleanup).
- `packages/app-core/src` contains no cloud-agent client/manager targeting an
  old base (grepped `elizacloud|eliza/agents|bridge_url` — only runtime/entry
  registry references). The cloud-agent client lives in `packages/ui/src/api/`.
- startup-phase-poll / reconcile-mobile-runtime-mode / main.tsx boot order:
  owned by epic A / other legs — read, not modified.

## Changes (this leg)

1. `packages/ui/src/api/client-cloud.ts` — `waitForCloudAgentRunning` cold-boot
   wait: the reuse branch of `selectOrProvisionCloudAgent` now kicks a resume
   and polls the control plane with `onProgress("starting", …)` updates
   (defaults: 5 s poll / 6-min budget ≥ the ~5-min cold boot; test-tunable via
   `wakePollIntervalMs`/`wakeTimeoutMs`) before binding the dedicated base.
   The agent record returned by the wait is the POST-wake read, so fresh URLs
   are honored; terminal `error`/`failed` status and timeout fail with
   actionable messages; transient poll failures are tolerated. Shared agents
   (no dedicated URL → shared REST-adapter base) never wait. Progress strings
   flow through the existing JoinPage/`bindCloudAgent` onProgress plumbing (no
   UI fork). Also fixed the stale pre-proxy doc comment on
   `resolveCloudAgentApiBase` (G4).
2. `packages/app/src/deep-link-routing.ts` — `apps/deploy` (+ the `cloud-apps`
   page-id alias) resolve to `{ viewId: "cloud-apps", viewPath: "/cloud-apps" }`;
   `eliza://apps/deploy` AND the universal link `https://eliza.app/apps/deploy`
   both hit this mapping (main.tsx's live handler + the extracted handler).
3. `packages/app/src/deep-link-handler.ts` — parity fix (G3): the extracted
   `createDeepLinkHandler` now dispatches top-level-surface navigation intents
   on the `eliza:navigate:view` bus exactly like the live main.tsx handler
   (injectable `dispatchNavigationIntent` seam; defaults to the CustomEvent
   bus), replacing its stale hash-write branches for settings/wallet/browser/
   connectors (a hash write never opens a tab on the mobile/Capacitor
   entrypoint).
4. Tests + render proof (below).

## Evidence files (all reviewed by hand)

- `mock-cloud-cold-boot-e2e.txt` — verbose vitest run of
  `packages/ui/src/api/client-cloud-connect-mock-cloud.test.ts` (7 tests) +
  the pre-existing select-or-provision suite (6 tests), all green. The new
  suite drives the REAL client (`selectOrProvisionCloudAgent`,
  `directCloudRequest` fetch path, `resolveCloudAgentApiBase`,
  `createConversation`/`sendConversationMessage`/`getConversationMessages`)
  against a REAL `node:http` server on the leg-4 port range (36400-36499)
  that implements control plane + #8628 dedicated-proxy 202/Retry-After
  semantics + the #8387 shared REST adapter. Covers: cold-boot wait with
  resume kick + progress + fresh post-wake base + full chat round-trip
  through the proxy (one 202 honored en route), already-running fast path
  (no resume/no wait), terminal-error fail-fast, timeout, transient 500
  tolerance, shared URL-less-DTO base derivation + chat bridge round-trip
  with bearer auth asserted server-side, and the unauthorized-list
  never-duplicate guard. Only `@capacitor/core` platform detection is
  stubbed (non-native lane).
- `deep-link-routing-tests.txt` — verbose vitest run of
  `packages/app/src/deep-link-routing.test.ts` +
  `deep-link-handler.test.ts` (32 tests green): the #10823 intent mapping,
  aliases, non-claims (`apps`, `apps/files`, `apps/deploy/extra`), handler
  bus dispatch (injected seam + default CustomEvent), and the pre-existing
  chat-launch/share/connect/notification behavior unchanged.
- `cloud-apps-deploy-01-list.png` — the Applications studio (NativeAppsStudio
  → ApplicationsPage) mounted in the real Chromium app shell after
  dispatching the exact `apps/deploy` navigation intent: fixture app card
  "Deep Link Deploy Proof" + stats row + orange Create App.
- `cloud-apps-deploy-02-detail-deploy.png` — ApplicationDetailPage Overview
  with the Deployment card and the **Deploy** control visible (tabs:
  Overview/Monetize/Earnings/Hosting/Domains/Analytics/Promote/Users/
  Settings).
- `ui-smoke-cloud-apps-deploy.txt` — Playwright run of
  `packages/app/test/ui-smoke/cloud-apps-deploy-deeplink.spec.ts` (real
  Chromium against the ui-smoke stack; Electrobun desktop-platform marker
  injected pre-boot so the `cloud-apps` page registers; Eliza Cloud API
  route-mocked with a strict "no unmocked endpoints" assertion).

## Not captured / N/A

- **OS-level deep-link delivery** (electrobun `openDeepLink` RPC / iOS
  `appUrlOpen`) is not drivable from headless Chromium — the URL→intent half
  is unit-locked in `deep-link-routing.test.ts` and the intent→render half is
  the ui-smoke spec above; the composition inside `handleDeepLink` is the
  same code path main.tsx runs for every other top-level-surface link.
  Electrobun/simulator captures were not taken (packaged-shell lane).
- **Live ~5-minute dedicated cold boot** against real Eliza Cloud was verified
  live on 2026-06-19 (#8621 thread); this leg's wait loop is proven against
  the mock control plane with real HTTP + real timers (scaled intervals).
- **Real-LLM trajectory** — N/A: no agent/action/provider/prompt/model
  behavior change; this leg changes the connect/transport/navigation layer
  only, and the chat round-trips in evidence exercise transport, not model
  output.
