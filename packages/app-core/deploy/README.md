# Deployment Toolkit

This directory contains the generic deployment assets for elizaOS apps: Dockerfiles, compose files, node rollout scripts, Cloudflare proxy sources, and the cloud-agent runtime helpers.

## Layout

- `deploy.defaults.env` — shared defaults loaded by the setup and rollout scripts
- `Dockerfile.ci` — canonical image for prebuilt runtime/UI artifacts
- `Dockerfile.cloud-agent` — subordinate cloud-agent runtime image
- `docker-compose.yml` — gateway plus interactive CLI services
- `docker-compose.supabase-db.yml` — optional local Postgres service
- `docker-setup.sh` — local image build plus compose-based onboarding flow
- `deploy-to-nodes.sh` — image load / restart helper for remote Docker nodes
- `cloudflare/eliza-cloud-proxy/` — proxy worker source and Wrangler example

## App Overrides

Create a repo-root `deploy/deploy.env` and override only what differs from `deploy.defaults.env`. The scripts look for that file in this order:

1. `DEPLOY_CONFIG`
2. `./deploy.env`
3. `../deploy/deploy.env`

`deploy-to-nodes.sh` also looks for `nodes.json` in the same order, using `DEPLOY_NODES_FILE`, `./nodes.json`, and `../deploy/nodes.json`.

## Common Commands

```bash
# Build a local image and walk through setup.
cd deploy
bash ../eliza/packages/app-core/deploy/docker-setup.sh

# Load the current image onto configured nodes.
cd deploy
bash ../eliza/packages/app-core/deploy/deploy-to-nodes.sh --status
```

## Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_NAME` | App/project name used by compose and helper output | `eliza` |
| `APP_ENTRYPOINT` | Runtime entrypoint copied into images | `app.mjs` |
| `APP_CMD_START` | Startup command for the full app container | `node --import ./node_modules/tsx/dist/loader.mjs app.mjs start` |
| `APP_IMAGE` | Local Docker image name | `eliza:local` |
| `APP_REGISTRY` | Optional registry prefix used by node rollout image matching | _empty_ |
| `APP_PORT` | Primary app/API port inside the container | `2138` |
| `APP_GATEWAY_PORT` | Gateway listener port | `18789` |
| `APP_BRIDGE_PORT` | Cloud bridge port | `18790` |
| `APP_GATEWAY_BIND` | Gateway bind preset passed to the CLI | `lan` |
| `APP_STATE_DIR` | In-container state/config directory | `/home/node/.eliza` |
| `APP_CONFIG_DIR` | Host-side config directory mounted into the container | `${HOME}/.eliza` |
| `APP_WORKSPACE_DIR` | Host-side workspace directory mounted into the container | `${HOME}/.eliza/workspace` |
| `APP_DB_NAME` | Database name for the Postgres helper compose file | `eliza` |
| `APP_API_BIND` | Default API bind address baked into the image | `127.0.0.1` |
| `OCI_SOURCE` | OCI source metadata | _empty_ |
| `OCI_TITLE` | OCI image title | `elizaOS Agent` |
| `OCI_DESCRIPTION` | OCI image description | `elizaOS agent runtime` |
| `OCI_LICENSES` | OCI image license metadata | `MIT` |
| `CF_WORKER_NAME` | Suggested Cloudflare worker name | `eliza-cloud-proxy` |
| `CF_ALLOWED_ORIGINS` | Allowed CORS origins for the proxy worker | _empty_ |
| `CF_PROXY_PATH_PREFIXES` | Comma-separated path prefixes forwarded by the proxy worker | _empty_ |

## Confidential release signing

`bun run --cwd packages/app-core release:confidential:sign --input release.json --key authority.pem --output signed-release.json` signs a new dstack application release for the CPU admission profile. The input is JSON with `agentId` (UUID), `compose` (the exact AppCompose JSON bytes as a string), `osImageHash` (64 lowercase hex), `variant` (`dstack-tdx` or `dstack-nitro-enclave`), and UTC `notBefore`/`expiresAt` strings. The key is a local Ed25519 PEM private key. The output must not already exist and is created with mode 0600. Keep signing keys out of images, source control, deployment environment variables and logs.

The measured AppCompose name must be `eliza-<agentId>` so distinct agents receive distinct initial application/key namespaces. The signer checks manifest version `"3"`, matching platform requirements, KMS key-provider pinning, secure time, retained instance identity, disabled public logs/sysinfo and disabled storage discard. It does not review container images, plugins, egress, provider contracts or the rest of the compose document. Only sign an independently reviewed deployment. It derives the new application ID using dstack's first-20-bytes compose-SHA256 convention; it does not infer an existing application ID for upgrades.

Pin the matching `ELIZA_DSTACK_RELEASE_PUBKEY` in measured configuration before hashing compose. Deliver the output as `ELIZA_DSTACK_RELEASE_POLICY_JSON` through the authenticated encrypted launch channel, outside compose. Never place the envelope in the compose bytes it authenticates. The agent CPU profile verifies the domain-separated signature, expected application/compose/OS identity and validity interval; a running process still needs fresh evidence, revocation and KMS policy enforcement.

This command signs release identity only. It does not create a VM, encrypt an environment, establish hardware trust, implement network isolation, migrate SQLite state or authorize confidential inference. TDX VMM provisioning and Nitro Enclave launching remain separate deployment paths. The broader deployment implementation is tracked in [#32097](https://github.com/elizaOS/eliza/issues/32097).

### Provision a stopped TDX VM

`bun run --cwd packages/app-core deploy:confidential:provision --input provision.json --authority authority-public.pem` invokes the dstack VMM `CreateVm` JSON API after checking the release signature and exact compose identity. `DSTACK_VMM_AUTHORIZATION` may carry the existing VMM authorization header; it is never printed. Use an HTTPS VMM origin or a loopback SSH tunnel. No remote HTTP, redirects, simulation or caller-supplied `no_tee` override is accepted.

The request contains the signing input fields above plus `endpoint`, `envelope` (the signed output), `image` (the VMM's installed guest-image label), `vcpu`, `memory` (MiB), `diskSize` (GiB), `encryptedEnv` (already encrypted dstack environment bytes, hex), and `kmsUrls` (HTTPS destinations whose CA identity is pinned in compose). Environment encryption and KMS approval must happen through the trusted provisioning workflow; this command does not fetch an unverified encryption key. The signed OS hash remains the runtime admission identity even if a host substitutes an image behind a label.

The returned JSON includes `vmId`, `appId` and `state: "created-stopped"`. It proves only a VMM receipt, not a running or attested VM. Reconcile inventory before retrying any failed/ambiguous call because CreateVm is not idempotent. This path does not start the VM, expose an ingress port, implement container egress policy, authorize inference or launch an AWS Nitro Enclave. Those remain separate integration and acceptance requirements in #32097.

### Authenticate and encrypt launch secrets

`bun run --cwd packages/app-core deploy:confidential:encrypt-env --input private-launch.json --authority authority-public.pem --key authority-private.pem --output encrypted-launch.json` requests only public key material from the KMS and encrypts the complete environment locally. The private input contains `release` (the signing input), `envelope`, `endpoint` (an HTTPS KMS origin or loopback SSH tunnel), `kmsSigningPublicKey` (66 lowercase hex characters, compressed secp256k1), and `environment` (an array of `{key,value}` strings). Obtain the signer pin through the approved KMS provisioning process. It is separate from the KMS CA identity in compose; do not copy it from the same untrusted response or automatically trust discovery metadata.

The command verifies the release, the KMS signature over application ID/key/timestamp, and a five-minute response lifetime with at most one minute of future clock skew. It refuses legacy signatures, redirects, duplicate environment names and a process-wide TLS verification bypass. It inserts the exact authenticated `ELIZA_DSTACK_RELEASE_POLICY_JSON` and a separate `ELIZA_DSTACK_LAUNCH_AUTHORIZATION_JSON` signature over the complete sorted variable set and release payload hash. The private launch-signing key must match the release authority. Measured `allowed_envs` must include every supplied name and both envelopes; admission and process-loader variables cannot be supplied through this command. Keep the release public key and other admission controls in measured compose, not mutable encrypted environment entries. The result contains `appId` and `encryptedEnv`; supply the latter to the stopped-VM provisioning request for the same signed release. Output is exclusive mode 0600. Input plaintext remains the operator's responsibility; JavaScript cannot guarantee erasure of all original strings.

This is the pinned dstack X25519/AES-256-GCM wire protocol, not a new encryption format. Tests use real HTTP, secp256k1 recovery, X25519 and AES-GCM decryption with synthetic keys. KMS key authentication establishes the configured signer, not independent hardware trust in that KMS. Real KMS attestation, measured container construction, protected storage and running-VM acceptance remain required.

### Verify launch origin before importing the agent

Bake `confidential-bootstrap.mjs` and an immutable configuration file into the digest-pinned image. The measured container command is `node /absolute/path/confidential-bootstrap.mjs /absolute/path/launch-config.json` under Node24.15.0. Configuration contains `entry` (absolute path of the built application module), `publicKey` (release-authority Ed25519 PEM) and `environmentNames` (exact secret-variable names, excluding the two inserted envelopes). The measured compose must map exactly these variables plus the envelopes; keep loader variables and admission controls fixed in the image/compose. Do not accept configuration or entry paths from encrypted environment values.

The builtin-only bootstrap verifies both signatures, release validity, exact configured names and current values before importing application code. The launch authorization prevents an attacker who knows the public encryption key from replacing launch values with a freshly encrypted unauthorized environment. Tests execute a real child Node process and prove that altered/missing secrets, substituted envelopes and a changed variable set never import the application. Hardware admission still belongs to the agent boot gate. A signed environment can be replayed during its release lifetime; deployment-instance binding and online revocation are separate remaining requirements. This bootstrap does not make an untrusted image, mutable configuration, extra unmapped variables or an unsafe dynamic-loader environment secure.
