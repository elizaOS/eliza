# Cloud → Eliza migration — Self-critique & Second Revision

Companion to `PLAN.md`. Part A is an adversarial critique of the v1 plan. Part B is the revised plan (deltas that supersede v1).

---

## Part A — Self-critique of v1

**C1 — Routing was hand-waved.** v1 said "add a web-router layer that serves arbitrary paths into the tab/view system." But the app's navigation is a *flat tab enum* read from `window.location` (`tabFromPath()`), while the cloud routes are **parametric** (`/payment/:id`, `/chat/:characterRef`, `/approve/:id`, `/app-auth/authorize`, `/invite/accept`). You cannot cram parametric public/auth/payment routes into a flat tab enum cleanly. This was the weakest part of v1 and it's load-bearing for the whole deep-link contract.

**C2 — "Re-author every page as a settings section" is too much work and too risky.** v1's mapping jumps straight to the *destination IA* (settings sections / views). But the cloud pages are thin glue over `cloud-ui` + `lib/data` hooks. Re-authoring them as zero-arg settings sections in one move is a large rewrite with a big regression surface — and it conflates "move the code" with "redesign the IA." Those should be two steps.

**C3 — Bundling the raw-fetch→typed-client + DTO-consolidation rewrite into the migration is scope creep.** That cleanup (from the repo's cleanup mandate) touches nearly every mutation across every surface. Making it a *gating* part of the migration multiplies risk and blast radius for no user-visible benefit. It should be opportunistic, after the move.

**C4 — Native bundle bloat ignored.** `packages/app` builds desktop + mobile from the same source. v1 adds the cloud surfaces + `@stwd/sdk`/`@stwd/react` + wallet stack (wagmi/RainbowKit/Solana) + recharts to the shared package. Without build-target gating this bloats the *native* app, which doesn't want public payment/approve pages or Steward web login. v1 named bundle size as a risk but didn't make web-only gating a design rule.

**C5 — "Land straight in chat" was too absolute.** The owner said both "into managing your agents" and "the full eliza experience." A returning user with several agents may want the picker, not a guess. v1 over-committed to chat-always.

**C6 — Cutover was a hard Pages-project swap.** "Instant rollback" was asserted but a single apex project swap is all-or-nothing in practice. No canary mechanism was specified.

**C7 — "APIs don't change much" was occasionally rounded down to "zero."** We *did* find required backend work (the 2 auth bugs that block public approval/sensitive pages; allowlist edits if we ever leave the apex). The plan should not let "mostly unchanged" hide the real, if small, backend tasks.

**C8 — Effort/critical-path was missing.** v1's phases had no sizing, so it's unclear which phases are large (apps, billing, connectors) and which deliver the headline fastest (deploy + join). An owner deciding "go" needs that.

**C9 — Product constraints under-flagged.** The org model is *single-org* (accepting an invite **moves** the user's `organization_id`, not a join-table membership) — that materially shapes the Organization UX. Also `packages/feed` is a third Steward web app, and `eliza-app/*` is a parallel backend onboarding surface — both are scope-adjacent and were unmentioned.

**C10 — Connector/apps reconciliation was flagged but not resolved.** Leaving the local-vs-cloud naming collision "to decide later" is a latent UX trap that affects the IA of two surfaces; v1 should have proposed a concrete default.

---

## Part B — Second revision (these deltas supersede v1)

### B1 — Routing: a thin react-router shell wrapping the tab/view app (resolves C1)

Don't bolt parametric routes onto the tab enum. Introduce **one top-level `<BrowserRouter>` in the web build** that owns the *non-app* routes and renders the existing tab/view `App` as the catch-all:

```
<BrowserRouter>                          (web build only; native keeps direct mount)
  /login, /auth/*, /app-auth/authorize   → in-app Steward auth surfaces (cloud-ui AuthorizeContent)
  /invite/accept, /accept-invitation     → invite accept
  /payment/:id, /payment/app-charge/..,  → PUBLIC hosted pages (token-gated, no app shell)
    /payment/success
  /approve/:id, /ballot/:id,             → PUBLIC token pages (+ in-app Approvals pane elsewhere)
    /sensitive-requests/:id
  /chat/:characterRef                    → PUBLIC shared chat (ElizaPageClient)
  /terms-of-service, /privacy-policy,/bsc→ static
  /*  (everything else incl /, /settings,→ the existing tab/view <App/> (chat is home)
       /dashboard/* compat redirects)
</BrowserRouter>
```

- `react-router` is **already in the dependency graph** (cloud-ui ships Next→react-router shims), so this isn't a new dep for web.
- The catch-all `/*` preserves the app's current `window.location → tab` behavior untouched.
- The `/dashboard/*` paths become **compat redirects** inside the shell, carrying over cloud-frontend's existing `<Navigate>` map verbatim (build/*→agents, image|video|gallery→api-explorer, containers→agents) plus new ones (`/dashboard/billing`→`/settings#billing`, `/dashboard/api-keys`→`/settings#api-keys`, etc.). This satisfies the §6.2 deep-link contract mechanically.

### B2 — Two-step: lift-and-shift first, re-IA second (resolves C2, C3)

**Step 1 (move, low-risk):** relocate the cloud-frontend page modules **and their `lib/data` hooks/providers** into the app (into `packages/ui`, e.g. `packages/ui/src/cloud/…`), and mount them via the react-router shell — *as-is*, still calling same-origin `/api`, still using `cloud-ui` components they already import. The pages keep working with minimal change. This is mostly moving files + fixing import paths + wiring the Steward provider once at the shell root. cloud-frontend's `App.tsx` route table becomes the shell's route table.

**Step 2 (re-IA, incremental):** progressively reshape the lifted pages into the target IA — wrap Billing/API-keys/Account/Security/Org/Monetization page bodies in `registerSettingsSection()` section wrappers; promote Agents/Applications/Analytics/Documents to first-class views; collapse the duplicates. Each reshape is a small, independently shippable PR with its own review verdict.

This means the **cloud dashboard is functional inside the app after Step 1** (de-risked, reversible), and the *settings integration* the owner wants is achieved in Step 2 without a big-bang rewrite.

**Defer the raw-fetch→typed-client / reload→invalidate / DTO-consolidation cleanup** to a follow-up pass after Step 2. It is not a gate. Do it opportunistically where a page is already being reshaped.

### B3 — Build-target gating is a design rule (resolves C4)

- The react-router shell, Steward web-login, wallet/crypto providers, public payment/approve/ballot/sensitive pages, marketing, and the cloud dashboard are **web-build-only** and **lazy-chunked**. Extend the existing `vite.config.ts` plugin-gating to gate these by build target so the **native desktop/mobile bundle does not grow**.
- `@stwd/sdk`/`@stwd/react` and the wallet stack are imported only in lazy web chunks. Native keeps its device-code path and never loads them.
- Net: native app size is approximately unchanged; web app carries the cloud surfaces.

### B4 — Landing rule (resolves C5)

- **First-run (any target):** always land in **chat** with the just-provisioned agent.
- **Returning, single agent:** land in chat with it (active-server restore).
- **Returning, multiple agents:** land in chat with the **last-active** agent; the **Agents** view is one tap and is the explicit "manage/switch" surface. No guessing dialog.
- "Managing your agents" lives in the Agents view; "the full experience" is chat+views. Both are first-class; chat is the default home.

### B5 — Cutover via canary, not a hard swap (resolves C6)

- Deploy the app to a **Pages preview** first; validate the full deep-link contract against `api-staging` (automated smoke test).
- At the apex, gate app-vs-cloud-frontend by a **cookie/flag canary** (or percentage) so we can ramp 1% → 100% and **instantly revert** by flipping the flag — both deploys stay live during the window.
- Keep `packages/cloud-frontend` deployable until the agreed decommission window (Phase 9) closes.

### B6 — Backend work is small but non-zero, and explicit (resolves C7)

Required backend edits (the only ones):
1. **Phase 0:** fix the 2 auth bugs — add `/api/v1/{approval-requests,ballots,sensitive-requests}` to `publicPathPrefixes`; make `sensitive-requests` GET/submit accept the URL/body token actor (port the `app-core` twin's pattern).
2. **Only if we ever leave the apex (not Topology A):** add the new origin to `cors/cloud-api-hono-cors.ts`, `utils/cors.ts`, the 3 `PERMITTED_ORIGIN_HOSTS` lists, `redirect-validation.ts`, and `wrangler.toml` env. Topology A avoids all of this.

Everything else (handlers, DTOs, the ~570 endpoints, the HS256 host-independent token) is unchanged. "Doesn't change much" = these two items, not zero.

### B7 — Sizing & critical path (resolves C8)

Rough relative sizing (S/M/L/XL):
- **Phase 0** decisions + shell + auth-bug fixes — **M**
- **Phase 1** hosted-web deploy + Steward web auth + shell routes — **L** *(headline enabler)*
- **Phase 2** join flow → chat — **M** *(headline outcome; mostly reuses `selectOrProvisionCloudAgent`)*
- **Phase 3** lift-and-shift dashboard (Step 1) — **L** *(move, not rewrite)*
- **Phase 4** re-IA into settings sections (Step 2) — **L**, of which Billing/Crypto = **L**, Applications(8 tabs) = **L**, Connectors(7+reconcile) = **L**; API-keys/Account/Security/Org = **M**
- **Phase 5** agent views (Docs, Approvals pane) — **M**
- **Phase 6** admin split + role-gate consolidation — **M**
- **Phase 7** drop canvas/larp/dupes/dead — **S–M** (mechanical, high-confidence)
- **Phase 8** canary cutover — **M**
- **Phase 9** decommission cloud-frontend — **S**

**Critical path to the headline ("login drops you into your agent in the Eliza web app"): Phases 0→1→2.** Those three alone deliver the owner's core ask; the dashboard re-homing (3–7) can follow without blocking it. If the owner wants the fastest visible win, ship 0–2 first behind the canary.

### B8 — Concrete reconciliation defaults (resolves C9, C10)

- **Apps:** local installed mini-apps → keep under "Apps" in the **Agent** settings group (existing `AppsManagementSection`). Cloud developer apps → a top-level **"Applications"** view in the **Cloud** group. Different labels, different homes; no shared name.
- **Connectors:** one **Connectors** surface that **branches on the active-server kind** — local agent shows local-process connectors (`ConnectorsSection`), cloud agent shows cloud-hosted connections (`connections-tab`). The user only sees connectors that apply to where their agent actually runs.
- **Account/Billing:** delete the `ElizaCloudDashboard` panel buried in `ai-model`; its account+billing move to the new Cloud-group sections.
- **Organization UX:** surface the **single-org** reality — accepting an invite *moves* you to that org (it is not multi-membership). Show the current org, and make "accept invite" explicitly say "you'll switch to <org>." Don't imply multi-org membership the backend doesn't support.
- **Out-of-scope but noted:** `packages/feed` (third Steward web app) and the `eliza-app/*` backend onboarding surface are not part of this migration; flag for a later consolidation pass.

### B9 — Revised phase order (supersedes PLAN.md §7)

```
0  Decisions + react-router shell skeleton + fix 2 backend auth bugs           [M]
1  Hosted-web app deploy (Pages preview) + Steward web auth + shell routes     [L]  ── headline enabler
2  Join flow: login → selectOrProvisionCloudAgent → chat                       [M]  ── headline outcome
   ── (0–2 behind canary already deliver the owner's core ask) ──
3  Lift-and-shift cloud dashboard into the app (Step 1, as-is)                  [L]
4  Re-IA: settings sections + standalone views (Step 2, incremental)           [L]
5  Agent views: Documents (Knowledge) + in-app Approvals pane                  [M]
6  Admin split + consolidate role gate; infra→internal ops console            [M]
7  Drop canvas / assistant-concepts / mcp-demo / dupes / dead code            [S–M]
8  Canary cutover at apex (flag ramp; instant revert; deep-link smoke gate)    [M]
9  Decommission cloud-frontend                                                  [S]
   (follow-up, non-gating) raw-fetch→typed-client + DTO-consolidation cleanup
```

### B10 — What did NOT change from v1

The core findings and decisions stand: Topology A (app *is* `elizacloud.ai`, marketing on `eliza.app`); standardize hosted-web on Steward JWT, keep device-code for native; reuse `cloud-ui` heavily; the connection model (shared-tier REST base by default, dedicated subdomain for full experience); the keep/move/drop matrix (PLAN.md §3); the public-route preservation list; the risk register (PLAN.md §8); the user-research plan (PLAN.md §5). The second revision changes *how* we sequence and structure the work (shell-first, lift-then-reshape, web-gated, canary cutover, headline-first), not the destination.

---

## Decision gate

Awaiting owner answers to PLAN.md §9 (esp. Topology A, marketing landing, apps/connectors naming, admin split, MCP drop, native-auth strategy, decommission window). On **"go"**, execution starts at Phase 0.
