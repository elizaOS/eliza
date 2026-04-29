# Eliza Cloud Integration Runbook

Use this runbook when Milady should rely on the existing Eliza Cloud deployment at `https://elizacloud.ai`, with no separate Milady-hosted cloud control plane.

## Scope

This integration has two codebases:

1. `milady`
   The local app, onboarding flow, homepage, and remote-backend attach flow.

2. The existing Eliza Cloud control plane repository
   This remains the only managed server/control-plane deploy in the Milady hosted flow.

## Code state

The code-side work is already in place:

- Local / Cloud / Remote onboarding is wired in the Milady app.
- Eliza Cloud URLs and managed-launch defaults are wired through the app.
- Managed launches now hand off from `elizacloud.ai` to `app.milady.ai` with one-time launch sessions.
- Browser-facing managed-launch exchange already happens directly against Eliza Cloud.
- A Cloudflare Worker proxy template exists in `deploy/cloudflare/eliza-cloud-proxy/` if a Milady-owned browser origin is ever required.

## What must already exist

- A reachable Eliza Cloud deployment at `https://elizacloud.ai` or `https://www.elizacloud.ai`
- A deployed Milady web frontend at `https://app.milady.ai`
- The Milady homepage and app pointing to Eliza Cloud login/dashboard URLs

For remote self-hosted backends, you also need:

- A Milady backend reachable over HTTPS or Tailscale
- `MILADY_API_TOKEN` on that backend
- `MILADY_ALLOWED_ORIGINS` including the Milady web origins you plan to use

Recommended remote backend environment:

```bash
MILADY_API_BIND=0.0.0.0
MILADY_API_TOKEN=$(openssl rand -hex 32)
MILADY_ALLOWED_ORIGINS=https://app.milady.ai,https://milady.ai,https://elizacloud.ai,https://www.elizacloud.ai
```

## Managed browser flow

1. User signs in at `https://elizacloud.ai/login?returnTo=%2Fdashboard%2Fmilady`
2. User opens or creates an instance at `https://elizacloud.ai/dashboard/milady`
3. Eliza Cloud redirects to `https://app.milady.ai` with `cloudLaunchSession` and `cloudLaunchBase`
4. `app.milady.ai` exchanges that one-time session directly with `GET /api/v1/milady/launch-sessions/:sessionId`
5. The Milady web client binds to the selected managed backend and skips onboarding

## Desktop/local flow

- The local Milady backend keeps `/api/cloud/*` passthrough routes.
- Those routes still forward to Eliza Cloud, but they exist only so the local runtime can persist the user's Eliza Cloud API key into local config and runtime state.
- This is local app plumbing, not a separate hosted Milady service.

## Optional Cloudflare proxy

Use this only if you want a Milady-owned browser-facing proxy such as `https://cloud-api.milady.ai`.

### Files

- Worker: `deploy/cloudflare/eliza-cloud-proxy/worker.ts`
- Wrangler template: `deploy/cloudflare/eliza-cloud-proxy/wrangler.toml.example`

### Worker responsibilities

- Forward only browser-facing paths to Eliza Cloud:
  - `/api/auth/cli-session`
  - `/api/auth/cli-session/:sessionId`
  - `/api/compat/*`
  - `/api/v1/milady/launch-sessions/*`
- Preserve `Authorization` and `X-Service-Key` headers.
- Reflect CORS only for allowed Milady origins.
- Keep Eliza Cloud as the only upstream control plane.

### Enactment

1. Create a Cloudflare Worker from `deploy/cloudflare/eliza-cloud-proxy/worker.ts`
2. Set `ELIZA_CLOUD_ORIGIN=https://www.elizacloud.ai`
3. Set `ALLOWED_ORIGINS=https://app.milady.ai,https://milady.ai,http://localhost:5173,http://127.0.0.1:5173`
4. Bind a route such as `cloud-api.milady.ai/*`
5. If you use the proxy, update the Milady frontend/cloud config to use that origin for browser-managed calls only

## Smoke test

Run these checks against the live Eliza Cloud deployment:

1. Open `https://elizacloud.ai/login?returnTo=%2Fdashboard%2Fmilady`
2. Open `https://www.elizacloud.ai/auth/cli-login?session=test-session`
3. Verify the homepage `Get the app` and `Eliza Cloud` CTA on `milady`
4. In the Milady app onboarding:
   - `Create one` starts a local backend on this device
   - `Use Eliza Cloud` opens the cloud-managed server path
   - `Manually connect to one` accepts backend URL + access key
   - discovered LAN servers open through the same remote connection path
5. Test a real remote self-hosted backend using `MILADY_API_TOKEN`
6. Create one Eliza Cloud instance, launch it from `/dashboard/milady`, and confirm `app.milady.ai` opens already attached with onboarding skipped
7. If you enabled the optional Cloudflare proxy, repeat the browser-managed calls through the proxied origin

## What you still must do manually

These actions are intentionally external to the repo:

- Keep the upstream Eliza Cloud deployment healthy
- Keep `app.milady.ai` deployed
- Configure DNS for any optional proxy origin you choose
- Configure `MILADY_ALLOWED_ORIGINS` on any remote self-hosted Milady backend you expose
