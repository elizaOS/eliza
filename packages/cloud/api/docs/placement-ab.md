# Staging placement A/B

The API Worker mixes latency-sensitive Durable Object calls, Hyperdrive access,
and external model-provider requests. Smart Placement optimizes the whole fetch
handler, so a remote execution decision can help one origin while adding a
cross-region round trip to another. Do not infer a Durable Object's location
from `cf-placement`: that header identifies Worker fetch-handler execution.

Use `.github/workflows/cloud-placement-ab.yml` only after an operator has
provisioned a temporary default-placement staging control Worker. The workflow
does not deploy, edit, or delete Workers. It rejects production origins and
names, verifies that both health endpoints serve the requested develop SHA,
confirms the treatment reports Smart Placement and the control reports no
placement mode, and compares a privacy-safe fingerprint of their binding
topology before sending probes.

## Control-arm requirements

- Deploy the exact same source SHA as `eliza-cloud-api-staging` under a Worker
  name containing `staging`, with a `workers.dev` origin and no placement stanza.
- Bind the canonical staging Durable Object namespaces externally. Do not let
  the control Worker create fresh namespaces: existing Objects retain their
  original locations, and divergent state would invalidate the comparison.
- Reuse the staging Hyperdrive, KV, R2, rate-limit, and service resources. The
  workflow compares resource identifiers and binding names/types through the
  Workers settings API and fails if the structural fingerprint differs.
- Copy the same protected staging secrets through the account's approved secret
  process. Cloudflare exposes secret binding names, not values, so value parity
  remains an operator-controlled prerequisite that the workflow cannot prove.
- Keep the control unrouted from production and canonical staging domains. The
  workflow accepts only `api-staging.eliza.app` or a staging-named
  `workers.dev` origin.

Provisioning and cleanup are Cloudflare account mutations and require explicit
operator authorization. Record the control Worker name, source SHA, binding
readback, secret-copy procedure, and deletion readback in issue #30099. Do not
run the A/B while the control is missing or while either arm has a different
binding fingerprint.

## Evidence contract

Each pair sends the same generated proof request to both arms concurrently.
The runner continues until it has 30 successful warm pairs or reaches 45
attempts, with separate cold and post-idle controls. Artifacts retain only
bounded placement/colo headers, trace identifiers, phase timings, status/error
tokens, usage counts, output length, and whether the proof matched. Prompts,
generated text, keys, response bodies, and secret values are never written.

The summary reports success/failure counts and p50/p90/p95 for response headers,
first visible token, total time, upstream headers, and each gateway preforward
phase, stratified by arm and observed `cf-placement`. It also captures placement
status before and after the window. A result is evidence for the tested SHA and
traffic window only; it is not authorization to change production placement.

Cloudflare references:

- [Workers Placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Object environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Hyperdrive architecture](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)
