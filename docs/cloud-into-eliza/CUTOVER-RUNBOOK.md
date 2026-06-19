# Cutover runbook — point `elizacloud.ai` at the Eliza app

**Topology A (DECISIONS.md D1):** the Eliza web app (`packages/app`) becomes the
production deploy of the existing Cloudflare Pages project at the apex, replacing
`packages/cloud-frontend`. **Single cutover** (DECISIONS.md D2): the full
experience is validated on a Pages preview against `api-staging` first, then the
apex flips once. cloud-frontend stays deployable the whole time for instant
rollback.

This runbook covers only the **deploy flip** — it assumes Phases 0–7 are landed
and validated on the preview. It does not cover building the in-app surfaces.

---

## 0. What does and does not change

| Thing | Changes at cutover? |
|---|---|
| Pages project name (`eliza-cloud`) | No — reused |
| Apex domain (`elizacloud.ai`) + DNS | No — already on the project |
| `API_UPSTREAM` env (`api.elizacloud.ai` prod / `api-staging.elizacloud.ai` preview) | No — same values, set on the project |
| Steward tenant pin (`NEXT_PUBLIC_STEWARD_TENANT_ID` on preview) | No — same value |
| Backend Worker (`cloud-api`), CORS/CSRF/redirect allowlists, cookie domain | No — same apex origin, same upstream (this is the whole point of Topology A) |
| Agent-subdomain routing (`*.elizacloud.ai`) | No — the Worker still owns it |
| **Pages build command + build output** | **Yes** — repointed from cloud-frontend's build to `packages/app`'s web build |
| **Same-origin proxy Functions** | Yes — served by `packages/app/functions/*` instead of `packages/cloud-frontend/functions/*` (byte-identical proxy logic) |
| **`_redirects` / `_headers`** | Yes — served from `packages/app/public/*` (SPA fallback + app-tuned CSP) |

Because origin, upstream, and the JWT secret are unchanged, **no backend
redeploy is required** and every `${NEXT_PUBLIC_APP_URL}/...` link the backend
already issues keeps resolving.

---

## 1. Prerequisites (gate the cutover — all must be true)

1. **Phases 0–7 landed** and the full experience validated on the Pages preview
   against `api-staging` (see DECISIONS.md revised phase order).
2. **Deep-link contract smoke test green** against the preview deploy:
   ```bash
   bun run --cwd packages/app build:web
   node packages/app/scripts/smoke-deeplinks.mjs https://<preview>.eliza-cloud.pages.dev
   ```
   Must report `… / … deep links resolved — contract intact` (exit 0). See §3
   for the contract and §2 for how the proxy/SPA-fallback is wired.
3. **Aesthetic-audit verdicts** for every touched/reachable page are `good`
   (no `needs-work` / `broken`). Orange accent only, no blue.
4. **Auth verified on the preview** for all three connection kinds
   (DECISIONS.md D3): Cloud = Steward (web same-origin cookie+JWT AND native
   Bearer), Local = loopback no-auth, Remote = device-code/pairing.
5. **The two backend auth bugs** (PLAN.md §1.6) are fixed and deployed to the
   backend (they gate the public approve / ballot / sensitive-request pages).
6. **Rollback rehearsed** — confirm you can repoint the Pages project back to
   cloud-frontend in one action (§5) and that cloud-frontend still builds.

---

## 2. The same-origin proxy + SPA fallback (how the app serves the contract)

The app reproduces cloud-frontend's hosting contract with files already added
under `packages/app`:

- `packages/app/functions/_middleware.ts` + `_proxy.ts` — Cloudflare Pages
  Function that reverse-proxies same-origin `/api/*` and `/steward/*` to the
  Workers API (`API_UPSTREAM`). Byte-for-byte the same logic as
  cloud-frontend's, so the Steward cookie/JWT stays first-party and there is no
  CORS preflight. Single global `_middleware.ts` (not `[[path]].ts`) to dodge
  the path-to-regexp v8 bug in the Pages runtime.
- `packages/app/public/_redirects` — `/assets/* → /index.html 404` (stale-asset
  MIME guard) then `/* → /index.html 200` (SPA fallback). Copied into `dist/` by
  Vite at build (the app's `publicDir` is `public/`).
- `packages/app/public/_headers` — edge CSP + caching (no-cache HTML, immutable
  hashed `/assets/*`, relaxed COOP on `/app-auth/*` for OAuth popups). Adds
  `wss://*.elizacloud.ai` + `https://*.elizacloud.ai` (dedicated-agent
  containers) vs cloud-frontend.
- `packages/app/wrangler.toml` — INERT description of the target Pages build;
  the live `eliza-cloud` project is repointed at cutover (§4), it does not
  create a second project.

> **Note on `vite preview`:** a plain `vite preview` of `dist/` does **not**
> apply `_redirects`, so unknown paths can 404 there. Run the smoke test against
> a real Cloudflare Pages preview (which honours `functions/` + `_redirects`) or
> an SPA-fallback static server. The Pages preview is the source of truth.

---

## 3. Deep-link contract (must all resolve — PLAN.md §6.2)

Every path below is backend-issued (email links, Stripe/OAuth redirects, shared
links) or otherwise in the wild. Each must resolve in the app at the **same
path** (SPA 200 shell, or a redirect into the app). `scripts/smoke-deeplinks.mjs`
asserts the full set automatically.

| Path | Source / purpose | Expected |
|---|---|---|
| `/` | apex landing / open-app | SPA |
| `/login` | Steward login surface | SPA |
| `/auth/cli-login` | device-code (Remote) handoff | SPA |
| `/auth/callback/email` | email magic-link callback | SPA |
| `/auth/success` | OAuth success redirect target | SPA |
| `/app-auth/authorize` | app OAuth authorize | SPA |
| `/invite/accept` (`?token=`) | org invite | SPA |
| `/payment/success` | payment provider redirect | SPA |
| `/payment/:paymentRequestId` | external payment request (id IS the link) | SPA |
| `/payment/app-charge/:appId/:chargeId` | app-charge payment | SPA |
| `/chat/:characterRef` | public shared chat (no-login funnel) | SPA |
| `/approve/:approvalId` | public approval link | SPA |
| `/ballot/:ballotId` | public ballot link | SPA |
| `/sensitive-requests/:requestId` | public sensitive-request link | SPA |
| `/dashboard` | authed landing — redirects to my-agents | SPA/redirect |
| `/terms-of-service` | legal | SPA |
| `/privacy-policy` | legal | SPA |
| `/bsc` | bsc promo | SPA |

Additional backend-issued shapes the SPA fallback covers (no extra config; the
`/*` rule serves them — the in-app router resolves the query/redirect):
`/dashboard/billing`, `/dashboard/settings?tab=connections`, `/payment/cancel`.

### 3.1 `<Navigate>` redirect map to carry over (from cloud-frontend `src/App.tsx`)

The app's client router must reproduce these in-app redirects so existing links
that point at removed/renamed routes still land somewhere sensible:

| From | To |
|---|---|
| `/dashboard` (index) | `/dashboard/my-agents` |
| `/dashboard/build/*` | `/dashboard/my-agents` |
| `/dashboard/apps/create` | `/dashboard/apps` |
| `/dashboard/chat` | (dashboard chat redirect) |
| `/dashboard/image` | `/dashboard/api-explorer` |
| `/dashboard/video` | `/dashboard/api-explorer` |
| `/dashboard/gallery` | `/dashboard/api-explorer` |
| `/dashboard/voices` | `/dashboard/api-explorer` |
| `/dashboard/containers` | `/dashboard/agents` |
| `/dashboard/containers/:id` | `/dashboard/agents/:id` |
| `/dashboard/containers/agents/:id` | `/dashboard/agents/:id` |
| `/accept-invitation` | `/invite/accept` (same handler) |
| `/checkout` | (Eliza OS checkout redirect) |

Carry the `location.search` (query string) through every redirect, as
cloud-frontend does, so `?token=` / `?tab=` survive.

---

## 4. Cutover procedure (single flip)

> Performed in the Cloudflare dashboard / via `wrangler` against the **existing**
> `eliza-cloud` Pages project. Do not create a new project.

1. **Freeze** — announce a short change window; stop merges that would change
   either deploy.
2. **Final preview validation** — re-run §1 gates against the latest preview
   build of `packages/app`. Smoke test green, audit green, auth green.
3. **Repoint the Pages project build** — set the `eliza-cloud` project's build
   to produce `packages/app`'s web build and serve `packages/app/dist`:
   - Build command: `bun run --cwd packages/app build:web`
     (runs Vite; copies `public/_redirects` + `public/_headers` into `dist/`).
   - Build output directory: `packages/app/dist`.
   - Functions: `packages/app/functions` (auto-detected by Pages).
   - Env vars on the project are unchanged (`API_UPSTREAM`,
     `NEXT_PUBLIC_STEWARD_TENANT_ID` on preview, `VITE_ENVIRONMENT`).
4. **Deploy to production branch** — trigger the production deploy from `main`.
5. **Verify against production apex:**
   ```bash
   node packages/app/scripts/smoke-deeplinks.mjs https://elizacloud.ai
   ```
   Must be green. Then manually spot-check:
   - Steward login → land in chat (new + returning user).
   - A real payment link, a shared `/chat/:ref` link, an `/approve/:id` link.
   - `/api/v1/...` proxied call returns from the Worker (Network tab, same-origin).
   - Agent-subdomain WS to a dedicated container connects.
6. **Watch** — error rates, 404 rate on the apex, support channel, for an agreed
   soak window (default per DECISIONS.md open item; treat 24–48h as the floor).

---

## 5. Rollback (instant — cloud-frontend stays deployable)

If any §4.5 check fails or error/404 rates spike during the soak:

1. **Repoint the `eliza-cloud` Pages project back to cloud-frontend:**
   - Build command: `bun run --cwd packages/cloud-frontend build`.
   - Build output directory: `packages/cloud-frontend/dist`.
   - Functions: `packages/cloud-frontend/functions`.
   - (These are the project's pre-cutover values — capture them BEFORE step §4.3
     so the rollback is a literal restore.)
2. **Redeploy production from `main`.** No backend change, no DNS change, no env
   change — origin and upstream are identical, so rollback is a deploy flip only.
3. **Confirm** the apex serves cloud-frontend again (its `/dashboard/agents`
   landing) and the smoke test passes against cloud-frontend's route set.
4. **Triage** the failure on a preview before re-attempting cutover.

Because nothing on the backend or DNS moved, rollback exposure is one Pages
deploy (minutes), not a multi-system revert.

---

## 6. Gate criteria (go / no-go checklist)

**GO only if all are true:**

- [ ] `scripts/smoke-deeplinks.mjs` green against the **preview** deploy.
- [ ] Aesthetic-audit verdicts `good` for every touched/reachable page; no blue.
- [ ] Auth verified on preview for Cloud (web + native), Local, Remote.
- [ ] The two backend auth bugs (PLAN.md §1.6) fixed + deployed.
- [ ] `<Navigate>` redirect map (§3.1) reproduced in the app's router.
- [ ] Rollback values for the Pages project captured (§5.1) and rehearsed.
- [ ] cloud-frontend still builds and is one flip away.

**Post-cutover, before declaring done:**

- [ ] `scripts/smoke-deeplinks.mjs` green against **production** apex.
- [ ] Manual spot-checks (§4.5) pass.
- [ ] Error / 404 rates flat through the soak window.

**Decommission cloud-frontend** (Phase 9) only after the app has served apex
traffic cleanly for the agreed window (DECISIONS.md open item).

---

## 7. Artifacts this runbook depends on

- `packages/app/functions/_middleware.ts`, `packages/app/functions/_proxy.ts`
- `packages/app/public/_redirects`, `packages/app/public/_headers`
- `packages/app/wrangler.toml` (target Pages config; inert until cutover)
- `packages/app/scripts/smoke-deeplinks.mjs` (the automated gate)
- `docs/cloud-into-eliza/PLAN.md` §6 (topology), §6.2 (contract)
- `docs/cloud-into-eliza/DECISIONS.md` D1 (Topology A), D2 (single cutover), D3 (auth)
