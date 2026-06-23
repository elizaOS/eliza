# Runbook — split the apex (console) from the agent app (subdomain)

> **⚠️ SUPERSEDED 2026-06-23 by DECISIONS.md D6.** The D5 split below has been
> **reversed**: the apex (`eliza-cloud` Pages project / `elizacloud.ai`) now
> builds **`packages/app`** (not `packages/cloud-frontend`, which is deleted).
> Both the apex and the `app.elizacloud.ai` subdomain build the **same**
> `packages/app` target via `build:web` (mounting the cloud UI through
> `@elizaos/ui/cloud`); they differ only in the canonical-origin env baked into
> each bundle. The `deploy-console` job in `cloud-cf-deploy.yml` was repointed
> accordingly, keeping `--project-name=eliza-cloud` so the apex domain is
> unchanged. **No Cloudflare-side action is needed for this re-point** — same
> project, same domain, only the build source changed. The `eliza-app` project
> setup in §2–4 below remains valid for the `app.*` subdomain. The rest of this
> runbook (the D5 split) is historical.

**Topology: D5 (supersedes Topology A / D1).** Two Cloudflare Pages projects,
two domains, two builds from one repo:

| Domain | Pages project | Builds | Is |
|---|---|---|---|
| `elizacloud.ai` / `staging.elizacloud.ai` | `eliza-cloud` (existing) | `packages/cloud-frontend` | the lander + dashboard ("the console") |
| `app.elizacloud.ai` / `app-staging.elizacloud.ai` | **`eliza-app` (new)** | `packages/app` (`build:web`) | the Eliza agent app (chat + views) |

This runbook covers the **one-time Cloudflare setup for the new `eliza-app`
project** and the apex restoration. The in-repo wiring (deploy workflow, wrangler,
origin allowlists, console "Talk to your agent" CTA) is already landed — see
DECISIONS.md D5.

---

## 0. What changes

| Thing | Changes? |
|---|---|
| `eliza-cloud` Pages project → `packages/cloud-frontend` at the apex | **Restored** — the `deploy-console` job builds cloud-frontend again (it had been repointed at `packages/app` during the brief Topology-A cutover) |
| Apex domain (`elizacloud.ai` / `staging.elizacloud.ai`) + DNS | No — already on `eliza-cloud` |
| **`eliza-app` Pages project** | **New** — created once (§2) |
| **`app.elizacloud.ai` / `app-staging.elizacloud.ai` domains + DNS** | **New** — attached once (§3–4) |
| Backend Worker (`cloud-api`) origin allowlists | **Yes, small** — `app.*` added to CORS + redirect allowlists (D5); already landed in `cloud-shared`. A `cloud-api` redeploy ships them. |
| Steward CSRF (`PERMITTED_ORIGIN_HOSTS`) + cookie domain | No — `*.elizacloud.ai` already allowed; cookie already scoped to `.elizacloud.ai` |
| Agent-subdomain routing (`*.elizacloud.ai` containers) | No |

---

## 1. Prerequisites

- `CLOUDFLARE_API_TOKEN` with **Pages: Edit** + **DNS: Edit** on the elizaOS
  account (same token the GH Actions deploy uses).
- `CLOUDFLARE_ACCOUNT_ID` (matches `packages/cloud-api/wrangler.toml`).
- The `elizacloud.ai` zone id (fetched in §3).

```bash
export CLOUDFLARE_API_TOKEN=...        # Pages:Edit + DNS:Edit
export CLOUDFLARE_ACCOUNT_ID=...
ZONE_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=elizacloud.ai" | jq -r '.result[0].id')
echo "elizacloud.ai zone: $ZONE_ID"
```

---

## 2. Create the `eliza-app` Pages project

The `deploy-app` job self-bootstraps this (`wrangler pages project create eliza-app
--production-branch=main`), so the **first deploy creates it automatically**. To
create it ahead of time (so you can attach domains before the first deploy):

```bash
bunx wrangler pages project create eliza-app --production-branch=main
```

`packages/app/wrangler.toml` already pins `name = "eliza-app"`, the
`pages_build_output_dir`, `API_UPSTREAM` (prod + `[env.preview]` staging), and the
Steward tenant. The same-origin `/api` + `/steward` proxy ships from
`packages/app/functions/{_middleware,_proxy}.ts`.

---

## 3. Attach the custom domains (`wrangler pages` has no `domain` subcommand → CF API)

```bash
add_domain () {  # $1 = fqdn
  curl -s -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/eliza-app/domains" \
    --data "{\"name\":\"$1\"}" | jq '.success, .errors'
}
add_domain app.elizacloud.ai          # → serves the eliza-app PRODUCTION (main) deploy
add_domain app-staging.elizacloud.ai  # → serves the develop branch (see §4 note)
```

> **Staging → develop branch.** A Pages custom domain serves the **production**
> deployment. To make `app-staging.elizacloud.ai` serve the `develop` branch,
> mirror exactly how the existing `staging.elizacloud.ai` is wired on
> `eliza-cloud` (download its config first to copy the pattern):
> ```bash
> bunx wrangler pages download config eliza-cloud   # inspect the staging wiring
> ```
> The conventional pattern is a DNS `CNAME app-staging → develop.eliza-app.pages.dev`
> (the stable branch alias) rather than a Pages custom domain. Use whichever the
> apex already uses so the two projects behave identically.

---

## 4. DNS records

Create the `CNAME`s in the `elizacloud.ai` zone (proxied / orange-cloud, matching
the apex's existing records):

```bash
add_cname () {  # $1 = name (app | app-staging), $2 = target
  curl -s -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
    --data "{\"type\":\"CNAME\",\"name\":\"$1\",\"content\":\"$2\",\"proxied\":true}" \
    | jq '.success, .errors'
}
add_cname app         eliza-app.pages.dev
add_cname app-staging develop.eliza-app.pages.dev
```

(If §3's "custom domain" path is used for `app.elizacloud.ai`, Cloudflare may
create/validate the apex-style record for you; only add what's missing.)

---

## 5. Steward OAuth redirect allowlist (steward-side config)

The repo-side redirect allowlist already includes `app.*`
(`security/redirect-validation.ts`). The **Steward tenant** (the `elizacloud` /
`elizacloud-staging` tenant in the Steward backend) must also list the app
origins as allowed OAuth `redirect_uri`s, so a login *initiated on the app
subdomain* can bounce back to it:

- `https://app.elizacloud.ai` (tenant `elizacloud`)
- `https://app-staging.elizacloud.ai` (tenant `elizacloud-staging`)

> In the common path this is not exercised — users log in on the apex and the
> `.elizacloud.ai` cookie carries them into the app already authenticated — but
> add it so direct app-subdomain logins work too.

---

## 6. Deploy

CI does both on push (`develop` → staging, `main` → prod) via
`.github/workflows/cloud-cf-deploy.yml`: `deploy-console` (cloud-frontend →
`eliza-cloud`) and `deploy-app` (`packages/app` → `eliza-app`). A `cloud-api`
redeploy ships the new origin allowlists.

Manual (from a clean checkout):

```bash
# Console (apex)
bun run --cwd packages/cloud-frontend build
bunx wrangler pages deploy --project-name=eliza-cloud --branch=main \
  --cwd packages/cloud-frontend

# App (subdomain)
bun run --cwd packages/app build:web
bunx wrangler pages deploy --project-name=eliza-app --branch=main \
  --cwd packages/app
```

---

## 7. Verify

1. **Apex is the console again** — `https://staging.elizacloud.ai` shows the
   lander (anonymous) → Steward login → dashboard. **No agent onboarding, no
   `/api/views` / `/api/apps/favorites` 404s, no `<uuid>.elizacloud.ai` CORS
   noise** (those belonged to the agent app, which is no longer at the apex).
2. **Console deep-link contract** (cloud-frontend's own routes — unchanged from
   before the cutover): payment / approve / ballot / magic-link land on the apex.
3. **App subdomain** — `https://app-staging.elizacloud.ai` boots the agent app;
   `node packages/app/scripts/smoke-deeplinks.mjs https://app-staging.elizacloud.ai`
   is green.
4. **Cross-subdomain SSO** — log in on `staging.elizacloud.ai`, click "Talk to
   your agent" → land on `app-staging.elizacloud.ai` **already signed in**
   (the `.elizacloud.ai` Steward cookie carried over).
5. **First-party API** — a `/api/v1/...` call from the app subdomain returns from
   the Worker (same-origin via the app's `_proxy.ts`); no CORS preflight failure.

---

## 8. Rollback

The two projects are independent — rollback is per surface:

- **Console** — redeploy the previous `eliza-cloud` (cloud-frontend) deployment
  (or `wrangler pages deployment` rollback). The apex never depended on the app.
- **App** — the `eliza-app` project / `app.*` domains can be removed entirely
  with zero apex impact (DNS + the Pages project are net-new). The agent app also
  still ships in desktop/mobile, unaffected.

No backend revert is required for rollback; the added origin allowlist entries are
additive and harmless if `app.*` is taken down.

---

## 9. Artifacts this runbook depends on

- `.github/workflows/cloud-cf-deploy.yml` (`deploy-console` + `deploy-app` jobs)
- `packages/app/wrangler.toml` (`name = "eliza-app"`), `packages/app/functions/*`
- `packages/cloud-frontend/wrangler.toml` (`name = "eliza-cloud"`), its `functions/*`
- `packages/cloud-frontend/src/lib/eliza-app-url.ts` + the console "Talk to your
  agent" CTA in `src/dashboard/Page.tsx`
- Origin allowlists in `packages/cloud-shared/src/lib/{cors,utils,security}/`
- `packages/app/scripts/smoke-deeplinks.mjs`
- `docs/cloud-into-eliza/DECISIONS.md` D5
