# Cloud frontend — e2e coverage gaps

Generated 2026-05-21 as part of the visual + e2e review loop. See
[AGENTS.md](../AGENTS.md) for the manual-review protocol and
`tests/e2e/aesthetic-audit.spec.ts` for the screenshot harness.

## Inventory of current e2e specs

| spec | scope | status |
| --- | --- | --- |
| `aesthetic-audit.spec.ts` | Screenshots every route, desktop + mobile, into `aesthetic-audit-output/`. | Active — extended in loop 1. |
| `agent-flow.spec.ts` | Landing → login → create agent → chat (single happy path). | Active. |
| `api-explorer-flow.spec.ts` | Search, auth, request tester, response render, OpenAPI export. | Active. |
| `api-key-flow.spec.ts` | Create key → copy → clipboard contains plaintext. | Active. |
| `auth-local-cloud.spec.ts` | Local-app → cloud auth handshake. | Active behind `TEST_API_KEY`. |
| `brand-flows.spec.ts` | Brand surfaces. | Active. |
| `cloud-routes*.spec.ts` | Legacy redirects, anonymous protected-route gating. | Active. |
| `direct-crypto-flow.spec.ts` | `/bsc` purchase + verify-wallet states. | Active. |
| `live-*` | Live-prod smoke (`CLOUD_E2E_LIVE_URL`). | Active in CI nightly. |
| `route-coverage.spec.ts` | Reachability of every page component from the router. | Active. |
| `settings-tabs-flow.spec.ts` | Settings tab nav + general form save. | Active. |
| `siwe-flow.spec.ts` | Injected-ethereum SIWE happy path. | Active (mocks `window.ethereum`). |
| `siws-wallet-flow.spec.ts` | Solana SIWS happy path. | Active. |
| `solana-login.spec.ts` | `/login` Solana UI. | Active. |
| `view-switching.spec.ts` | My-agents grid/list toggle. | Active. |
| `visual.spec.ts` | Pixel-diff baseline. | Active. |

The injected-ethereum login is mocked end-to-end in `siwe-flow.spec.ts`
(`window.ethereum` shim) and is the reusable on-ramp for any
authenticated-page e2e. New specs that need an authed session should
import or duplicate that pattern rather than rolling their own.

---

## Gaps — by page

For each gap: **what to test**, **how to test it** (the injected-eth
session, the selector, the assertion).

### Public

#### `/` (landing)
- **Header CTA → /login** — assert anchor href + click → `/login`.
- **Hero primary CTA** — click → expected route.
- **Footer link grid** — `for each link in footer { expect(href).toMatch(...) }`.

#### `/login`
- ✅ siwe-flow + solana-login cover happy paths.
- **Gap: error states** — wallet user rejects signature → toast / inline
  error visible. Mock `signMessage` to reject; assert error region.
- **Gap: email magic-link path** — submit email → success page reached.

#### `/bsc`
- ✅ direct-crypto-flow covers happy + verify + html-fallback.
- **Gap: wallet attach UI** (`src/pages/bsc/_components/attach-wallet-card.tsx`) — open card, mock
  connect, assert attached state.

#### `/chat/:characterRef` (public chat)
- **Gap: message send round-trip** — inject mock SSE; type message, submit, assert assistant message rendered.
- **Gap: 404 state** when character missing.

#### `/auth/cli-login`
- **Gap: confirm flow** — click "Close Window", expect window.close called.

#### `/invite/accept`
- **Gap: valid invite token** — mock /api/invites/accept → assert
  redirect to dashboard.
- **Gap: invalid token** → error page.

#### `/payment/:paymentRequestId`
- **Gap: pay button states** — pending / paid / expired all render
  distinct UIs.
- **Gap: wallet button click** invokes pay handler with correct args (mock).

#### `/payment/app-charge/:appId/:chargeId`
- **Gap: provider grid click** — each provider tile (`grid` of orange-bordered buttons in `page.tsx:373`) navigates to the provider flow.

#### `/payment/success`
- **Gap: receipt fields** rendered when search params present; empty
  state when not.

#### `/sensitive-requests/:requestId`, `/approve/:approvalId`, `/ballot/:ballotId`
- **Gap: full approve / reject** — mock request, click approve, assert
  POST issued and success state shown. Same for reject.

#### `/app-auth/authorize`
- **Gap: scope grant flow** — list scopes, click authorize, assert redirect URL with code param.

#### `/sandbox-proxy`
- **Gap: target form** — fill URL, submit, assert iframe src updates.

#### `/terms-of-service`, `/privacy-policy`
- Static. Coverage: assert main heading exists, page title, last-updated
  date present. (Cheap regression net.)

---

### Dashboard

All dashboard tests should start by injecting the SIWE-mocked session
(reuse the helper from `siwe-flow.spec.ts`).

#### `/dashboard` (home)
- **Gap: card grid** — once `DASHBOARD_REDESIGN.md` lands, assert each
  card region (agents, credits, recent activity, etc.) is present with
  empty + populated states (parametrize fixture).
- **Gap: CTA links** on each card resolve to the right route.

#### `/dashboard/account`
- ✅ settings-tabs-flow partially covers via shared layout.
- **Gap: avatar upload** — file input, success toast.
- **Gap: handle rename** — submit, assert PUT.
- **Gap: delete-account dialog** — confirm gating.

#### `/dashboard/settings`
- ✅ settings-tabs-flow covers tab nav + general form.
- **Gap: per-tab forms** — notifications, integrations, API keys
  shortcut — each tab’s primary form submit + dirty-state guard.

#### `/dashboard/security`
- **Gap: 2FA enroll/disable** — fixtures for already-enrolled vs not.
- **Gap: session list** — revoke a session, assert removal.

#### `/dashboard/security/permissions`
- **Gap: permission grant/revoke** for an OAuth app.

#### `/dashboard/billing`
- **Gap: credit pack purchase** — pick pack, click pay, mock checkout, assert success path.
- **Gap: payment method add/remove**.
- **Gap: invoice list link → `/dashboard/invoices/:id`**.

#### `/dashboard/billing/success`
- **Gap: success state** with valid session id; error state without.

#### `/dashboard/agents`, `/dashboard/agents/:id`, `/dashboard/agents/:id/chat`
- ✅ agent-flow covers create → chat happy path.
- **Gap: agent edit** — name, bio, visibility toggle, save.
- **Gap: agent delete** — confirm dialog → assert removed.
- **Gap: chat input** — submit, assert SSE message stream, stop button.

#### `/dashboard/my-agents`
- ✅ view-switching covers grid/list toggle.
- **Gap: filter chips** — public/private, category filter narrows the list.

#### `/dashboard/apps`, `/dashboard/apps/create`, `/dashboard/apps/:id`
- **Gap: app create wizard** — fill required fields, submit, land on detail.
- **Gap: app monetization toggle** — flip flag, save.
- **Gap: app deploy** — click deploy button, mock container API, assert deploying state.
- **Gap: app delete**.

#### `/dashboard/api-keys`
- ✅ api-key-flow covers create + clipboard.
- **Gap: revoke** — click revoke, confirm dialog, assert row removed.
- **Gap: empty state** before any key exists.

#### `/dashboard/api-explorer`
- ✅ api-explorer-flow covers search / tester / openapi.
- **Gap: error responses** — 4xx / 5xx render structured error region.
- **Gap: auth header injected** when api-key selected.

#### `/dashboard/mcps`
- **Gap: enable/disable MCP** — toggle, assert PATCH.
- **Gap: connect new MCP** — flow + URL validation.

#### `/dashboard/documents`
- **Gap: upload** — file input, progress, completed state.
- **Gap: delete document**.
- **Gap: search bar** filters list.

#### `/dashboard/analytics`
- **Gap: date-range picker** changes chart data.
- **Gap: metric tiles** show correct values from fixtures.

#### `/dashboard/earnings`
- **Gap: payout request** — click claim, mock POST, assert pending state.
- **Gap: history table pagination**.

#### `/dashboard/affiliates`
- **Gap: referral link copy** — clipboard contains link.
- **Gap: stats table** rows render from fixture.

#### `/dashboard/invoices/:id`
- **Gap: pdf download button** triggers fetch.
- **Gap: line-item totals** sum correctly visually.

#### `/dashboard/chat`, `/dashboard/image`, `/dashboard/video`, `/dashboard/gallery`, `/dashboard/voices`
- **Gap: each media surface** — generate prompt → submit → assert media region updates. Use stubbed generation API.

#### `/dashboard/containers`, `/dashboard/containers/:id`, `/dashboard/containers/agents/:id`
- **Gap: deploy container** — click deploy, assert state machine: queued → deploying → running.
- **Gap: stop / restart / delete** — each terminal action confirmed via dialog and verified by polling fixture.
- **Gap: log tail** renders streaming log fixture.
- **Gap: backup panel** — `src/dashboard/containers/_components/eliza-agent-backups-panel.tsx` create / restore / delete backup flows.

#### `/dashboard/admin`, `/dashboard/admin/infrastructure`, `/dashboard/admin/metrics`, `/dashboard/admin/redemptions`
- **Gap: admin-only gate** — non-admin user redirected.
- **Gap: redemption approve/deny** flows.
- **Gap: infra dashboard** chart rendering with fixture metrics.

---

## Cross-cutting tests to add

1. **`hover-states.spec.ts`** — for every primary button on every route
   captured by aesthetic-audit, hover it and assert the computed
   `background-color` is in the allowed set (orange→darker-orange, or
   neutral→neutral-with-opacity). Fail on any `rgb(0, 0, 0)` /
   `rgb(255, 255, 255)` reached from a non-neutral resting state.
2. **`focus-rings.spec.ts`** — tab through each page, assert every
   interactive element has a visible focus outline.
3. **`blue-banned.spec.ts`** — assert no element on any captured route
   has a computed color matching `rgb(*, *, blue-ish)` in the hue range
   of standard tailwind `blue-*`. Mirror at the source level by
   `rg "blue-"` returning zero hits in `src/`.
4. **`mobile-layout.spec.ts`** — viewport 375×812 (`Pixel 5` already
   used), assert no horizontal scroll on any page and no element wider
   than the viewport.
5. **`auth-redirect.spec.ts`** — unauthenticated visit to every
   `/dashboard/*` route redirects to `/login` with `next=` param
   preserved. Mostly covered by `cloud-routes.spec.ts` — verify the list
   matches the current router.

## How to run

```bash
bun run --cwd packages/cloud-frontend audit:cloud      # extended aesthetic audit
bun run --cwd packages/cloud-frontend test:e2e         # all e2e
bun run --cwd packages/cloud-frontend test:e2e -- siwe # specific spec
```

Live-prod variant: `CLOUD_E2E_LIVE_URL=https://cloud.eliza.os ...`.
