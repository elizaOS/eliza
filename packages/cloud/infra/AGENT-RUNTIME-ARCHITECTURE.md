# Shared, dedicated, and handoff architecture

This report records the repository-authoritative request and lifecycle flow for
Eliza Cloud agents. It distinguishes the container-free shared runtime used by
public connector ingress from the per-user dedicated runtime used by signed-in
app and Cloud sessions. It also records the startup failure found during the
code audit and the safeguards added in this change.

## Runtime ownership

| Surface | Runtime | State authority | Typical caller |
| --- | --- | --- | --- |
| Shared agent | Cloudflare Worker shared-runtime modules, Durable Objects, Railway Postgres/Redis/KV | `agent_sandboxes.execution_tier=shared` plus shared history projections | Telegram, Discord, iMessage, web public/connector ingress |
| Dedicated agent | `agent-server` Docker container on a Hetzner data-plane node | `agent_sandboxes` row, `jobs` row, node allocation, container health/heartbeat | Signed-in Eliza app and Cloud console |
| Handoff | Worker shared conversation export/import + dedicated readiness polling | shared history, dedicated conversation receipts, cutover state | Shared-to-personal upgrade and first-run bootstrap |

The product boundary is encoded by `execution_tier`, not by a URL guess. A
shared row has no container and is served by the Worker. A dedicated row owns
Docker, a managed database (when configured), a bridge/web UI URL, a node
allocation, and a lifecycle job.

## Signed-in app/Cloud flow

All signed-in entry points now converge on
`ensurePersonalDedicatedEliza` in `packages/ui/src/api/client-cloud.ts`:

- direct desktop/Cloud login: `bind-direct-cloud-login.ts`;
- `/join` and app-mode entry: `run-join-flow.ts`;
- first-run Cloud onboarding: `listOrAutoProvisionCloudAgent`; and
- a stale Shared client receiving the `personal_eliza_dedicated` routing
  rejection: the retry/repoint boundary in `client-base.ts`.

The full sequence is:

1. The app obtains a Steward/cloud session and reads
   `GET /api/v1/eliza/personal`. This returns the stable logical identity
   `personal:<uuid>` and the authoritative active runtime.
2. If Dedicated is already active, the app validates the returned target URL
   against the active agent id and reconnects without provisioning.
3. If Shared is active, the app reads the server-owned Dedicated quote and
   posts that exact quote to `POST /upgrade-tier`. The server retains the
   credit/runway gate, worker-health gate, org quota, and single-flight target
   creation. Signed-in intent authorizes Dedicated activation; insufficient
   credit fails with 402 instead of falling back to Shared.
4. The API copies the logical identity/config to a separate Dedicated target
   and atomically creates its `agent_provision` job. A retry reattaches to the
   same live target/job.
5. The Hetzner provisioning worker claims the job using `FOR UPDATE SKIP
   LOCKED`, provisions/attaches the tenant database, prepares encrypted env,
   selects an attested Docker node, creates `agent-<id>`, probes health, and
   persists node/container/bridge metadata before completion.
6. While the target is pending, the app retries the cutover boundary. Shared
   remains authoritative, but it is not persisted as the signed-in runtime.
7. The cutover route seals Shared writes, snapshots messages, scheduled tasks,
   todos, and todo mutations, imports them to the healthy Dedicated runtime,
   validates receipt counts and digests, and atomically marks Dedicated active.
   Any failure releases the seal and leaves Shared authoritative for retry.
8. Only the resulting Dedicated base/id is persisted locally. The Worker
   dedicated-agent proxy validates the cloud session and owner,
   swaps in the container `ELIZA_API_TOKEN`, and forwards the request to the
   agent-router on the Hetzner control-plane VM. nginx → agent-router →
   headscale reaches the container.

The older `selectOrProvisionCloudAgent` path also defaults to Dedicated and now
ignores the legacy Shared-first boot preference in signed-in first-run. The
shared preference defaults to false in both boot-config stores. Existing
explicit Shared lifecycle code remains only for legacy-profile recovery and
public/connector use.

```text
Steward session
      |
      v
GET personal identity ---- Dedicated active? ---- yes ---> validate + persist Dedicated
      | no
      v
GET quote -> POST activate -> durable job -> worker -> Hetzner container
                                                    |
                                                    v
Shared seal -> lossless import + receipt verification -> atomic active marker
                                                    |
                                                    v
                                      persist Dedicated and enter chat
```

## Connector/public shared flow

Telegram, Discord, iMessage and similar connector routes resolve the shared
runtime Worker context and execute `runSharedAgentTurn` in the Worker. The
conversation Durable Object and shared-memory projections hold the transcript;
billing/admission caches and the linked character projection are warmed by the
shared prewarm path. Connector delivery can later select a personal dedicated
target only when the explicit personal-dedicated projection resolves one; a
missing target remains Shared and never invents a dedicated URL.

## First-run bootstrap and handoff

During a genuine first dedicated boot (`bridge_url IS NULL`, status
`pending|provisioning`, non-shared tier), `isDedicatedBootstrapWindow` allows
the Worker shared runtime to answer immediately. This is a bounded bootstrap
fallback, not a product-tier downgrade: established dedicated rows, stopped
rows, and error rows are not routed to Shared.

Legacy row-backed Shared agents use `startCloudAgentHandoff`:

1. polls the dedicated row/subdomain for `running`;
2. exports the shared conversation with ordered, lossless messages;
3. imports the transcript into the dedicated conversation and verifies the
   receipt/readback;
4. switches the client base to the dedicated subdomain; and
5. leaves the shared base active if any step fails, so the user has a working
   fallback and an observable retry path.

The account-native rowless personal identity uses the stronger server-owned
cutover route instead. It imports the Shared transcript, reminders, and todos
inside one coordinated seal/commit/release protocol and does not delete the
rowless source. Future connector ingress can therefore resolve the same stable
personal identity while the active-runtime marker selects Dedicated.

## Job and database authority

Dedicated lifecycle state spans several records; no single URL is sufficient
evidence that startup succeeded:

| Authority | Required transition | Failure symptom |
| --- | --- | --- |
| `agent_sandboxes` | `pending → provisioning → running`, with Dedicated tier and target metadata | app polls forever or gets a non-routable target |
| `jobs` | `pending → processing → completed`, or a classified terminal error | accepted create never reaches Docker |
| cloud API DB heartbeat | fresh on the same PostgreSQL authority the daemon reads | API and worker appear healthy but see different queues |
| `docker_nodes` | healthy/attested, capacity allocated to the agent | no node selected, autoscaler churn, or over-allocation |
| warm-pool sentinel row | `unclaimed/ready → claimed`, exact digest and live container | cold provision despite apparent pool capacity |
| container health | routed `/api/health` succeeds after control-plane says running | record is green but chat subdomain 404s |
| personal cutover marker | points logical personal id to imported Dedicated id | new sign-in falls back to Shared again |

The queue is at-least-once. Idempotent enqueue, claim leases, fencing tokens,
and target single-flight prevent retries from minting duplicate billed agents.

## Hetzner and warm-pool lifecycle

The provisioning worker is a systemd daemon on the control-plane VM. It owns
the agent job lane, node health, allocation reconciliation, image pre-pull,
autoscaling, warm-pool drain/health/replenish, and orphan/deletion sweeps.
`docker_nodes` is the authoritative node inventory; Hetzner API state is
attested before adoption or scale decisions. Warm entries are sentinel-org
`agent_sandboxes` rows with `pool_status=unclaimed`, a ready stamp, exact image
digest, node/container identity, and health URL. Claim transfers those fields
to a user row in one transaction, then pushes the user's character and
inference key with attestation/restart recovery.

Warm-pool fill is forecast-based and bounded by tenant backlog and free node
capacity. Health probes retry before reap. Stuck provisioning rows are fenced
and reconciled rather than silently deleted. New capacity is created only after
node health and digest resolution; autoscaling is capped and cooldown-limited.

## Startup failure found and fixed

The daemon's previous startup preflight checked KMS and (for remote providers)
SSH, but did not require `DATABASE_URL` to be present or remote. The DB liveness
check was warn-only. A staging/control-plane process launched without the API's
database URL could therefore open an implicit local/PGlite database, publish a
healthy Redis heartbeat, claim no jobs, and leave every dedicated agent in
`pending` while the API wrote jobs elsewhere. This matches the documented split
database incident pattern.

The daemon now fails before KMS/heartbeat when `NODE_ENV` is not `test` or
`development` and `DATABASE_URL` is missing, malformed, non-Postgres, or
`pglite://`. Tests cover local exceptions, invalid deployed values, and valid
PostgreSQL URLs. The existing periodic jobs/DB-heartbeat liveness check remains
as a secondary split-vs-idle diagnostic.

The compatibility sidecar cron endpoint now also resolves
`PROVISIONING_JOB_LANES` and passes the selected lane to `processPendingJobs`,
preventing a stale sidecar invocation from claiming unrelated Apps jobs while
the agent daemon is pinned to the agent lane.

The signed-in UI was independently bypassing provisioning: direct login,
`/join`, app-mode entry, and first-run called the read-only personal endpoint
and persisted its Shared response. That made a healthy Shared chat look like a
Dedicated startup failure because no Dedicated job was requested at all. Those
paths now call the Dedicated ensure/cutover operation and fail closed if Cloud
cannot activate Dedicated.

The worker deploy workflow had another configuration deadlock. It required
`HEADSCALE_PUBLIC_URL` and `HEADSCALE_API_KEY` to exist in GitHub before SSH,
while its own host reconciliation contract says an absent unrecoverable API key
must preserve and validate the existing host value. Current environment
metadata contains neither setting. The workflow now derives the canonical
public URL from the selected environment and allows the API key to be supplied
by the existing host; the remote preflight still refuses to restart unless the
host value is nonblank. This restores deployability without weakening runtime
validation or exposing the key.

## Failure-mode audit

| Layer | Weakness | Disposition |
| --- | --- | --- |
| Product routing | Signed-in callsites persisted rowless Shared | Fixed: Dedicated ensure + atomic cutover is mandatory |
| Legacy boot config | Shared-first default contradicted product boundary | Fixed: default false in both stores; signed-in path ignores the knob |
| Worker DB | daemon could publish liveness against implicit PGlite/wrong DB | Fixed: deployed startup requires a valid PostgreSQL `DATABASE_URL` |
| Queue lanes | compatibility sidecar could claim every job type | Fixed: same lane resolver as daemon |
| Worker deploy | CI required missing Headscale metadata before it could validate preserved host authority | Fixed in workflow as described above |
| Live acceptance | the Dedicated canary's workflow contract omitted the newer `group-chat` suite, so its preflight failed before executing the canary | Fixed: the contract now matches the dispatch inventory; failed run `33018915061` created no agent |
| Staging admission | the credentialed Dedicated canary is below the server-owned hosting-runway threshold | Operational blocker: exact-head run `33020269187` received 402 with zero agents/jobs; restore staging test credit through the billing authority |
| Warm pool | enablement and live ready-count are host/DB state, not observable from public health | Operational proof still required |
| Deployment capacity | earlier production deploys queued/cancelled on unavailable runner labels | Partially cleared: run `33017962389` deployed the worker/router successfully; it predates this fix and is not a Dedicated canary |
| Staging secrets | staging environment metadata lacks provisioning host/key inventory | Credential/config blocker; cannot repair from repository code |
| Full validation | the original shared checkout contains an unrelated conflict in `eliza-sse-bridge.ts` | Isolated: this change is validated from a clean worktree rebased on `origin/develop` |

## Remaining operational weaknesses

- Production acceptance still needs a live authority record: worker SHA/systemd
  identity, API/Hyperdrive database identity, node health, and a real dedicated
  chat readback. Local or mocked tests cannot prove Hetzner reachability.
- The Worker cannot itself see Docker logs; failed startup diagnosis depends on
  durable job error/result fields and control-plane journals. Keep those fields
  privacy-safe but sufficiently classified for operators.
- Warm-pool replenishment is intentionally best-effort and can defer under
  tenant contention. An empty pool increases cold-start latency but must fall
  back to the normal dedicated provision path.
- The sidecar endpoint is compatibility plumbing; production scheduled work is
  daemon-owned. Running both daemons against one database must keep explicit
  lane settings and exact-SHA deployment evidence.
- Database identity and resilience gates are separate from this code change;
  operators must still prove the intended Railway service/volume, Hyperdrive
  origin, backups, and restore drill before enabling enforcement.

## Read-only deployment snapshot (2026-08-26)

The first public health snapshot reported production at
`68a3de6c873bbb753eebc15601b2984819bf4a2f` and staging at
`b100682147cb13235db728ada7b1696d74e0d2a3`. During the later inspection:

- production run `33017515871` targeted main SHA
  `797a5246055ab2d00805fd6f7657af7747f2bd2f`; environment resolution passed,
  but the unassigned deploy job was ultimately cancelled without running a
  step;
- the preceding main deploys were cancelled after several minutes rather than
  completing, but a later retry, run `33017962389`, completed for exact main
  SHA `10fcb3f4d2130678651a6dc43f412e865655c4dc` and reported the worker and
  router stable after 22 seconds;
- every registered `hetzner-robot` runner with the production-specific name was
  offline, although generic self-hosted robots were online;
- environment metadata showed `DATABASE_URL` and production SSH target
  credentials, but no environment-level `HEADSCALE_API_KEY`,
  `HEADSCALE_PUBLIC_URL`, `WARM_POOL_ENABLED`, or `ELIZA_AGENT_IMAGE`. The
  successful deploy used the canonical production Headscale URL and preserved
  any host-only settings; its `WARM_POOL_ENABLED` workflow input was blank, so
  it did not prove the effective host value or pool inventory; and
- staging metadata did not expose the provisioning host/key pair needed by the
  deploy job.

The successful worker deploy proves systemd/router liveness and an immutable
image digest (`sha256:e6a18933fdf1cc0e65bb388d05f52e7b3c3a6260cd5058c6de02b76ae5f07823`).
It does not prove database identity, warm-pool rows, node capacity, cutover, or
one Dedicated chat. It also predates both the deployed-DB fail-fast guard and
the signed-in Dedicated ensure path in this change. A production dispatch from
a non-main test ref correctly failed the protected-source guard.

A staging Dedicated-canary dispatch, run `33018915061`, passed its real-Cloud
credential and target preflights but stopped in deterministic contract tests:
the workflow had gained the `group-chat` selector while the canary test still
asserted the older option list. The live step was skipped, no evidence artifact
was produced, and no agent was created. This change updates that contract; a
new exact-head dispatch is still required for platform acceptance.

The repaired exact-head workflow then ran as `33020269187`. It passed the
workflow contracts and artifact privacy gate, but the real create boundary
returned HTTP 402. Its sanitized artifact records staging commit
`02f45de149dad7c82dc7a67aa68f66d1e33a3521`, zero created agents, zero chat
requests, cleanup `not-required`, and no possible orphan. This proves the
current failure occurs before queue insertion, warm-pool claim, node selection,
or Docker startup: the staging canary identity lacks the server-required
hosting credit/runway. The canary now classifies this as
`insufficient_hosting_credit` instead of the generic `unexpected_http_402`.
Restoring that staging test balance is a billing-authority operation, not a
Hetzner repair, and must be followed by a fresh canary after this SHA is
deployed to staging.

Required acceptance evidence is: one non-cancelled exact-SHA worker deploy;
systemd active identity and effective env-name audit; matching API/daemon DB
heartbeat authority; node and warm-pool counts; a fresh signed-in activation;
terminal provision job; routed container health; atomic cutover receipt; and a
real chat write/readback from the Dedicated base. No local test or public health
beacon substitutes for that chain.

The warm-pool claim and replenish halves are intentionally disabled in current
source while issue `#16961` remains open. Every committed Cloudflare Worker
environment has `WARM_POOL_ENABLED = "false"`; enabling only the Hetzner daemon
would therefore spend compute on containers the API cannot claim. Conversely,
enabling only the Worker would find no replenished capacity. The deploy repair
in this change makes the protected environment variable authoritative with a
safe `false` default, validates it as an exact boolean, reconciles that value
over unknown host state, and verifies the same value again after restart. It
does not activate the pool. Staging activation still requires the recorded
identity, billing, capacity, starvation, digest, health, and rollback evidence
before both halves may be flipped together.
