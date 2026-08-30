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
| Handoff | Worker shared conversation export/import + dedicated readiness polling | shared history, dedicated conversation receipts, cutover state | Explicit Shared-to-personal upgrade |

The product boundary is encoded by `execution_tier`, not by a URL guess. A
shared row has no container and is served by the Worker. A dedicated row owns
Docker, a managed database (when configured), a bridge/web UI URL, a node
allocation, and a lifecycle job.

## Signed-in app/Cloud flow

Account-native signed-in entry points now converge on
`ensurePersonalDedicatedEliza` in `packages/ui/src/api/client-cloud.ts`:

- direct desktop/Cloud login: `bind-direct-cloud-login.ts`;
- `/join` and app-mode entry: `run-join-flow.ts`;
- a stale Shared client receiving the `personal_eliza_dedicated` routing
  rejection: the retry/repoint boundary in `client-base.ts`.

First-run Cloud onboarding also converges on the Dedicated boundary. It first
offers to adopt an existing Dedicated agent owned by the account; otherwise it
creates one and waits under an absolute startup deadline for the provision job
and running container before persistence. A repository-wide
caller audit found no production caller of `getPersonalSharedEliza` outside
`ensurePersonalDedicatedEliza`, and no production boot configuration that
forces `preferSharedTier`, `preferSharedCloudTier`, or the legacy automatic
Shared handoff switches on.

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
6. While the target is pending, the app retries the cutover boundary under a
   bounded deadline. The target cannot answer through Shared: chat remains
   unavailable until the real Dedicated container is ready. For a legacy
   Shared-to-Dedicated migration, the source remains the rollback authority but
   the signed-in app does not execute new turns against it during activation.
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

## Dedicated readiness barrier and handoff

There is no Shared execution bootstrap for a Dedicated row. The shared-agent
resolver admits only `execution_tier=shared`; its cache cannot hold a positive
Dedicated scope. `ElizaSandboxService.bridge` and the Shared REST character
adapter require a running Shared row and return unavailable for a pending or
provisioning Dedicated row. This is the server-side enforcement behind the
product rule: a Dedicated agent is either served by its own container or is not
yet available.

Legacy row-backed Shared agents use `startCloudAgentHandoff`:

1. polls the dedicated row/subdomain for `running`;
2. exports the shared conversation with ordered, lossless messages;
3. imports the transcript into the dedicated conversation and verifies the
   receipt/readback;
4. switches the client base to the dedicated subdomain; and
5. leaves the source and seal authority intact if any step fails, so the user
   can explicitly retry without partial import or lost history. It does not
   silently repoint a signed-in session to Shared execution.

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

## Startup failures found and fixed

The daemon's previous startup preflight checked KMS and (for remote providers)
SSH, but did not prove the effective database authority. A control-plane
process could therefore open implicit PGlite, or a nonempty
`TEST_DATABASE_URL` could override a valid `DATABASE_URL`, publish a healthy
Redis heartbeat, claim no API jobs, and leave every Dedicated agent pending
while the API wrote elsewhere.

The daemon now resolves the same effective URL as the database client before
KMS or heartbeat. Outside test/development it rejects a nonempty
`TEST_DATABASE_URL`, whitespace-only/malformed URLs, PGlite, non-PostgreSQL
schemes, missing hosts, loopback/unspecified hosts, and socket-host overrides.
Only an explicit remote PostgreSQL authority may start the deployed worker.
The periodic jobs/database heartbeat remains a secondary split-vs-idle signal.

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

A later audit found a second routing violation: pending/provisioning Dedicated
rows were deliberately admitted to the Worker Shared runtime as a first-boot
fallback. The Shared REST adapter then reported `cloudProvisioned=true`, so a
signed-in user could send Shared turns while believing the Dedicated agent was
ready. This change deletes that bootstrap helper and its positive cache/bridge
paths. Regression tests prove every Dedicated lifecycle state is refused by the
Shared resolver and that pending agents expose neither Shared chat nor character
data.

The first live staging failure was earlier than Docker. An exact-suffix,
read-only query against the authoritative staging database showed a ready
database connection, an exhausted three-attempt `agent_provision` job, no
primary or replacement container locator, and the allowlisted category
`container_steward_agent_registration_not_found`. The provisioning worker was
calling Steward's retired
`/platform/tenants/{tenantId}/agents` registration route; the deployed Steward
OpenAPI no longer publishes that route and returned HTTP 404. This ruled out
node selection, volume setup, image pull, Docker create, Headscale, container
health, and warm-pool claim as the cause of that specific failure.

Dedicated provisioning now uses the same canonical authentication contract as
the cloud API: the worker mints an RS256 agent JWT with the protected Eliza
signing key, and Steward verifies it through the public cloud JWKS. The legacy
Steward registration/token command remains only as a local-development fallback
when no signer exists; staging and production deployment both require the
signer and therefore cannot enter that retired path. Cleanup also attempts
legacy Steward deregistration only when a legacy registration was actually
created.

The provisioning deploy did not previously reconcile the agent-token signing
key to the systemd worker. The workflow now requires the protected environment
secret, masks and base64-encodes it for the GitHub-to-SSH boundary, validates
the decoded PKCS8 envelope on the host, and writes the existing single-line
escaped-PEM representation through the root-owned atomic EnvironmentFile
serializer. No key bytes enter argv or diagnostics. Exact staging deployment
run `33283979364` completed migrations, host reconciliation, daemon restart,
and sustained health for worker source
`3921aa7d65d5ccd57735b20899442b3787b27958`.

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
| Bootstrap isolation | pending/provisioning Dedicated rows executed through Worker Shared and appeared provisioned | Fixed: Shared resolver/cache/bridge now admit only Shared rows; Dedicated waits for its container |
| Legacy boot config | Shared-first default contradicted product boundary | Fixed: default false in both stores; signed-in path ignores the knob |
| Worker DB | daemon could publish liveness against implicit PGlite or a `TEST_DATABASE_URL` override | Fixed: deployed startup validates the effective remote PostgreSQL authority before heartbeat |
| Queue lanes | compatibility sidecar could claim every job type | Fixed: same lane resolver as daemon |
| Worker deploy | CI required missing Headscale metadata before it could validate preserved host authority | Fixed in workflow as described above |
| Worker deploy tests | deletion-only backup authority was enabled in the Hetzner workflow while four tests still asserted the retired dormant/disabled contract | Fixed: contracts now require the dedicated R2/Hetzner allowlist and live deletion-cycle health while excluding KMS, Headscale, SSH, capture, and scheduler authority |
| Live acceptance | the Dedicated canary's workflow contract omitted the newer `group-chat` suite, so its preflight failed before executing the canary | Fixed: the contract now matches the dispatch inventory; failed run `33018915061` created no agent |
| Canary diagnostics | cleanup failure overwrote the original provisioning failure and terminal job details collapsed to `job_failed` | Fixed in this change: preserve the primary phase and emit only an allowlisted subsystem category |
| Staging admission | the canary identity was below the hosting-runway threshold | Cleared: run `33280890733` created one Dedicated row/job; the failure moved into provisioning |
| Steward bootstrap | worker called a retired platform agent-registration route and received 404 before Docker create | Fixed: canonical Eliza-minted JWT/JWKS auth; protected signer reconciled to the worker |
| Current staging provision | post-auth-fix canary `33284501109` still reached terminal failure before running/database/mesh readiness | Open: exact-suffix read-only diagnostic `33285177540` is queued; do not infer the next subsystem from the public artifact |
| Warm pool | both Worker and daemon are protected-off; no ready-count or live-claim proof exists | Intentionally disabled pending `#16961`; cold provisioning must work independently |
| Deployment capacity | earlier production deploys queued/cancelled on unavailable runner labels | Partially cleared: run `33017962389` deployed the worker/router successfully; it predates this fix and is not a Dedicated canary |
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

## Read-only deployment snapshot (2026-08-29)

Staging provisioning-worker deployment run `33247669428` completed migrations,
immutable checkout, host reconciliation, daemon/router restart, and sustained
health for source SHA `4635c6496e7d898452b0f942538cfb41900f2a7b`.
That revision contains three clean-host repairs discovered after the original
architecture change: the PTY plugin declares its shared workspace dependency,
the worker receives Steward authentication authority, and deploy dirt checks
ignore an unused submodule without ignoring tracked source drift. The SHA is an
ancestor of current `develop`.

The public staging health endpoint observed by canary run `33280890733` reported
API commit `2a4af7351c96881b83333fabb37927222dbb09fd`. The run passed credential,
target, checkout, and contract preflights, then created exactly one
`dedicated-always` row and provisioning job. The job terminated after roughly
200 seconds before `running`, tenant database readiness, a fresh heartbeat,
Headscale address, bridge transport, SSE, or chat. Cleanup also failed while
waiting on the already-failed provision job, so the privacy-safe artifact marks
a possible orphan. No user prompt, response, credential, agent id, hostname, or
private network address is present in the artifact.

That run proves the current blocker is no longer billing admission and is not a
Shared/Dedicated tier-selection error. It lies inside the real provisioning
job—database creation, secrets, image, Hetzner capacity/container, SSH,
Headscale ingress, or runtime startup. The old canary retained only
`cleanup_job/job_failed`, erasing the primary diagnostic. This change preserves
the original provisioning phase and maps the owner-safe job error into a fixed
privacy-safe subsystem category. The next branch canary is therefore the
decision point for the remaining repair.

The exact database diagnostic later identified the retired Steward registration
route as that failure. Worker deploy `33283979364` installed the JWT/JWKS fix,
and exact cleanup run `33284176034` removed the controlled stale canary. Fresh
canary `33284501109` still failed before running and emitted only
`provisioning_private_diagnostic`; its public evidence correctly does not expose
the private job reason. It also observed staging API commit
`b3d3e890b0e0f4f58f904bce5d56d9bfccfa49f6`, which does not contain this branch
head. A final acceptance run therefore requires both the diagnosed next worker
repair and an API deployment that contains the exact tested source.

Required acceptance evidence is: one non-cancelled exact-SHA worker deploy;
systemd active identity and effective env-name audit; matching API/daemon DB
heartbeat authority; node and warm-pool counts; a fresh signed-in activation;
terminal provision job; routed container health; atomic cutover receipt; and a
real chat write/readback from the Dedicated base. No local test or public health
beacon substitutes for that chain.

The warm-pool claim and replenish halves are intentionally disabled while issue
`#16961` remains open. Every committed Worker environment uses
`WARM_POOL_ENABLED="false"`, and the Hetzner deploy reconciles and re-attests the
same protected false value after restart. Enabling only the daemon would spend
compute the API cannot claim; enabling only the API would find no replenished
capacity. Do not use the pool to mask the cold-path failure. Activation requires
recorded billing, capacity, starvation, digest, health, claim, and rollback
evidence for both halves in one controlled change.
