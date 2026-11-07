# Cloudflare gateway hosting

Hosts the existing webhook and Discord gateway images. Their authentication,
consent, receipt, queue, and leader-lease implementations remain authoritative.
State uses the selected stores; hosting alone does not retire Redis.

Use `cloudflare/wrangler.toml` with `webhook-staging`, `webhook-production`,
`discord-staging`, or `discord-production`. Deployments start inactive.
Set `GATEWAY_RUNTIME_CONFIG` as one JSON secret containing the running process's
string-valued settings. Preserve all keys and delivery flags. State endpoints
must be reachable from Cloudflare. Supply the exact runtime source as `BUILD_ID`.

Before activation, verify the image and configuration, then stop and drain the
old gateway. Deploy with `GATEWAY_ENABLED=true`. Verify health, authenticated
routing, provider callbacks, and retained receipts before retiring the old host.
After the canonical API release changes routing, run
`DEPLOY_ENVIRONMENT=staging node packages/cloud/scripts/verify-served-webhook-gateway.ts`
from the repository root (use `production` for production). This checks the served
API reaches the healthy Cloudflare image using an invalid verification handshake;
it sends no provider message. Direct gateway health alone is not cutover proof.
Every later active deployment must also set this flag.

For rollback, deploy with `GATEWAY_ENABLED=false`. The next request or cron sends
SIGTERM. Observe the container's stopped state before starting another writer;
a 503 response alone does not prove that shutdown finished.

The protected release verifier can POST a fresh nonce and selected setting names
to `/internal/configuration-proof`, authenticated with the existing bootstrap
secret. It returns source/environment/activation metadata and a nonce-bound digest,
never configuration values. Treat the digest as sensitive and do not log it.
The proof works while inactive; health and container state must be checked
separately before any traffic or ownership change.

Consent can use the native `NETWORK_CONSENT_STATE` binding. Set
`CLOUD_NETWORK_CONSENT_BACKEND=cloudflare`, `NETWORK_CONSENT_URL` to this
Worker's HTTPS `/internal/network-consent` endpoint, and `NETWORK_CONSENT_TOKEN`
in the runtime configuration. The endpoint works while the container is inactive.
Only authenticated current-state reads and writes are public. Import the complete
current projection and retained history through the private binding after all
old writers stop. A serving read or write permanently closes imports for that
project/address. Consent has no expiry; equal timestamps retain an opt-out.
Other gateway state still requires its configured store.

Webhook and Discord delivery receipts, including Twilio inbound reply fences, can use `DELIVERY_RECEIPT_STATE` with
`CLOUD_GATEWAY_RECEIPTS_BACKEND=cloudflare`, `GATEWAY_RECEIPTS_URL` pointing to
this Worker's HTTPS `/internal/delivery-receipts`, and `GATEWAY_RECEIPTS_TOKEN`
in the runtime configuration. Redis remains the default. Transfer the original
receipt keys, raw values, and absolute expiry times through the private binding
only after old writers stop. Import fingerprints survive expiry; serving closes
imports permanently. Expiry alarms remove receipt values. Public access requires
the dedicated credential and cannot import state. Each endpoint accepts only its gateway kind’s key namespace. Ingress holds and
Discord queues still use their existing stores.

Webhook ingress uses `WEBHOOK_INGRESS_STATE` when
`CLOUD_WEBHOOK_INGRESS_BACKEND=cloudflare`. Set `WEBHOOK_INGRESS_URL` to this
Worker's HTTPS `/internal/webhook-ingress` endpoint and `WEBHOOK_INGRESS_TOKEN`
in its runtime configuration. One environment-local transaction owner keeps
dedup markers, Telegram chunk receipts, held payloads, retry scores, and leases
consistent. Only these audited key prefixes and hold operations move; routing,
configuration, and other stores retain their existing authority. Redis is the
default. Stop and drain all old writers before privately importing the complete
key/value snapshot with original absolute expiries (null means persistent) and
the complete retry index. Conflicting imports fail, and any serving operation
permanently closes import. Public requests cannot import or access other keys.

Discord install-welcome queues use `DISCORD_WELCOME_STATE` with
`CLOUD_DISCORD_WELCOME_BACKEND=cloudflare`, `DISCORD_WELCOME_URL` pointing to
this Worker's HTTPS `/internal/discord-welcome`, and `DISCORD_WELCOME_TOKEN` in
runtime configuration. Redis remains the default. Before switching, stop the
old bot owner and wait for its queue to drain, then privately import both lists
in Redis left-to-right order and all retained delivered markers with their
original absolute expiry (null means persistent). Complete raw job values and
list duplicates are retained. Public operations cannot import. Serving closes
imports permanently; the existing managed bot still owns queue start/stop and
Discord nonce deduplication. Other Discord leases and routing state remain on
their configured stores.

Discord coordination can use `DISCORD_COORDINATION_STATE` when
`CLOUD_DISCORD_COORDINATION_BACKEND=cloudflare`, with `DISCORD_COORDINATION_URL`
set to this Worker's HTTPS `/internal/discord-coordination` endpoint and a dedicated
`DISCORD_COORDINATION_TOKEN`. The welcome and receipt backends must also select
Cloudflare. Shared agent-server assignments and activity still use Redis until
the registry writers and readers migrate together. Import the complete audited string/set
snapshot privately after stopping all old writers, preserving raw values, every
set member, and absolute expiry (null for persistent keys). Conflicting imports
fail; serving closes import permanently. Only the existing Discord coordination
key families and the configured leader key are accepted. Lease renewal and
release compare the owner atomically. Redis remains the default.
