# Eliza Cloud Integration Plan

This document defines the Eliza Cloud rollout as one of several server targets exposed through the same chooser-first startup entry point.

## Product paths

1. Local
   The backend runs on the user's machine with the current full-local behavior and full local permissions.

2. Eliza Cloud
   The frontend provisions and connects to a managed container through Eliza Cloud at `elizacloud.ai`.

3. Remote Eliza backend
   The frontend connects to an already running Eliza backend by address plus access key (`ELIZA_API_TOKEN`).

## Architecture

### App onboarding

- Startup begins with a server chooser, not provider selection.
- The selected server target is canonical runtime state:
  - `deploymentTarget.runtime = "local"` for a local server
  - `deploymentTarget.runtime = "remote"` for a remote or LAN server
  - `deploymentTarget.runtime = "cloud"` for an Eliza Cloud server
- Provider selection happens after the server target is chosen and writes canonical `serviceRouting`, not hosting state.
- Eliza Cloud account linkage writes `linkedAccounts.elizacloud`; it does not imply Eliza Cloud inference unless `serviceRouting.llmText.backend = "elizacloud"`.
- Persist the selected server in client state so reloads and popouts keep the same backend.
- Treat Eliza Cloud-linked services as optional per-capability routes, not a global “cloud on” flag.

### Self-hosted remote backend

- The backend stays the canonical Eliza API server.
- Browser clients must send a bearer token using `ELIZA_API_TOKEN`.
- CORS must explicitly allow the frontend origin with `ELIZA_ALLOWED_ORIGINS`.
- The onboarding access key shown to the user is the same value as `ELIZA_API_TOKEN`.

### Eliza Cloud control plane

- `elizacloud.ai` is the canonical managed control plane.
- There is no separate Eliza-specific cloud API service.
- Eliza Cloud is the control plane, OAuth handler, billing surface, and user store.
- Managed launches redirect into `app.eliza.ai` with a one-time launch session that selects the hosted server target and skips manual server entry.

### Browser transport

- `app.eliza.ai` already exchanges managed launch sessions directly with Eliza Cloud.
- The hosted Eliza frontend should use Eliza Cloud APIs directly for browser-safe managed flows.
- The local desktop/backend keeps same-origin `/api/cloud/*` passthrough routes so it can persist the user's Eliza Cloud API key into local config and runtime state.
- If a Eliza-owned origin is ever required for browser routing or enterprise policy, use the Cloudflare Worker proxy template in `deploy/cloudflare/eliza-cloud-proxy/` instead of standing up a separate application server.

## Operator checklist

### Eliza app and API

- [x] Restore chooser-first startup in the app.
- [x] Add `Eliza Cloud` and `Remote Eliza` cloud sub-options.
- [x] Allow the frontend client to rebind to a remote backend during onboarding.
- [x] Persist the rebound API base for the current session.
- [x] Update cloud defaults and user-facing copy to Eliza Cloud.
- [x] Persist an Eliza Cloud API key during onboarding when the user chooses API-key auth.
- [x] Separate linked Eliza Cloud auth from active inference routing.

### Self-hosted remote flow

- [x] Document secure remote backend deployment in the README.
- [x] Document address + access-key connection flow in the README.
- [x] Document Tailscale as the preferred private-network exposure path.
- [ ] Add a dedicated in-app "switch backend" settings surface after onboarding.
- [ ] Add a remote-backend connectivity diagnostic screen for auth/CORS/WS failures.

### Eliza Cloud control plane

- [x] Point managed launch onboarding at canonical `deploymentTarget.runtime = "cloud"`.
- [x] Keep Eliza-managed launch sessions flowing through Eliza Cloud.
- [x] Make the browser-facing Eliza Cloud auth/compat endpoints callable cross-origin when needed.
- [x] Remove active `Eliza Cloud` labels from the managed auth/runtime surfaces.
- [ ] Verify post-login session redirects and popup flows end-to-end against the Eliza app.

### Infrastructure and release

- [ ] Run a production smoke test:
  - Local onboarding
  - Eliza Cloud provisioning
  - Remote self-host attach by URL + token
  - Desktop download flow from the homepage
- [ ] Cut a Eliza release after the hosted flow is verified on the public domain.

## Remote backend deployment recipe

Use this when the user wants to host their own backend and connect from the Eliza web frontend.

1. Install Eliza on the target machine.
2. Set a non-loopback bind, a strong API token, and explicit allowed origins.
3. Expose the service over HTTPS or a private Tailscale URL.
4. In startup, choose `Manually connect` or a discovered remote server, then enter:
   - backend address
   - access key (`ELIZA_API_TOKEN`)

Recommended environment:

```bash
ELIZA_API_BIND=0.0.0.0
ELIZA_API_TOKEN=$(openssl rand -hex 32)
ELIZA_ALLOWED_ORIGINS=https://app.eliza.ai,https://eliza.ai,https://elizacloud.ai,https://www.elizacloud.ai
```

Optional Tailscale exposure:

```bash
tailscale serve --https=443 http://127.0.0.1:2138
```

For a public Tailscale-hosted URL:

```bash
tailscale funnel --https=443 http://127.0.0.1:2138
```

## Optional Cloudflare proxy

Use this only if a Eliza-owned browser origin is required for policy or routing reasons.

1. Deploy the Worker template in `deploy/cloudflare/eliza-cloud-proxy/`.
2. Point the Worker at `https://www.elizacloud.ai`.
3. Route only browser-facing auth/compat/launch-session paths through the Worker.
4. Keep Eliza Cloud as the only upstream control plane.

The concrete proxy setup now lives in `docs/eliza-cloud-deployment.md`.
