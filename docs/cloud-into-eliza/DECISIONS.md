# Cloud → Eliza migration — Owner decisions (applied)

Recorded 2026-06-18. These answers supersede the corresponding parts of `PLAN.md` and `REVISION-2.md`. Execution does **not** begin until the owner says "go."

---

## D1 — Topology: **App IS the `elizacloud.ai` apex** ✅ (Topology A) — ⚠️ SUPERSEDED by D5

> **SUPERSEDED 2026-06-19 by [D5](#d5--topology-split-console-at-apex-app-on-its-own-subdomain).**
> Topology A was briefly cut over (the app shipped to the `eliza-cloud` Pages
> project at the apex) and it **buried the lander + dashboard under the agent
> app's local-first onboarding** — exactly what an anonymous `elizacloud.ai`
> visitor must NOT see. The owner reversed it: the apex goes back to the console
> (`cloud-frontend`); the agent app moves to its own subdomain. Read D5.

Confirmed. The Eliza web app replaces the cloud-frontend deploy in the existing Cloudflare Pages project at the apex, reusing `functions/_proxy.ts` same-origin `/api`+`/steward` proxy. **No backend env / CORS / redirect / agent-subdomain changes.** Obligation: the app serves every existing SPA route path + the internal `<Navigate>` redirect map.

## D2 — Sequencing: **Full migration, then ONE cutover**

Change from the v2 recommendation (which proposed a headline-first canary ramp). The owner wants the complete experience built before flipping the apex.

**Plan delta:**
- Build **all** phases (0–7) against a **Pages preview + `api-staging`** before any production cutover. cloud-frontend stays live at the apex the entire time.
- Phase 8 becomes a **single cutover** (point the apex Pages project at the app build), **not** a percentage ramp.
- **Keep instant rollback** regardless: cloud-frontend remains deployable, so the cutover is one flag/deploy flip back if smoke tests fail. We still gate the cutover on the **automated full deep-link contract smoke test** (every backend-issued URL resolves) + the app's aesthetic-audit verdicts.
- We still build in **internally shippable increments** (each phase verifiable on the preview); we just don't expose partial states to production users. "One cutover" is about the production flip, not about giant unreviewable PRs.

## D3 — Auth by connection mode (important refinement)

Owner's model — auth is per **connection kind**, not per platform:

| Mode | What it is | Auth |
|---|---|---|
| **Cloud** | Hosted agent container on Eliza Cloud | **Steward — unified across web AND native** (desktop/mobile). One identity. |
| **Local** | Agent running in-process / on this device (loopback) | **No cloud auth needed** (in-process / loopback). |
| **Remote** | Connect to a *self-hosted* agent running elsewhere — e.g. the agent runs "local" on a Mac mini and the user connects from their phone/laptop | **Device-code / pairing** — this is device-code's real purpose. |

Key correction vs v2: **Cloud is unified on Steward even on native.** The device-code window is **not** the native-cloud login; it is exclusively the **Remote** (self-hosted) connection handshake. (Note: you connect *to* a remote agent; you don't connect to an agent running on a mobile device from elsewhere — the agent typically lives on a Mac mini / always-on box and clients connect in.)

**Plan delta (supersedes PLAN.md §2.4 and REVISION-2 §B3/B6):**
- **Cloud auth = Steward everywhere.** On hosted web (same-origin apex) Steward rides the cookie + localStorage-JWT path untouched. On **native** (`capacitor://localhost` / loopback — already in the CORS allowlist), run the Steward flow (passkey/email/OAuth/wallet) and send the JWT as **Bearer** (no cookie needed cross-origin; the localStorage-Bearer path already exists). `@stwd/sdk`/`@stwd/react` therefore ship in the native cloud path too, lazily loaded only when the user chooses Cloud.
- **Retire `__ELIZA_CLOUD_AUTH_TOKEN__` / the `/auth/cli-login` device-code window for Cloud.** Cloud login becomes the in-app Steward surface on every target.
- **Device-code/pairing is preserved and re-scoped to Remote** (`finishRemote` / connecting to a self-hosted agent). `CompactOnboarding`'s three branches map exactly: Cloud→Steward, Local→no-auth loopback, Remote→device-code/pairing.
- Token lifecycle: reuse cloud-frontend's `AuthTokenSync` refresh (honor `exp`, refresh via the same-origin cookie path on web; Bearer-refresh on native).

## D4 — MCPs: **build and test a REAL registry** (net-new scope)

Change from v2 (which proposed DROP). The MCPs surface becomes a real, working management surface — not a demo, not a stub.

**Plan delta (supersedes the MCPs row in PLAN.md §3):**
- **Delete** the hardcoded `demoMcpServers` catalog.
- **Wire to the real backend** that already exists: `/api/v1/mcps` (+ `:mcpId/publish`), `/api/mcp`, `/mcp/{list,info,registry,stream}`, `/mcp/proxy/:mcpId`, and the per-provider transport routes. Audit these for completeness; add list/register/edit/delete/enable-disable + publish where the backend supports it, and fill backend gaps if the CRUD/registry isn't complete.
- **Surface:** an MCPs **view** (or Settings section under the Cloud/Developer group) for browse + manage; integrate with the agent so an agent can use registered MCP servers.
- **Tests required:** unit + e2e against the real registry endpoints (recorded + live contract tests, per the repo's external-API-mock convention). This is explicit acceptance criteria from the owner ("build and test a real registry").
- This adds a **medium-large** work item to Phase 4 (and possibly small backend work in Phase 0/early if the registry CRUD has gaps).

---

## Revised phase order (final, pre-go)

```
0  Decisions locked + react-router shell skeleton + fix 2 backend auth bugs
   + audit MCP registry backend for CRUD/publish gaps                          [M]
1  Hosted-web app on Pages PREVIEW + Steward auth (web same-origin AND native
   Bearer) + shell routes; cloud-frontend stays live at apex                   [L]
2  Join flow: Steward login → selectOrProvisionCloudAgent → land in chat
   (Cloud=Steward, Local=loopback no-auth, Remote=device-code/pairing)         [M]
3  Lift-and-shift cloud dashboard into the app (Step 1, as-is, on preview)     [L]
4  Re-IA: settings sections + standalone views (Step 2) + REAL MCP registry    [L+]
5  Agent views: Documents (Knowledge) + in-app Approvals pane                  [M]
6  Admin split + consolidate role gate; infra → internal ops console          [M]
7  Drop canvas / assistant-concepts / dupes / dead code                        [S–M]
   ── full experience validated on preview against api-staging ──
8  SINGLE production cutover at apex (point Pages project at app build);
   gated on full deep-link smoke test + aesthetic-audit; instant rollback kept [M]
9  Decommission cloud-frontend after the agreed window                         [S]
   (follow-up, non-gating) raw-fetch→typed-client + DTO-consolidation cleanup
```

## Still-open (non-blocking) owner inputs

- **Marketing landing at apex `/`:** slim landing vs immediate redirect-into-app for signed-in users. (Default assumption: signed-in → app; signed-out → slim landing or `eliza.app`.)
- **Apps/Connectors naming** (REVISION-2 §B8 defaults stand unless overridden): local "Apps/Mini-apps" vs cloud "Applications"; Connectors branch by active-server kind.
- **Admin:** moderation/redemptions/rpc-status in-app behind role gate; infra/metrics as separate internal ops console. (Default assumption: yes.)
- **Decommission window** for cloud-frontend after cutover.

These have sensible defaults and do not block starting Phase 0.

---

<a id="d5--topology-split-console-at-apex-app-on-its-own-subdomain"></a>

## D5 — Topology split: console at apex, app on its own subdomain ✅ (supersedes D1) — ⚠️ SUPERSEDED by D6

> **SUPERSEDED 2026-06-23 by [D6](#d6--re-consolidate-one-codebase-packagesapp-serves-both-apex-and-subdomain).**
> `packages/cloud-frontend` has been deleted; the apex (`eliza-cloud` project)
> now builds `packages/app`, which mounts the whole cloud UI via
> `@elizaos/ui/cloud`. Read D6.

Recorded 2026-06-19. Reverses the single-project reuse in D1 after the Topology-A
cutover buried the lander + dashboard under the agent app's onboarding.

**Two Pages projects, two domains, two builds from one repo:**

| Domain | Pages project | Builds | Is |
|---|---|---|---|
| `elizacloud.ai` / `staging.elizacloud.ai` | `eliza-cloud` (existing) | `packages/cloud-frontend` | the lander + dashboard ("the cloud console"). Steward login → dashboard. **No agent stuff, no onboarding.** |
| `app.elizacloud.ai` / `app-staging.elizacloud.ai` | `eliza-app` (new) | `packages/app` (`build:web`) | the Eliza agent app — the same web UI as `bun run dev` (chat + views). |

**Flow:** anonymous → apex lander → Steward login → apex dashboard (the console),
which carries a **"Talk to your agent / Open Eliza"** CTA → `app.elizacloud.ai`.
The Steward session cookie is scoped to the parent `.elizacloud.ai` zone
(`cloud-shared auth/cookie-domain.ts`), so the user lands on the app already
signed in — no token handoff.

**Why this is NOT "no backend changes" (unlike D1):** the app now serves from a
**new origin** (`app.elizacloud.ai`), so per REVISION-2 §B6 the origin must be
added to the first-party allowlists. Done: `cors/cloud-api-hono-cors.ts`
(`STATIC_ALLOWED_ORIGINS`), `utils/cors.ts` (`ALLOWED_ORIGINS`),
`security/redirect-validation.ts` (`DEFAULT_PLATFORM_REDIRECT_ORIGINS`). The
Steward CSRF check (`PERMITTED_ORIGIN_HOSTS` in the 3 `auth/steward-*` routes)
already allows any `*.elizacloud.ai` via suffix match — no edit. The dedicated
agent-subdomain CORS (`pairing-token-domains.ts`) is a separate concern —
untouched.

**The in-app `/dashboard/*` routes** migrated into `packages/app`
(`packages/ui/cloud/*`) stay for now (owner: "keep both"); cloud-frontend is the
canonical dashboard at the apex. Reconcile later.

**Deploy:** `.github/workflows/cloud-cf-deploy.yml` now has two Pages jobs —
`deploy-console` (cloud-frontend → `eliza-cloud`) and `deploy-app`
(`packages/app` → `eliza-app`). Cloudflare setup for `eliza-app` (project +
custom domains + DNS): see CUTOVER-RUNBOOK.md.

**Rollback** is independent per project: the apex (console) is untouched by the
app deploy and vice-versa.

---

**Status: D5 split implemented in-repo (workflow + wrangler + allowlists + console
CTA). Cloudflare `eliza-app` project + `app.*` domains pending (CUTOVER-RUNBOOK).**

---

<a id="d6--re-consolidate-one-codebase-packagesapp-serves-both-apex-and-subdomain"></a>

## D6 — Re-consolidate: one codebase (`packages/app`) serves both apex and subdomain ✅ (supersedes D5)

Recorded 2026-06-23. Reverses the D5 split. `packages/app` already mounts the
**entire** cloud UI in-process (`CloudRouterShell` + `registerAllCloudSurfaces`
via `@elizaos/ui/cloud`) and already carries the apex deploy infra
(`wrangler.toml`, `functions/{_middleware,_proxy}.ts` same-origin `/api` proxy,
`build:web`). Maintaining a **second** dashboard codebase (`packages/cloud-frontend`)
in parallel was pure duplication.

**Decision: delete `packages/cloud-frontend`; the apex builds `packages/app`.**

| Domain | Pages project | Builds | Is |
|---|---|---|---|
| `elizacloud.ai` / `staging.elizacloud.ai` | `eliza-cloud` (unchanged) | `packages/app` (`build:web`) | the cloud console origin (lander + dashboard) — same `@elizaos/ui/cloud` surfaces. |
| `app.elizacloud.ai` / `app-staging.elizacloud.ai` | `eliza-app` | `packages/app` (`build:web`) | the Eliza agent app — the same web UI as `bun run dev`. |

Both Pages projects now build the **same** `packages/app` target. The **only**
difference between the two deploys is the canonical-origin env baked into each
bundle: the apex (`deploy-console`) sets `VITE_APP_URL`/`NEXT_PUBLIC_APP_URL` to
`https://elizacloud.ai` (staging: `https://staging.elizacloud.ai`); the subdomain
(`deploy-app`) sets them to `https://app.elizacloud.ai`. `VITE_ELIZA_APP_URL`
still points the apex's "open the agent app" CTA at `app.elizacloud.ai`.

**Deploy:** `.github/workflows/cloud-cf-deploy.yml` keeps both Pages jobs, but
`deploy-console` now runs `bun run --cwd packages/app build:web` (was
`cloud-frontend build`) and deploys it to `--project-name=eliza-cloud` (apex
domain unchanged). The `cloud-frontend`-specific "Verify bundle chunk safety"
step was removed (`packages/app` has no equivalent script; its rolldown config
is independent).

**Dropped on purpose:** the cloud-frontend-only surfaces — the **chat playground**,
**canvas**, and **assistant-concepts** pages — die with `cloud-frontend`. They
were never ported into `@elizaos/ui/cloud` and are not part of the app's cloud
surface set.

**Why this is safe:** nothing imports `@elizaos/cloud-frontend` (it is an app,
not a library — no package exports), so the deletion is import-safe. The apex
domain, Pages project, Worker API, Steward auth, and the parent-zone cookie are
all unchanged.

---

**Status: D6 applied in-repo — `cloud-frontend` deleted, `deploy-console` repointed
to `packages/app`, CI/config references cleaned. Apex domain + `eliza-cloud`
Pages project unchanged (no Cloudflare-side action needed for the re-point).**
