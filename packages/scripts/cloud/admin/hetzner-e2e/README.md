# Hetzner Agent E2E

Nightly end-to-end smoke that provisions a real Hetzner cpx11 server,
deploys a trivial agent via the Eliza Cloud staging API, runs a single
bridge-ping healthcheck, and tears everything down. A reaper workflow
sweeps any servers older than 60 minutes every half hour as a safety
net.

The workflow gracefully skips when secrets are unset, so it can land
on `develop` and be activated later by adding secrets.

## One-time setup

### 1. Create a CI-scoped Hetzner project + token

1. Create a separate Hetzner Cloud project (so a leaked token can't
   touch production servers).
2. Issue a read-write API token in that project.
3. Generate a fresh `ed25519` SSH keypair locally (not your dev key):
   ```bash
   ssh-keygen -t ed25519 -f /tmp/hetzner-e2e-key -N ""
   ```
4. Upload the public key to the Hetzner project (Hetzner Console →
   Security → SSH Keys) and record the **numeric key id** from the
   URL.

### 2. Create the GitHub environment

In the repo settings, create a new environment named
`ci-hetzner-e2e`. (Restricting to `develop` is recommended.)

### 3. Add environment secrets

| Secret | Value |
|---|---|
| `HCLOUD_TOKEN_CI` | The Hetzner API token from step 1.2 |
| `CLOUD_E2E_API_KEY` | A long-lived Eliza Cloud staging bearer token |
| `CI_SSH_PRIVATE_KEY` | Contents of `/tmp/hetzner-e2e-key` (private) |
| `CI_SSH_PUBLIC_KEY_ID` | Numeric Hetzner SSH key id from step 1.4 |

## Estimated cost

Default `cx22` in `fsn1` is roughly €0.006/hr (cpx11's deprecated
successor — comparable 2 vCPU / 4 GB footprint). A nightly run that
lives ~10 minutes is **about $0.30–$1.00/month** depending on
healthcheck duration. The reaper enforces a 60-minute upper bound so
the worst case (a stuck workflow) is bounded at one server-hour per
run.

If the requested `HETZNER_E2E_SERVER_TYPE` is deprecated or not
offered at `HETZNER_E2E_LOCATION`, the provisioner falls back through
a short list of known-good shared-cpu combos (cx22 in fsn1/nbg1, cax11
ARM in fsn1/hel1/nbg1) before giving up.

## Manual trigger / dry run

```bash
gh workflow run hetzner-e2e.yml
```

To test locally without touching Hetzner, run only the helpers that
don't make real API calls (e.g. typecheck them with `tsc --noEmit`).
**Do not** invoke `hetzner-e2e-provision.ts` outside of CI unless you
intend to create a real billable server.

## Files

- `.github/workflows/hetzner-e2e.yml` — provision + deploy + healthcheck + teardown
- `.github/workflows/hetzner-e2e-reaper.yml` — scheduled label-selector sweep
- `hetzner-e2e-provision.ts` — `HetznerCloudClient.createServer()`
- `hetzner-e2e-wait-ready.ts` — SSH-poll for cloud-init + Docker
- `hetzner-e2e-deploy-agent.ts` — create + provision a trivial agent
- `hetzner-e2e-healthcheck.ts` — single `status.get` bridge ping
- `hetzner-e2e-teardown.ts` — delete the server (idempotent, falls
  back to label sweep if state artifact missing)
- `hetzner-e2e-reaper.ts` — list+delete servers older than 60min
- `state-file.ts` — atomic JSON state shared between steps
