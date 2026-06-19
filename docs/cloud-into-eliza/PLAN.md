# Cloud → Eliza: collapse the cloud dashboard into the Eliza app

**Status:** PLAN — prepared for review. Do not execute until explicitly approved ("go").
**Goal (owner's words):** "Refactor the cloud to basically just be the hosted web version of Eliza. The main join experience takes you into managing your agents and connecting to an agent. All the cloud pages move into the Eliza app. Eliza Cloud becomes a view inside Eliza — applications, API keys, payment etc. integrated into settings. The APIs don't need to change much; the interface/frontend gets tightly integrated into Eliza so there is **no separate cloud UI**. The cloud UI is agent management + external payment + API keys + applications + basic stuff, but the main thing is pushing you into the Eliza web app, which connects to an agent container and is the full Eliza experience."

This document is the research synthesis, target architecture, what-moves-where mapping, UX/UI design, user-research plan, risk analysis, and phased implementation plan — followed by a self-critique and a **second revision**.

---

## 0. TL;DR

- We are **not building much new plumbing.** The Eliza app (`packages/ui` + `packages/app`) already has a cloud server model (`PersistedActiveServer { kind:"cloud"|"remote", id:"cloud:<agentId>" }`), a `/pair` SSO token handoff, a dedicated-agent subdomain proxy, REST/WS/SSE base-URL indirection, a pluggable **settings-section registry**, and several cloud sections already in-app (`CloudAgentsSection`, `ElizaCloudDashboard`, `AppsManagementSection`, `ConnectorsSection`). And `packages/ui/src/cloud-ui` already contains most of the cloud **dashboard chrome** that `cloud-frontend` renders.
- The migration is therefore mostly: (1) **stand up a hosted-web deploy of `packages/app`** at the `elizacloud.ai` apex, reusing the existing Cloudflare Pages project + same-origin `/api` proxy; (2) **reconcile auth** (standardize hosted-web on the Steward JWT; keep device-code for native); (3) **re-home cloud pages** as in-app settings sections / views / agent views, reusing `cloud-ui`; (4) **preserve every backend-issued deep-link path** the app must serve; (5) **drop** the canvas subsystem, `assistant-concepts`, the MCP demo, and the duplicate surfaces.
- **Backend "doesn't change much" is true.** The HS256 Steward JWT is host-independent; the only backend edits are origin/CORS/CSRF allowlist additions and `wrangler` env — and **even those are avoided** if we keep the app at the apex. Two pre-existing backend auth bugs block the public approval/sensitive pages and should be fixed in-flight.
- **Recommended deployment: Topology A** — the Eliza web app *is* `elizacloud.ai`. No `wrangler` env changes, no CORS/redirect allowlist edits, no agent-subdomain routing changes. The only obligation is that the app reproduce the existing SPA route paths (incl. their internal redirects).

---

## 1. Current-state assessment (the truth)

### 1.1 Two frontends, two auth worlds

| | **cloud-frontend** (the thing we delete) | **Eliza app** (the thing we grow) |
|---|---|---|
| Package | `packages/cloud-frontend` (React Router v7 SPA) | `packages/app` (thin Vite shell) + `packages/ui` (`@elizaos/ui`, the real UI) |
| Routing | `react-router` `<Routes>` table (`src/App.tsx`, 824 lines) | Custom **tab/view** system (`packages/ui/src/App.tsx`, `navigation/index.ts`) |
| Deploy | **Cloudflare Pages** project `eliza-cloud` at **`elizacloud.ai` apex**; `functions/_proxy.ts` reverse-proxies same-origin `/api/*`+`/steward/*` → `api.elizacloud.ai` | **No hosted-web deploy today** — desktop (Electrobun) + mobile (Capacitor) only; `build:web` exists but is unhosted |
| Auth | **Steward JWT** (`@stwd/sdk`) in `localStorage.steward_session_token`, sent Bearer + `credentials:include`; also synced to HttpOnly `steward-token` cookie | **Device-code → API key** (`__ELIZA_CLOUD_AUTH_TOKEN__`), per-agent password gate (`LoginView`); **never reads `steward_session_token`** |
| Lands at | `/dashboard/agents` (a management table) | Chat with the connected agent |
| Design system | Tailwind v4 + shared `packages/ui/src/styles/base.css` tokens (orange-only) | **Same** Tailwind v4 + same `base.css` |

The two worlds are bridged today only by a device-pairing handshake: the app's `cloudLoginDirect()` opens `cloud-frontend`'s `/auth/cli-login?session=<id>` page, where the user authenticates with their Steward session and the browser POSTs `/api/auth/cli-session/:id/complete` to mint an API key the app polls for. **This seam is what we generalize.**

### 1.2 The biggest accelerant: `packages/ui/src/cloud-ui` already exists

`cloud-frontend/vite.config.ts` aliases the bare specifier `@elizaos/ui` to `packages/ui/src/cloud-ui/index.ts`. So **cloud-frontend already imports its page chrome from `packages/ui`**: `DashboardShellLayout`, `DashboardSidebar`, `AppsListView`, `ApiKeysTable`/`ApiKeysSummary`, `ElizaAgentsPageWrapper`, `AuthorizeContent`, `EarningsSimulator`, `RevenueFlowDiagram`, `LogViewer`, `OpenApiViewer`, the `ConnectionCard` family, analytics cards, theme provider, and Next.js→react-router shims (`cloud-ui/runtime/navigation.ts`, `dynamic.tsx`, `image.tsx`). What is **still only in cloud-frontend** is the *data-wiring, routing, auth, and flow logic* on top: the route table, Steward providers, `api-client.ts`/`api-fetch-bridge.ts`, `lib/data/*` React-Query hooks, the crypto/checkout flows, the connector setup forms, the admin ops dashboards, and the hosted token pages.

**Implication:** porting is mostly *re-hosting thin glue* against components that already live in the shared package — not rebuilding UI.

### 1.3 The app already has the connection machinery

From `packages/ui` + `packages/app-core`:
- **Active-server model** (`state/persistence.ts`): `PersistedActiveServer { id, kind:"local"|"cloud"|"remote", label, apiBase?, accessToken? }` in `localStorage["elizaos:active-server"]`. The `cloud:<agentId>` id format is exact and load-bearing.
- **Base-URL indirection** (`api/client-base.ts`): REST, WS (`/ws?token=`), and SSE (`streamChatEndpoint`) all derive from one `baseUrl`. `setBaseUrl()`/`setToken()` switch servers; boot restore in `state/startup-phase-restore.ts`.
- **Two cloud connection bases**:
  - *Shared tier:* `${cloudApiBase}/api/v1/eliza/agents/<agentId>` (REST/SSE adapter, no `/ws`; `shouldTreatAsConnectedWithoutWebSocket()` handles this). Good enough to boot into chat.
  - *Dedicated tier:* `https://<agentId>.elizacloud.ai` (the container's own full runtime: real `/ws`, full `/api/conversations`). Reached via the CF Worker → `dedicated-agent-proxy.ts` (validates cloud token, swaps to the container's `ELIZA_API_TOKEN`) → agent-router daemon → tailnet → container.
- **`/pair` SSO handoff** (`app-core/src/api/cloud-pair-route.ts`): server-side exchange of a one-time pairing token for the agent's API key, pinned to `window.__ELIZAOS_API_TOKEN__`. `openWebUIWithPairing` already opens the full Eliza app against a container (today via a popup to the subdomain).
- **Settings-section registry** (`packages/ui/src/components/settings/`): `registerSettingsSection()` + a pinned meta list of 16 built-in sections in groups `agent | system | security`. **This is the natural home for cloud panels.**

### 1.4 Cloud already partly lives in the app's settings

- `CloudAgentsSection.tsx` — cloud agent list/switch/create/rename/delete via the typed `client`, backed by `/api/v1/eliza/agents`.
- `ElizaCloudDashboard.tsx` (`CloudDashboard`) — **account + billing, but buried inside the `ai-model` section's CloudPanel**, not its own section.
- `AppsManagementSection.tsx` — **local installed apps** (different object from cloud OAuth apps).
- `ConnectorsSection.tsx` — **local-process connectors** (different backend from cloud-hosted connectors).

These overlaps are a *reconciliation* problem (same names, different objects), not a clean bolt-on. See §4.6.

### 1.5 Backend: "doesn't change much" — validated

- ~570 file-routed Hono endpoints (Next-App-Router-style codegen in `cloud-api/src/_router.generated.ts`). `/api` (legacy/auth/billing) vs `/api/v1` (resource API) split is historical, same Worker.
- Auth resolution (`cloud-shared/src/lib/auth/workers-hono-auth.ts`): precedence `X-API-Key` → `Bearer eliza_*` → **Steward JWT (HS256, tenant-scoped, no aud/iss)** → cookie `steward-token`. **Token is host-independent** — moving origin doesn't break verification (same `STEWARD_JWT_SECRET` + `STEWARD_TENANT_ID`).
- The SDK (`cloud-sdk`) is an absolute-base-URL header-token client (servers/CLI/agent-runtime). **cloud-frontend does NOT use it**; it uses same-origin `/api` + cookie + localStorage-JWT. The merged app can adopt the SDK for typed agent/inference calls but the *session* layer is handled outside it.
- **No backend→frontend coupling** to sever. Dashboard-aggregation endpoints (`/api/v1/dashboard`, `/api/analytics/*`, `/api/stats/account`) are generic.
- **What an origin move would break** (avoided by Topology A): CORS allowlist (`cloud-shared/.../cors/cloud-api-hono-cors.ts` + `utils/cors.ts`), cookie domain (`.elizacloud.ai`), the steward-session CSRF Origin allowlist (`PERMITTED_ORIGIN_HOSTS`, duplicated across 3 route files), and redirect/email-link bases in `wrangler.toml`.

### 1.6 Two pre-existing backend bugs (found during research — fix in-flight)

1. `/api/v1/{approval-requests,ballots,sensitive-requests}` are **not** in the auth allowlist (`cloud-api/src/middleware/auth.ts publicPathPrefixes`) → the global `authMiddleware` 401s sessionless visitors before the handler. Masked because e2e mocks every `/api/**`.
2. `sensitive-requests` GET/submit call `requireUserOrApiKeyWithOrg` unconditionally → the URL/body token-actor path (which the *service* supports via `authorizeSubmit`) is unreachable from the route. The local app-core twin (`app-core/src/api/sensitive-request-routes.ts`) does token-only public submit correctly — port that pattern.

These block the **public** token pages. The **in-app** owner path already works (`owner_app_inline` delivery → `SensitiveRequestBlock` in `packages/ui/src/components/chat/MessageContent.tsx`).

---

## 2. Target architecture & information architecture

### 2.1 The end state in one paragraph

`elizacloud.ai` **is the Eliza app**. A visitor hits marketing (kept on `eliza.app` + a slim apex landing), signs in once (Steward), and is dropped **straight into their agent** — the full Eliza chat/view experience connected to their hosted container. There is no second dashboard UI. "Cloud" is a set of **in-app surfaces**: agent management, Settings sections (Billing, API keys, Profile, Connectors, Organization, Security, plugin grants, Monetization), a small number of **standalone views** (Applications/cloud-OAuth, API Explorer, Analytics), and **agent-scoped views** (Documents/knowledge, inline approvals). Public, link-shareable, and OAuth/redirect routes stay at their existing paths inside the same app. Admin business-ops fold in behind a role gate; infra-ops stays an internal console.

### 2.2 Navigation / IA

The app's existing tab/view groups (`ALL_TAB_GROUPS`: Chat, Phone, Views, Character, Wallet, Browser, Stream, Automations, Settings) gain cloud surfaces without inventing a parallel "dashboard." Proposed top-level IA:

```
Eliza app (signed in, cloud agent connected)
├── Chat                         ← floating ContinuousChatOverlay (always present) = the agent
├── Agents (Instances)          ← CloudAgentsSection promoted to a first-class view; create/start/stop/sleep/wake/snapshot/restore/delete, status, logs, "open"
│     └── Agent detail          ← wallet / transactions / policies / backups / logs (from cloud agents/[id])
├── Views                        ← existing view catalog (per-agent GUIs)
├── Documents (Knowledge)        ← agent-scoped: upload/list/query per character
├── Applications                 ← cloud OAuth apps (standalone view; 8 sub-tabs) — distinct from local "Apps"
├── Analytics                    ← per-user usage/cost (canonical; weekly bug fixed)
├── API Explorer                 ← developer console (auth-gated)
├── Approvals                    ← in-app pane: pending approvals / sensitive requests / ballots for *my* agents
└── Settings
      ├── Agent:   Identity · AI model · Voice · Capabilities · Connectors* · Apps(local)
      ├── Cloud:   Account & Profile · Billing & Credits · API keys · Applications(link) · Monetization(Earnings+Affiliates) · Organization
      ├── System:  Runtime · Appearance · Remote plugins · Wallet/RPC · Updates · Advanced
      └── Security: App permissions · Plugin grants · Secrets(Vault) · Sessions · Privacy/DSR · Audit
(* Connectors: reconcile local-process vs cloud-hosted — see §4.6)
Admin (role-gated): Moderation · Redemptions · RPC status   [Infra/Metrics → separate internal ops console]
```

### 2.3 Connection model (the core experience)

After login, the join flow runs `selectOrProvisionCloudAgent()` and writes a `PersistedActiveServer`:
- **Default (fast):** shared-tier base `${cloudApiBase}/api/v1/eliza/agents/<id>` → instant chat, REST/SSE.
- **Full experience (dedicated):** when the agent is a dedicated container, set base to `https://<agentId>.elizacloud.ai` so the full runtime lights up (real `/ws`, full `/api/conversations`). Requires the trust gate (`isTrustedApiBaseUrl` in `packages/app/src/main.tsx`) to accept the subdomain and the container WS-auth flag.
- The resume/self-healing loop (202 + `Retry-After` from `pairing-token` / `dedicated-agent-proxy`) is already exposed; the app drives it on connect.

### 2.4 Auth model (two modes, both already exist)

- **Hosted web (`elizacloud.ai`):** standardize on the **Steward JWT**. Same-origin with the API (via the existing Pages `_proxy.ts`), so the cookie/CORS/CSRF allowlists keep working untouched. The app reads `localStorage.steward_session_token` (helper in `packages/shared/src/steward-session-client`) and sends Bearer + `credentials:include`. The full Steward login surface (passkey/email/OAuth/wallet) renders in-app (it already lives in `cloud-ui`/`AuthorizeContent` + `pages/login`).
- **Native (desktop/mobile, `capacitor://localhost` / loopback):** keep the **device-code → API key** flow (already allowlisted in CORS). The `/auth/cli-login` page becomes an in-app route the device-code flow still targets, OR the native app uses `app-auth/connect` → one-time code. No regression to native.

This dual mode is a feature, not debt: hosted web gets the seamless same-origin Steward session; native keeps the token handoff it needs across origins.

---

## 3. What moves where — the master mapping

Legend: **SECTION** = Settings section · **VIEW** = standalone app view · **AGENT-VIEW** = agent-scoped view · **PUBLIC** = keep as public/standalone route in the app · **ADMIN** = role-gated · **DROP** = delete. Difficulty L/M/H. "cloud-ui" = presentational pieces already in `packages/ui/src/cloud-ui`.

| Cloud surface (cloud-frontend) | Destination | Diff | Notes |
|---|---|---|---|
| Landing `/`, `/os`, `/blog`, `components/landing/*` | Marketing (stay on `eliza.app`; apex `/` = slim "open app") | L | Don't fold OS/blue marketing in. Drop `BayerDitheringBackground`, `Tweet.tsx`. |
| `bsc`, `terms-of-service`, `privacy-policy` | PUBLIC routes in app (cheap static) | L | Linked from email/app. |
| `login`, `auth/{success,error,cli-login,callback/email}`, `app-auth/authorize` | Join flow + PUBLIC routes (same paths) | M | `AuthorizeContent` already in cloud-ui. `/auth/cli-login` kept for native device-code. |
| `invite/accept` (+`/accept-invitation`) | PUBLIC route (same path) | M | Org invite; reuse `returnTo`. Drop dead `pending-invite-token` write. |
| `dashboard/agents` (Instances) + `[id]` + `[id]/chat` | VIEW (Agents) — promote `CloudAgentsSection`; add detail tabs | M | Bridge chat replaced by real connect→chat. Add sleep/wake to UI (backend already supports). |
| `dashboard/my-agents` + `components/my-agents/*` | Merge into Agents view (character library) | M | Reconcile with local apps/agents concepts. |
| `dashboard/api-keys` (+ delete duplicate `settings apis-tab`) | SECTION (API keys) | L | `ApiKeysTable`/`Summary` in cloud-ui. Fix dead "copy stored key". |
| `dashboard/apps` + `[id]` (8 tabs: overview/monetization/earnings/domains/analytics/promote/users/settings) | VIEW (Applications) | H | cloud-OAuth apps ≠ local `AppsManagementSection`. Drop/ wire static promote tiles. |
| `dashboard/billing` (+ success) + shared `BillingTab` + `direct-crypto-credit-card` | SECTION (Billing & Credits) | H | Drop the `/dashboard/billing` wrapper (dupes settings tab). Keep crypto behind lazy wallet providers. |
| `dashboard/invoices/[id]` | Sub-view/drawer of Billing | L | Read-only receipt. |
| `pages/payment/*` (request, app-charge, success) | PUBLIC routes (same paths) | H-if-forced | External/unauthenticated payers; the id *is* the link; `/payment/success` is the provider redirect target. **Keep.** |
| `dashboard/earnings` (redemptions) + `dashboard/affiliates` | SECTION (Monetization) | M-H | Real on-chain payout + referral. Merge affiliates into earnings. |
| `dashboard/account` + `settings general-tab` | SECTION (Account & Profile) | M | Merge ProfileForm; drop stub SecurityPreferences. |
| `settings connections-tab` (Google/MS/Discord/Telegram/Twilio/WhatsApp/Blooio) | VIEW or SECTION (Connectors/Integrations) | H | cloud-hosted ≠ local `ConnectorsSection`. `ConnectionCard` in cloud-ui. Fix MS blue palette. |
| `settings organization-tab` (members + invites) | SECTION (Organization) | M-H | RBAC owner/admin/member; plural `/api/organizations/*`. No rename exists. |
| `dashboard/security` (sessions/MFA/privacy/DSR/audit) + `permissions` (plugin grants) | SECTION (Security) + SECTION (Plugin grants) | L | Cleanest area (uniform `api<T>`, 404-graceful). Right home for delete-account/DSR. |
| `dashboard/analytics` | VIEW (Analytics) — fix weekly bug; drop `settings analytics-tab` | L-M | Per-user. Distinct from admin/metrics. |
| `dashboard/api-explorer` | SECTION (Developer) or VIEW (auth-gated) | M | Mints explorer key, billed calls. Not public. |
| `dashboard/documents` | AGENT-VIEW (Knowledge) | M | Per-character; selector is the scope. |
| `approve/[id]`, `sensitive-requests/[id]`, `ballot/[id]` | PUBLIC routes **+** in-app Approvals pane | M-H | Dual-surface by design. Fix the 2 backend auth bugs (§1.6). In-app owner path already partly ships. |
| `chat/[characterRef]` (public shared chat) | PUBLIC route (same path) | M | No-login funnel; uses `ElizaPageClient`. |
| `dashboard/admin/{Page=moderation,redemptions,rpc-status}` | ADMIN (in-app, role-gated) | M | Consolidate the 4 dev-bypass conventions + 2 admin hooks into one gate. |
| `dashboard/admin/{infrastructure,metrics}` | Separate internal ops console | H | super_admin; infra routes 501-stubbed (`ssh2` Node-only). Adds nothing to consumer app. |
| `components/canvas/*` (17K LOC) + `cloud-assistant-agent.ts` + `canvas-store.ts` | **DROP** | — | App shell/view/overlay supersedes it. Only `webgpu-bg.tsx` trivially liftable. |
| `dashboard/assistant-concepts` (+ generator + SVGs) | **DROP** | — | Static 100-mockup larp gallery. |
| `dashboard/mcps` (`demoMcpServers`) | **DROP** (rebuild later vs real registry) | — | Hardcoded demo catalog, no list/CRUD API. |
| `sandbox-proxy` | **DROP** (verify App Builder SDK owner first) | L | Prod-inert dev relay. |
| Dead: `BayerDitheringBackground`, `Tweet.tsx`, `bsc/attach-wallet-card`+`use-attach-wallet`, canvas `index.ts`/`workspace-panel`/`webgpu-bg` barrel, `lib/deploy-character.ts`, `sidebar-item/section`, `security/index.ts`+`RetentionCountdown`, `pending-invite-token` write, `app-promote` fake tiles | **DROP** | L | Zero-importer / knip-confirmed. |

### 3.1 Systemic refactors that ride along (apply during each port)

- **Raw `fetch()` → typed `client`/`api<T>`**, and **`window.location.reload()` → React-Query `invalidateQueries`** across nearly every cloud mutation (api-keys, apps, billing, account, connectors, earnings, documents). This is the dominant per-surface work item.
- **Hand-rolled DTOs → `@elizaos/cloud-shared` types** on the hosted token pages (payment/approve/ballot/sensitive/invite/public-chat) — contract-drift cleanup.
- **Collapse duplicates:** api-keys page vs `apis-tab`; `/dashboard/billing` vs settings billing tab; analytics page vs `analytics-tab`.
- **Settings sections are zero-arg components** — ported sections self-load via hooks (e.g. `useUserProfile()`), not props.

---

## 4. UX/UI design

### 4.1 Design principles

1. **The agent is the home, not a dashboard.** First meaningful screen post-login is the agent (chat + views), never a table.
2. **Cloud is plumbing, surfaced as settings.** Billing/keys/org/security are "set and forget" — they belong in Settings, reachable but not in the user's face.
3. **One visual language.** Reuse `cloud-ui` + app tokens; orange accent only, neutral→neutral-opacity hover, no blue (fix the MS-connector blue tone). Enforced by the app's own aesthetic-audit gate.
4. **Progressive disclosure.** Developer/monetization/admin surfaces are present but tucked behind clear entry points; a casual user never sees API Explorer or Earnings unless they look.
5. **Local-first parity.** Every cloud surface degrades gracefully when the active server is local/remote (the security area's 404-graceful pattern is the model).

### 4.2 The join experience (the headline UX)

**New user (web):**
```
eliza.app (marketing)  ──"Open Eliza"──▶  elizacloud.ai
   └▶ Steward login (passkey/email/OAuth/wallet) — in-app, full-screen
        └▶ [JIT] backend syncUserFromSteward already created user+org+credits+default character
             └▶ select-or-provision cloud agent (shared tier = instant)
                  └▶ land in CHAT with the agent  (Views/Settings one tap away)
```
No "No agents yet" empty table. A brand-new user is talking to an agent within seconds.

**Returning user (web):** active-server restore → straight to chat. Switching agents = the Agents view.

**Native (desktop/mobile):** `CompactOnboarding` keeps its local/cloud/remote choice; the cloud branch runs the device-code handshake (unchanged) and lands in chat. This is already the live behavior.

**Deep links (must all resolve in-app at the same path):** `/dashboard*`, `/auth/cli-login`, `/auth/callback/email`, `/auth/success`, `/app-auth/authorize`, `/invite/accept`, `/payment/*`, `/chat/:characterRef`, `/approve/:id`, `/ballot/:id`, `/sensitive-requests/:id`, legal, `/bsc`. (Backend issues these via `NEXT_PUBLIC_APP_URL`; see §6.)

### 4.3 Settings IA (card-sorted groups)

Three groups already exist (`agent | system | security`); add a **Cloud** group. Each cloud section is a `registerSettingsSection()` registration so it composes with the existing pinned meta list (the `cloud-agents` section already does exactly this at order 1.5). Sections: Account & Profile, Billing & Credits (+ invoices drawer), API keys, Applications (entry → the Applications view), Monetization (Earnings + Affiliates), Organization. Security group gains Sessions/Privacy-DSR/Audit and a Plugin-grants section.

### 4.4 Wireframe sketches (textual)

- **Agents view:** header (credits chip + "New agent"); grid of agent cards (status dot, tier badge shared/dedicated, last-active); card menu start/stop/sleep/wake/snapshot/restore/delete/open; click → detail (overview/wallet/transactions/policies/backups/logs).
- **Billing section:** credit balance + buy (card/crypto toggle) · pay-as-you-go · auto-top-up · invoices table (row→drawer) · direct-crypto behind lazy wallet providers.
- **Applications view:** list (+create with name-check) → detail tabs overview/monetization/earnings/domains/analytics/users/settings (drop the larp promote tiles or wire them).
- **Approvals pane:** tabs Approvals / Sensitive / Ballots; each lists *my* agents' pending items with inline action; deep-links from chat blocks.

### 4.5 Component reuse vs build

- **Reuse (low cost):** `DashboardShellLayout`/`Sidebar`, `ApiKeysTable`/`Summary`, `AppsListView`, `EarningsSimulator`/`RevenueFlowDiagram`, `ConnectionCard`, `OpenApiViewer`, `LogViewer`, `AuthorizeContent`, analytics cards, theme provider, the Next→router shims.
- **Build/port (high cost):** billing+crypto checkout, connector setup forms (7 connectors + 2 hooks), org members/invites, admin ops, the apps 8-tab orchestration, documents upload/query, the join-flow controller wiring.

### 4.6 The reconciliation problem (must decide in design, not code)

Same names, different objects — these need explicit IA decisions:
- **Apps:** local installed apps (`AppsManagementSection`) vs cloud OAuth apps (`dashboard/apps`). Recommend: rename one. e.g. local = "Mini-apps/Plugins," cloud = "Applications (developer)."
- **Connectors:** local-process connectors (`ConnectorsSection`: BlueBubbles/iMessage/Signal/local Discord/Telegram) vs cloud-hosted connections (`connections-tab`: Google/MS/Twilio/WhatsApp/Blooio + cloud Discord/Telegram). Recommend: one "Connectors" surface that branches by active-server kind (local vs cloud), so the user sees the connectors that actually apply to where their agent runs.
- **Account/billing:** `ElizaCloudDashboard` (buried in ai-model) is superseded by the new Billing + Account sections — relocate and delete the buried panel.

---

## 5. User research plan

### 5.1 Personas

1. **New-to-Eliza web visitor** — wants an agent now; cares only about time-to-first-message.
2. **Returning cloud user** — has an agent; wants to resume + occasionally manage billing/keys.
3. **Developer** — building an app on Cloud; cares about API keys, API Explorer, Applications, monetization markup.
4. **Creator** — monetizing a published agent/app/MCP; cares about Earnings/redemptions, affiliates, public chat link.
5. **Org admin** — manages members/invites/roles/billing.
6. **Local-first / privacy user** — runs the agent on-device; cloud is optional; must not be forced.
7. **Operator (internal)** — moderation, redemptions, infra.

### 5.2 Research questions

- Does dropping users straight into chat (vs a dashboard) improve time-to-first-message and D1 retention?
- Can users find Billing / API keys / Org settings when they're folded into in-app Settings (vs a dedicated dashboard nav)?
- Do developers/creators still discover Applications/API Explorer/Earnings without a "developer dashboard" landing?
- Does the merged surface confuse local-first users about what's cloud vs local (esp. the apps/connectors reconciliation)?
- Do deep links from emails/Stripe/OAuth land correctly and feel native (not "I left the app")?

### 5.3 Methods

- **Funnel analytics** (already have `/api/v1/track/pageview`, analytics endpoints): instrument join funnel marketing→login→agent-connected→first-message; compare to the current login→`/dashboard/agents` funnel. Primary metric: **time-to-first-message** and **% reaching first message**.
- **Moderated usability tests** (6–8 per persona) on: (a) the new join flow, (b) "find and update your billing/API key," (c) "invite a teammate," (d) "publish + share an agent." Success = task completion without help; SUS.
- **Card sort / tree test** for Settings IA before building (validate §4.3 groupings).
- **A/B** at cutover: keep a fraction on the old `/dashboard` (if feasible behind a flag) vs new app; measure retention + support tickets.
- **Dogfood** internally first (operators + creators), 1–2 weeks, behind a flag.

### 5.4 Success metrics / definition of UX success

- ↑ % of new users reaching first message; ↓ median time-to-first-message.
- No regression in task-completion for billing/keys/org vs the old dashboard.
- ↓ "where is X" support tickets after 30 days.
- D1/D7 retention flat-or-up post-cutover.
- Deep-link success rate ≈ 100% (no 404s on backend-issued URLs).

---

## 6. Deployment & cutover

### 6.1 Recommended: Topology A — app at the `elizacloud.ai` apex

Replace the `cloud-frontend` Pages deploy with a **`packages/app` web build** in the **same Cloudflare Pages project `eliza-cloud`** (apex `elizacloud.ai`), reusing the existing `functions/_middleware.ts` + `_proxy.ts` same-origin `/api`+`/steward` proxy to `api.elizacloud.ai`.

- **Backend env unchanged** (`NEXT_PUBLIC_APP_URL=https://elizacloud.ai`, etc.) — the dozens of `${NEXT_PUBLIC_APP_URL}/...` call sites keep working untouched.
- **CORS/CSRF/redirect allowlists unchanged** — same apex origin. `capacitor://localhost`/`http://localhost` already present for native.
- **Agent-subdomain routing unchanged** — the Worker still owns `*.elizacloud.ai/*` and 308s `www`/`app` → apex.
- **Obligation:** the app must serve **every SPA route path** the backend/email/Stripe/OAuth issue (see the deep-link list in §4.2) and carry over the internal `<Navigate>` redirect map (`/dashboard/build/*`→my-agents, `/dashboard/image|video|gallery`→api-explorer, containers→agents, etc.).
- **New work:** the app gets a **web router** that maps these paths into the tab/view system (today the app reads `window.location` → tab; we extend it to handle the full path set, or mount a thin react-router layer for the public/auth/payment paths alongside the tab system).

Alternatives considered: **B** (app at `app.elizacloud.ai`) drags in Worker route carve-out + `redirectFrontendHost` rework + full env/CORS/redirect sweep + a redirect layer for every link already in the wild — rejected. **C** (marketing at apex, app behind it) keeps backend unchanged but complicates front-end routing — viable fallback.

### 6.2 Deep-link contract (must-serve paths)

Backend-issued (each breaks if absent): `/dashboard`, `/dashboard/billing`, `/dashboard/settings?tab=connections`, `/invite/accept?token=`, `/payment/success|cancel`, `/payment/:id`, `/payment/app-charge/:appId/:chargeId`, `/auth/success`, `/auth/callback/email`, `/auth/cli-login`, `/app-auth/authorize`, plus `/chat/:characterRef`, `/approve/:id`, `/ballot/:id`, `/sensitive-requests/:id`, `/bsc`, `/terms-of-service`, `/privacy-policy`. Source: `cloud-shared` email/redirect/oauth services + `wrangler.toml` (see research report §3 for exact call sites).

### 6.3 SSR/prerender

cloud-frontend prerenders only the landing route for FCP/LCP. The app is CSR. If the apex `/` stays a marketing-ish landing, either keep a tiny prerendered landing or redirect `/` → app shell. Not a blocker; decide in Phase 1.

---

## 7. Phased implementation plan

Each phase is independently shippable and verifiable. Phases 1–7 happen **before** the cutover (Phase 8); cloud-frontend stays live throughout until Phase 8.

- **Phase 0 — Decisions & scaffolding.** Lock Topology A; resolve the apps/connectors naming reconciliation (§4.6); add the "Cloud" settings group + Approvals/Applications/Analytics view stubs; add a web-router layer to the app that can serve arbitrary paths into the tab/view system. Fix the 2 backend auth bugs (§1.6).
- **Phase 1 — Hosted-web app + auth.** Stand up `packages/app` web build deployable to a Pages preview; wire Steward JWT auth for the hosted-web mode (read `steward_session_token`, Bearer + credentials); render the in-app Steward login; serve `/auth/*` + `/app-auth/authorize` + `/login`. Verify against `api-staging`.
- **Phase 2 — Join flow.** Marketing→login→`selectOrProvisionCloudAgent`→chat. Default-land-in-chat; kill the dashboard-table landing for web. Keep native `CompactOnboarding`.
- **Phase 3 — Settings sections.** Port (reusing cloud-ui, converting raw-fetch→typed client): API keys, Billing+invoices, Account & Profile, Security + Plugin-grants, Organization, Monetization (Earnings+Affiliates). Delete duplicates (apis-tab, billing wrapper).
- **Phase 4 — Standalone views.** Applications (cloud OAuth, 8 tabs), API Explorer, Analytics (fix weekly bug). Connectors view (reconciled local/cloud).
- **Phase 5 — Agent views.** Documents/Knowledge (per-character); Approvals pane (in-app owner path) + keep public approve/ballot/sensitive routes.
- **Phase 6 — Admin split.** Moderation/redemptions/rpc-status in-app behind one consolidated role gate; infra/metrics moved to (or left as) a separate internal ops console.
- **Phase 7 — Drop.** Canvas subsystem, assistant-concepts, MCP demo, sandbox-proxy, all dead code (§3 DROP rows). Public payment/chat routes ported.
- **Phase 8 — Cutover.** Point the apex Pages project at the app build; carry over the `<Navigate>` redirect map; smoke-test the entire deep-link contract against prod; canary/flag rollout; keep an instant rollback to the cloud-frontend deploy.
- **Phase 9 — Decommission.** Remove `packages/cloud-frontend` once the app has served apex traffic cleanly for an agreed window; clean up its CI workflow; update docs.

**Verification each phase:** `bun run verify` (typecheck+lint) + `bun run test` for touched packages; the app's aesthetic-audit gate for any UI; per-page manual review verdicts; deep-link smoke tests; e2e against `api-staging`. `/phase-review` at each boundary.

---

## 8. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Two-origin auth (hosted-web Steward vs native device-code) introduces divergent paths/bugs | High | Keep native unchanged; add Steward only for hosted-web same-origin; shared helper in `packages/shared`; test both modes in CI. |
| R2 | A backend-issued deep link 404s in the app after cutover (broken email/Stripe/OAuth link) | High | Enumerate the full contract (§6.2); automated deep-link smoke test gating Phase 8; carry the `<Navigate>` map verbatim. |
| R3 | Public token pages (payment/approve/ballot/sensitive) break for unauthenticated visitors | High | Fix the 2 backend auth bugs early (Phase 0); keep these as public routes; e2e with real sessionless requests (not mocked `/api/**`). |
| R4 | Bundle bloat — cloud adds wallet/crypto (wagmi/RainbowKit/Solana), recharts, Monaco-ish viewer, three (canvas dropped) | Med-High | Lazy-load wallet providers (already gated by route in cloud-frontend); code-split each view; drop canvas/three; respect the existing load/perf KPI harness. |
| R5 | Multi-actor churn on `develop` (shared working tree; heavy CI never completes) | Med | Land in focused commits; verify via local suite runs not CI status; coordinate with other actors (per project memory). |
| R6 | Apps/Connectors naming collision confuses users (local vs cloud) | Med | Resolve in §4.6 *before* building; card-sort validate; branch surfaces by active-server kind. |
| R7 | Raw-fetch→typed-client + reload→invalidate rewrite introduces regressions across many surfaces | Med | Port surface-by-surface behind flags; keep cloud-frontend as the live fallback until Phase 8; e2e per surface. |
| R8 | Admin infra is 501-stubbed (`ssh2` Node-only on Workers) — moving it adds non-functional UI | Med | Don't move infra into the consumer app; leave/relocate as internal ops console; consolidate the role gate. |
| R9 | SSR/prerender loss hurts apex FCP/LCP/SEO | Low-Med | Keep a tiny prerendered landing or marketing on `eliza.app`; measure. |
| R10 | Steward token lifecycle (refresh/expiry) differs from app's token assumptions | Med | Reuse cloud-frontend's `AuthTokenSync` refresh logic; honor `exp`; same-origin cookie refresh path intact under Topology A. |
| R11 | Dedicated-container full experience needs trust-gate + WS-auth flag changes | Med | Add subdomain to `isTrustedApiBaseUrl`; set/verify `ELIZA_ALLOW_WS_QUERY_TOKEN` on dedicated images; fall back to shared-tier REST chat if WS unavailable. |
| R12 | Visual regressions / brand violations during port (e.g. MS-connector blue) | Low-Med | App aesthetic-audit gate; fix known blue tone; per-page review verdicts. |

---

## 9. Open questions for the owner

1. **Apex = app?** Confirm Topology A (app *is* `elizacloud.ai`, marketing stays on `eliza.app`). This is the lowest-risk and avoids all backend env/CORS churn.
2. **Marketing landing:** at the apex `/`, do we want a slim landing or an immediate redirect into the app for signed-in users (current behavior redirects authed→dashboard)?
3. **Apps/Connectors naming** (§4.6): pick the rename so local vs cloud objects stop colliding.
4. **Admin:** confirm moderation/redemptions move in-app (role-gated) and infra/metrics stay a separate internal console.
5. **MCPs:** confirm DROP the demo now, rebuild against a real registry later (vs keep a stub).
6. **Native auth:** keep device-code for desktop/mobile as-is (recommended), or invest in unifying on Steward across all targets?
7. **Decommission window:** how long must cloud-frontend remain instantly rollback-able after cutover?

---

*(Self-critique and second revision follow in CRITIQUE.md / appended below.)*
