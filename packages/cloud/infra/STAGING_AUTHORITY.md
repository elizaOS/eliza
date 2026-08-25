# Staging deployment authority

Use this runbook before accepting evidence from an Eliza Cloud staging test.
It is a read-only verification procedure: it does not authorize a deploy, a
database migration, a provider mutation, or a production operation. The
canonical runtime map remains [`cloud/RAILWAY.md`](./cloud/RAILWAY.md); checked-in
workflow and service configuration wins if this document drifts.

## Acceptance rule

Create one authority record for the test window. Record full source SHAs and
the GitHub Actions run ID and attempt. Resolve the currently served deployment,
not merely the most recent run that looks successful. The record passes only
when all touched surfaces have positive, coherent evidence and no newer or
in-flight deployment can supersede it during the probe.

`status=running`, a green health endpoint by itself, and the absence of errors
in logs are not deployment proof. A claim that a request was served by a
particular runtime requires a positive log or receipt from that runtime; an
empty log query for the other runtime proves nothing.

| Surface | Source authority | Served/deployed authority | Image authority | Schema authority |
| --- | --- | --- | --- | --- |
| API Worker | `Cloud CF Deploy` run SHA | Worker version/deployment from `Deploy to Cloudflare Workers`, plus the exact SHA and `staging` beacon from `Verify deployed API commit` | Not containerized | Same release's migration-session receipt plus a separate proof that the deployed Worker's Hyperdrive origin resolves the same database authority |
| App Pages (`staging.eliza.app`) | Same Cloud CF run; immutable Pages artifact bound to run ID, attempt, and SHA | Required authority: full Pages deployment UUID, full commit hash, immutable URL, and live asset equality from `Verify Pages frontend freshness`. The current workflow does not emit or persist the required UUID/commit receipt | Not containerized | No direct DB; inherit the API row |
| Console (`cloud-staging.eliza.app`) | Same artifact as App Pages | Same Pages deployment, independently proved on the Console hostname | Not containerized | No direct DB; inherit the API row |
| Telegram ingress (Worker edge or `gateway-webhook-stg`) | Exact API Worker source and served `personalSharedTelegramEdge.enabled` beacon; when disabled, also the protected `Deploy Gateway Webhook` run SHA | `enabled=true`: exact Worker deployment plus positive Worker-edge, delivery-ledger, and provider receipt; `enabled=false`: published exact Railway receipt and currently active deployment ID | Worker edge is not containerized; the Railway digest is not emitted by the current receipt and remains unresolved unless provider metadata supplies it | Inherit the compatible API row; the Railway fallback has no direct SQL access |
| Discord gateway | Unresolved after deployment; the operator checkout is not attested | Railway deployment ID and `/health` + `/ready`; current repository automation does not bind them to a source SHA | Not attested by the current deploy script | No direct SQL access; inherit the compatible API row |
| Connector `SandboxRegistry` route | Attested agent-image source SHA plus the provisioning-worker SHA that injected the registry and route identity | Same Redis authority as the gateway; privacy-safe paired-key/TTL readback; deployed resolver returns `ready` | Running container digest must match the agent-image attestation | Control-plane sandbox row and compatible API migration authority |
| Provisioning worker | `Deploy Eliza Provisioning Worker` `deployment_sha` | `/opt/eliza` HEAD plus the running systemd process identity and post-restart stability evidence | Daemon is not containerized; separately resolve the managed-agent image to a registry digest | Exact-SHA migration plus activation preflight in the same workflow |
| Agent router | Same SHA and checkout as the provisioning worker | Running systemd process plus local and canonical `/healthz` and `/readyz` | Not containerized | Same database and exact-SHA migration authority as the provisioning worker |

An `unresolved` cell is a real evidence gap, not permission to substitute a
mutable tag, a provider status, or a nearby deployment.

## Resolution by surface

### API Worker

1. Select the successful staging run of
   `.github/workflows/cloud-cf-deploy.yml` and record its full `github.sha`, run
   ID, and attempt. The `release` job calls
   `.github/workflows/cloud-cf-release.yml` under the staging mutation lock.
2. In `deploy-api`, retain the Worker version or deployment identifier printed
   by `Deploy to Cloudflare Workers`.
3. Require `Verify deployed API commit` to have read
   `https://api-staging.eliza.app/api/health` with both `commit` equal to the run
   SHA and `environment` equal to `staging`. Also require
   `verify-routing / Verify the just-deployed environment serves itself` to be
   green.
4. Bind the migration-session side of schema evidence to the same release's
   `migrate-db / Run migrations`. If the database identity or resilience gate
   is in `report` or `enforce` mode, retain its non-secret SHA-256 receipts.
5. Separately prove that a read-only probe executed through the deployed
   Worker's `HYPERDRIVE.connectionString` produces the same reviewed database
   authority receipt. The deploy replaces the direct DSN with Hyperdrive at
   runtime, and `/api/health` does not query PostgreSQL; neither the successful
   migration nor the health beacon proves this origin binding. Do not copy a
   connection string, Railway inventory, service ID, volume name, role,
   database name, or hostname into the evidence bundle.

The current Worker and release workflow expose no controlled Hyperdrive database
identity probe. Until one is published and produces the matching receipt above,
mark the API schema origin `unresolved`; do not infer it from `migrate-db` or
`/api/health`.

Fail closed if the health beacon is missing or different, the Wrangler
version/deployment output cannot be recovered, routing verification is red, a
later staging Worker deploy is active, the migration job did not succeed, or
the Hyperdrive authority receipt is absent/different. A Cloudflare dashboard
status alone is insufficient.

### App Pages

The public App and Console are host-aware views of one `eliza-app` Pages
artifact. This is defined in `.github/workflows/cloud-cf-deploy.yml` and the
service map in `cloud/RAILWAY.md`.

The `App Live E2E` staging job is not a Pages proof. It builds and drives a
renderer from the workflow checkout against the staging API; regardless of
its result, it never drives or proves the bytes served by staging Pages.

1. In the same Cloud CF run used for the API, require
   `build-pages / Bind Pages artifacts to this producer attempt`. Its artifact
   identity binds run ID, attempt, and source SHA.
2. Require `deploy-app / Resolve immutable app artifact`. The current
   `Deploy to Cloudflare Pages` step emits an immutable deployment URL but does
   not pass an explicit commit hash to Wrangler or persist the provider's full
   deployment UUID. The full UUID and commit binding are required authority
   fields and are **not currently emitted** by the workflow. Treat that as a
   workflow gap, not as an inferred ID. A protected deploy must pass
   `--commit-hash="$GITHUB_SHA"` and
   `--commit-dirty=false`, set `WRANGLER_OUTPUT_FILE_PATH` to a mode-0600 file
   under `RUNNER_TEMP`. Truncate that file before every retry, parse it only
   after Wrangler exits successfully, and require exactly one record with
   `type == "pages-deploy" && version == 1` and one with
   `type == "pages-deploy-detailed" && version == 1` from that invocation. The
   detailed record must supply the full deployment UUID, immutable URL, alias,
   environment, production branch, and full commit hash. It has no deployment
   branch field: validate the separately commanded `--branch="$PAGES_BRANCH"`
   and its expected alias instead. Reduce the records immediately to the closed
   authority receipt, then delete the private file. Never log or upload the raw
   Wrangler output. `pages deployment list --json` is not a substitute: in the
   pinned CLI it exposes only an abbreviated source SHA and adds a separate
   lookup/race.
3. Require `Verify Pages frontend freshness` for
   `https://staging.eliza.app`. That step compares the live entry assets with
   the exact local `packages/app/dist` artifact and records expected versus
   served asset names.
4. For a credentialed browser proof, validate that the same detailed Wrangler
   row names the first-party alias `https://develop.eliza-app.pages.dev` and use
   that alias as Playwright `baseURL`. Do not navigate the random immutable
   `*.pages.dev` URL: the product CORS policy deliberately rejects random Pages
   subdomains. Before injecting the bearer, require the public renderer manifest
   at both the immutable URL and alias to name the exact run SHA and identical
   build ID, index hash, and asset count; require API health through the alias
   and canonical staging API to name that SHA/environment. Repeat those public
   checks after the browser run. Keep deploy, preflight, browser, and postflight
   inside the caller's staging release lock so the alias cannot move between
   them.
5. Carry the API and schema authority from the same release. A Pages preview
   URL, a successful build, or an origin-only response does not prove the
   staging custom domain.

Fail closed when the full Pages deployment identity or commit binding is
missing, the custom-domain asset set differs, only the preview URL is fresh, or
the API row is not from the same coherent release. Byte equality proves the
served artifact, but does not by itself prove that a browser completed the
staging journey on those deployed bytes.

### Console

There is no independent Console build or deployment ID. Resolve it as the same
Pages deployment as App Pages, then require the separate
`https://cloud-staging.eliza.app` leg of
`deploy-app / Verify Pages frontend freshness`. That leg also verifies the
proxied API route, OIDC discovery, JWKS shape, and Steward callback contract.

Do not infer Console freshness from `staging.eliza.app`: both hostnames must
match the same deployment and exact artifact. Any claimed independent Console
SHA or deployment is a topology error.

### Telegram ingress

The canonical Telegram webhook reaches the API Worker first. Resolve the exact
served Worker through `/api/health` before attributing the request, and record
only its full commit, `environment=staging`, and the boolean
`personalSharedTelegramEdge.enabled` beacon. The protected
`.github/workflows/activate-personal-shared-telegram-edge.yml` workflow can
change that served branch independently of a code deployment, so checked-in
configuration or an earlier gateway receipt cannot substitute for the live
beacon.

#### Edge disabled: Railway forward path

When `personalSharedTelegramEdge.enabled=false`, the Worker forwards the
canonical Telegram webhook to Railway `gateway-webhook-stg`. Its checked-in
deployment authority is `.github/workflows/deploy-gateway-webhook.yml`;
staging dispatches are bound to `develop`.

1. Record the gateway workflow run SHA, ID, and attempt. Download the
   `gateway-webhook-deployment-staging-<sha>` artifact produced by
   `Write exact deployment receipt` and `Publish exact deployment receipt`.
   Its source SHA, environment, service, and Railway deployment ID must agree
   with the run.
2. Require `Wait for the exact Railway deployment` and
   `Verify deployed health and canonical fallback configuration`. The latter
   asserts that the exact deployment ID is active before and after `/health`,
   manifest, canonical fallback, and headerless forwarder-auth probes.
3. When rechecking later, reuse the read-only Railway queries from that step:

   ```bash
   railway deployment list \
     --project "$RAILWAY_PROJECT_ID" \
     --environment "$RAILWAY_ENVIRONMENT_ID" \
     --service "$RAILWAY_SERVICE_ID" \
     --limit 50 --json

   railway service status \
     --project "$RAILWAY_PROJECT_ID" \
     --environment "$RAILWAY_ENVIRONMENT_ID" \
     --service "$RAILWAY_SERVICE_ID" --json
   ```

   Compare the active `.deploymentId` with the receipt without printing the
   token or the service variable values.
4. The current receipt does not attest a Railway image digest. Capture a
   provider-exposed immutable digest only if the read-only deployment metadata
   supplies it; otherwise write `unresolved (workflow gap)`. Never turn a tag,
   deployment status, or Dockerfile path into a fabricated digest.
5. This gateway has no direct SQL schema. Include a compatible API Worker and
   migration authority record because the gateway resolves identity and routes
   through that API.

#### Edge enabled: Worker-native path

When `personalSharedTelegramEdge.enabled=true`, the Worker verifies the
provider webhook, invokes the canonical Personal route, coordinates egress
through the `PERSONAL_TELEGRAM_DELIVERIES` Durable Object namespace, and replies
to the provider directly. The Personal route may select Shared or an already
active Dedicated runtime. Railway remains the protected rollback/fallback
authority; its active deployment does not prove which runtime served this
request.

1. Bind the enabled beacon to the exact Worker deployment and the successful
   protected edge-activation run for the same environment and source SHA.
2. Require a positive trace from `[PersonalTelegramEdge] connector message
   completed`, the matching delivery-ledger terminal state, and a provider
   delivery acknowledgement for the same disposable QA turn. Reduce these to
   closed booleans, timing, outcome, run/attempt, and source SHA; do not retain
   message, chat, sender, agent, token, or reply values. These observations
   prove Worker ingress and egress, not the inference runtime.
3. A Shared-runtime claim additionally requires a closed `runtime=shared`
   receipt bound to the same trace. If the runtime is `dedicated` or cannot be
   proved, mark Shared inference unresolved and never present the journey as a
   Shared canary or Shared-to-Dedicated composite. The current completion trace
   does not emit this runtime receipt, so trace + ledger + provider evidence
   alone cannot close that claim before the Shaw GO.
4. Fail closed if the delivery namespace is absent, the ledger is not terminal,
   the provider acknowledgement is missing, or the trace cannot be bound to the
   exact Worker request. The current activation workflow proves the served
   boolean but does not by itself emit this end-to-end receipt; until a separate
   positive receipt exists, the Worker-native Telegram journey is unresolved.

For a messaging proof, the inbound event must originate from a real disposable
QA account. A mocked webhook is test evidence, not staging ingress evidence.

### Discord gateway

`.github/workflows/cloud-gateway-discord.yml` says explicitly that it validates
configuration and tests but does not deploy. The current operator path,
`packages/cloud/services/gateway-discord/scripts/deploy-railway.sh`, uploads a
staged bundle but does not embed a commit, capture a Railway deployment ID, or
emit an image digest receipt. The Railway service has no connected repository
source.

The read-only Railway deployment and service-status queries shown above can
resolve the active deployment ID. Public `/health` and `/ready` can prove
liveness and readiness. They cannot recover the source SHA of the staged
bundle. Therefore a Discord staging claim requiring exact-source authority is
**blocked by the current deploy rail**, even if Railway reports `SUCCESS` and
both endpoints are green. Do not use the `Cloud Gateway Discord` test run as a
deployment receipt.

An external, access-controlled operator record may close the historical gap
only if it already binds the clean source SHA, immutable image digest, Railway
deployment ID, and activation time. Otherwise a future protected exact-SHA
deploy receipt is required before accepting Discord staging E2E evidence.

### Connector SandboxRegistry route

Dedicated containers self-register the current platform route through two
short-lived Redis keys: `agent:<id>:server` points to a server name and
`server:<name>:url` points to its resolver address. The current
`SandboxRegistry` pipelines both writes with a 90-second TTL and refreshes them
every 30 seconds. The pipeline is not a Redis transaction, so a failed partial
write remains possible; the Telegram and Discord resolvers read the two keys in
order and the evidence contract fails closed unless both are present.

1. Resolve the exact gateway deployment, provisioning-worker checkout, sandbox
   row, running container, and agent-image digest before reading the registry.
   A route without those authorities is not attributable to the candidate
   release.
2. Compare, in memory, that the gateway's Redis authority and the registry
   backend injected into the container identify the same environment-scoped
   service. Report only `same authority: true|false`; never print either URL,
   token, hostname, service ID, or connection fingerprint.
3. Starting from the exact route agent ID already bound to the sandbox row, use
   a least-privilege read-only Redis operation restricted to
   `GET`/`EXISTS`/`PTTL` on its two known keys. Do not discover candidates with
   `SCAN`. An older readback derived from `SCAN` is insufficient for this
   known-keys contract: it discovers candidates instead of proving the exact
   pair already bound to the reviewed route and sandbox. Retain only closed
   fields such as `pairFound`, `bothTtlsPositive`,
   `ttlDeltaWithinBound`, and the UTC sample time. Successive samples spanning a
   heartbeat should remain coherent; key names and values stay in memory only.
4. Run the deployed resolver contract against that same pair and require
   `kind=ready`. Preserve only the normalized result; a server name or URL is
   sensitive operational data and does not belong in the public receipt.
5. Prove HTTP reachability separately from the gateway network, then prove one
   authenticated provider forward and delivery ACK. Registry presence and
   `ready` resolution alone do not prove that the container accepts traffic or
   that Telegram/Discord delivered a reply.

Fail closed if only one key exists, either TTL is absent/expired, the two
authorities differ, the pair cannot be bound to the exact sandbox/image, or a
legacy long-lived pointer is substituted for a current heartbeat. Never scan
or publish raw agent IDs, server names, URLs, Redis values, or provider content.

### Provisioning worker

The staging worker is deployed by
`.github/workflows/deploy-eliza-provisioning-worker.yml`.

1. Record `determine-env / Determine environment`'s exact `deployment_sha` and
   the workflow run ID and attempt.
2. Require `deploy / Run exact-SHA canonical database migrations`, then
   `Deploy and restart worker`. The remote step checks out the immutable SHA in
   `/opt/eliza` and asserts `git rev-parse HEAD` before restarting either
   daemon.
3. During the evidence window, use the same read-only signals as the workflow:
   compare `git -C /opt/eliza rev-parse HEAD` with `deployment_sha`; inspect
   only the `MainPID` and `ActiveEnterTimestampMonotonic` properties from
   `systemctl show eliza-provisioning-worker.service`; and inspect its journal
   since that start. Never run an unscoped systemd property dump, and do not
   dump the systemd environment or `/opt/eliza/cloud/.env.local`.
4. Require the successful `Health check` step. It checks sustained uptime and
   fatal/restart-loop journal patterns. `systemctl is-active` or a row with
   `status=running` on its own is not sufficient.
5. For any dedicated-runtime claim, resolve the selected `ELIZA_AGENT_IMAGE`
   to the immutable `sha256:` produced by
   `.github/workflows/build-agent-image.yml` steps `Push exact verified image`
   and `Generate artifact attestation`. Then positively match the control-plane
   sandbox `image_digest` and the real running container digest. A mutable
   `develop`, `stable`, or `latest` tag is not evidence.

Schema authority is the same exact-SHA migration plus the
`preflight-job-execution-interruptions.ts` check run before restart and again by
the worker's systemd `ExecStartPre`. A jobs/leases/heartbeats observation must
come from the authoritative control-plane database and include freshness; the
sandbox `status` field alone proves neither a live worker nor real compute.

#### Warm-pool billing migration ordering gate (when introduced)

No warm-pool billing exemption migration is present on current `develop`. If a
reviewed migration is introduced, it must be a follow-up release rather than
part of the release that first adds its application guards. The normal
workflows migrate before deploying the new API or restarting the provisioning
daemon. Combining both changes in one release would therefore let an older
process finish a credit debit or provider stop that SQL cannot undo.

Before accepting a run that applies such a migration, require all of the
following:

1. A prior, migration-free release containing the pool-aware Active Billing,
   enqueue, worker, and sandbox-service guards is deployed to the API and every
   provisioning worker. Record both exact source SHAs.
2. Every older worker process is stopped or drained. Resolve the current
   checkout, `MainPID`, and activation time as described above, and prove that
   no process from the pre-guard release can resume work.
3. Only a later release may add and apply the migration. Bind its receipt to the
   guarded API/worker authority from steps 1–2, then re-read pool sandboxes,
   active compute-stop intents, suspend jobs, execution leases, billing state,
   and latest rate segments from the control-plane database.
4. Fail closed if either release identity is unresolved, any old process can
   still execute, or the evidence windows do not overlap. A successful SQL
   migration by itself is not proof that the mixed-version window was closed.

This gate records evidence only; it does not authorize a staging or production
deploy, worker restart, drain, or database migration.

### Agent router

The agent router is installed and restarted from the same `/opt/eliza` checkout
by the same provisioning workflow. It has no separate image or deployment ID.
Its deployed identity is the tuple of exact checkout SHA, systemd process/start
identity, and the successful router probes from `deploy / Health check`:

- the service remains active beyond the stability threshold with no fatal or
  restart-loop journal entry;
- local `http://127.0.0.1:3458/healthz` and `/readyz` pass; and
- the canonical staging host returns JSON with `ok: true` for both endpoints.

Bind it to the same database/schema authority as the worker. The current daemon
logs startup and failures but emits no positive per-request routing receipt.
For a routing claim, require a future privacy-safe correlation receipt from the
router (or an access-controlled proxy receipt that binds the exact upstream)
plus the authoritative route row. Until one exists, mark request routing
`unresolved`; a healthy router plus an absent error log does not prove which
sandbox served a request.

## Cross-surface coherence gate

Before starting a probe, mark every row `proved`, `not applicable`, or
`unresolved`; never leave a blank cell.

- API, App Pages, and Console must come from the same successful Cloud CF
  release. Both Pages hostnames must serve the exact artifact and the API must
  serve that release's staging beacon.
- API schema authority requires both the exact migration-session receipt and a
  matching read-only authority receipt through the deployed Worker Hyperdrive
  origin. If either side is absent, every surface inheriting that schema row is
  unresolved.
- Telegram must first name the exact Worker and its served edge boolean. With
  the edge disabled, the receipt must additionally name the active Railway
  deployment. With the edge enabled, it must instead carry positive
  Worker-edge, delivery-ledger, and provider evidence; the Railway deployment
  is rollback authority, not proof of the serving runtime. Discord remains
  unavailable for exact-source staging evidence while its deployment identity
  gap remains open.
- A connector routing claim additionally requires a live, coherent
  `SandboxRegistry` pair from the gateway's own Redis authority, `ready`
  resolution, the exact container image digest, gateway-to-container HTTP
  reachability, and a positive forward/ACK. No single one of these substitutes
  for the others.
- Provisioning worker and agent router must share the same exact checkout SHA,
  database authority, and activation run. A runtime container must match the
  attested agent image digest selected by that worker.
- Reject stale evidence if a newer deployment became active, a deployment is
  in flight, a service restarted after the recorded checks, a schema gate is
  missing, or the evidence windows do not overlap.
- Re-read jobs, leases, heartbeats, routes, delivery receipts, and container
  state from their authoritative systems. `status=running` never replaces
  those checks.

The composite Shared-to-Dedicated connector E2E remains forbidden until Shaw
records an explicit GO. Do not join separate canaries, browser `localStorage`
handoff, mocks, or partial Telegram/Discord runs and present them as that
funnel.

## Logs and privacy-safe evidence

Cloudflare observability can silently omit events from a broad query. Sweep the
entire test window in consecutive **5-10 second slices**, retaining each slice's
UTC bounds and event count. Retry ambiguous slices. Never conclude that an
event did not occur from one broad query or from “nothing in the logs.”

Keep raw provider and infrastructure records in access-controlled systems. A
shareable evidence bundle may contain source SHAs, GitHub run/attempt links,
UTC timestamps, public hostnames, non-secret SHA-256 receipts, and random
test-scoped correlation IDs. Hash or redact raw deployment/provider IDs in a
public issue while linking to the restricted receipt used for the comparison.

Never print or publish secret values, tokens, cookies, authorization headers,
connection strings, private hostnames or IPs, raw user/org/provider identifiers,
DM content, prompts, model output, or full environment/configuration dumps.
Record secret **name and presence only** when a checked-in gate does so. Use a
random correlation ID that is not derived from a user, conversation, or
provider-native message ID, and quote only the minimum structured log fields
needed to establish the claim.
