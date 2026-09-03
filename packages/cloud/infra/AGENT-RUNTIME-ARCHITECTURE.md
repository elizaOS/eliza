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
| Headscale key identity | tagged pre-auth keys also carried a user, which conflicts with Headscale v0.28 tag-as-identity | Fixed: `tag:agent` keys omit user ownership; mixed input is rejected before network I/O |
| Headscale observation | an arbitrary stale host `VPN_REGISTRATION_TIMEOUT_MS` made the worker abandon a join before the container's own 120-second bound | Fixed: deploy and source enforce a minimum 180-second control-plane observation budget |
| Container mesh classifier | the entrypoint treated ordinary fresh-daemon `NeedsLogin` and `machineAuthorized=false` transition records as terminal interactive auth | Fixed: only an AuthURL, `NeedsMachineAuth`, or an explicit invalid/expired/used-key result is terminal; transient login remains under the bounded join observation |
| Current staging provision | database and Docker are proven; the repaired image still requires a digest-pinned staging cold-path canary | Acceptance pending in the live deployment record below |
| Failed replacement deletion | the API rejected every lifecycle job, including exact conditional cleanup, whenever a failed provision retained a replacement locator | Fixed: exact conditional delete owns the row, then the daemon proves that replacement absent before deleting the serving generation; ordinary lifecycle requests remain blocked |
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
`provisioning_private_diagnostic`; its public evidence correctly did not expose
the private job reason. It also observed staging API commit
`b3d3e890b0e0f4f58f904bce5d56d9bfccfa49f6`, which does not contain this branch
head. The first read-only diagnostic attempt then found a legitimate terminal
non-retryable job whose attempt count was below `max_attempts`; source
`eddbdb8fc41fbd780094eae1b06ce9b211599a2b` removed that invalid sanitizer
assumption.

Diagnostic run `33286940453` then proved that the job had exhausted six
attempt-preserving retries before any counted attempt and retained no container
locator. A later diagnostic exposed `container_replacement_cleanup_pending`.
Source `51aba8f553c4735c2e91b38aa731eb98bf622a20` preserved the original startup
failure alongside the cleanup error within one attempt; source
`d28d7808a009e44de6855201cd47b62b199320e8` preserved it across later
cleanup-only retries. Exact worker deployment `33289529464` installed that
source with migrations, systemd reconciliation, restart, and sustained health.

Fresh canary `33288807064` created exactly one row but failed after a roughly
twelve-minute create wait. Diagnostic `33289343188` proved a durable exact
replacement locator (node, container name, attempt id, and Docker id; no VPN
node) with no primary locator. Cleanup-only run `33289718945` never crossed the
destructive boundary: the API returned HTTP 409 before enqueue because its
lifecycle admission rule rejected the very replacement fence that cleanup had
to retire. Read-only diagnostic `33290162302` later confirmed the same fenced
identity remained intact. Source `51286511c72c9d690d8295c12e31e154b2822cb0`
repairs that deadlock. Its real-PostgreSQL test proves exact conditional delete
ownership preserves the locator, and execution tests prove the main generation
is never deleted until exact remote absence converges. A final acceptance run
still requires a canonical API deployment containing that contract, exact
cleanup of this fenced canary, the newly exposed primary startup repair, and a
fresh end-to-end canary.

The reconciliation daemon subsequently proved the first fenced Docker
candidate absent and atomically cleared its replacement locator; read-only run
`33290462901` observed the cleared fence, and cleanup-only run `33290496255`
then deleted exactly that canary without creating another agent. Fresh canary
`33290598051` reached `database_status=ready` and created an exact Docker
candidate, but it never obtained a VPN node, Headscale address, heartbeat,
bridge, SSE stream, or chat readback. Read-only diagnostics `33291163769` and
`33291437021` classify the durable failure as
`ingress_headscale_ip_missing`; the latter uses the narrower privacy-safe
classifier and confirms the replacement container identity is complete while
the VPN identity is absent.

That older attempt replaced the precise mesh failure with the generic required
ingress verdict. Source `7cd43bb88be1ee6aa755bd7c719acad4f45c1582`
preserves every recorded remote-completion cause behind the durable failure and
exposes only closed categories for Headscale API authentication/failure,
container mesh authentication, candidate exit, registration completion,
rename completion, and exact Docker/VPN identity mismatch. Worker deployment
`33291449482` installed that exact source after migrations, immutable checkout,
systemd restart, and sustained health. The next clean candidate can therefore
identify the real private-ingress failure without publishing raw logs,
credentials, hostnames, container ids, or tailnet addresses.

Subsequent canaries and exact-suffix diagnostics completed the ingress root-cause
chain. Candidate `r33296439529a1` preserved `ingress_mesh_auth_required`; after
the reconciliation grace, read-only proof showed every primary and replacement
locator absent and cleanup-only run `33299360541` deleted only that row. The
first repair aligned pre-auth creation with Headscale v0.28: a `tag:agent` key
is tag-owned and therefore omits user ownership. This is the documented
[tagged-device registration contract](https://headscale.net/0.28.0/ref/tags/)
and the v0.28 [tags-as-identity change](https://github.com/juanfont/headscale/releases/tag/v0.28.0).

Candidate `r33299484527a1` exposed an independent diagnostics defect: cleanup
retries recursively embedded the already-serialized job error until the row
exceeded the classifier's former input limit. The worker now keeps the first
redacted startup error byte-stable and records only the current cleanup
condition separately. Read-only run `33300752911` then classified the original
mesh-auth failure without emitting the raw error, container identity, hostname,
or tailnet address. Multi-registration cleanup source deployed in run
`33325686108`; read-only run `33326873615` proved all locators absent, and
cleanup-only run `33326921381` deleted exactly the stale candidate with zero new
agents and zero chat requests.

Fresh canary `33327070651` again selected `dedicated-always`, reached a ready
tenant database, and created an exact Docker candidate, but obtained no VPN
node. Diagnostic `33327782736` showed that its final retry executed for only
`6113ms`, even though container `tailscale up` permits 120 seconds and source
intended a 180-second observer. The deploy had never owned
`VPN_REGISTRATION_TIMEOUT_MS`, so a stale short host value survived immutable
source deployments. Source `dcd9a3a744c5e985f84cf679f828c5653288175a`
made `180000` repository-owned, atomically reconciled it through the protected
systemd EnvironmentFile, and attested exact equality after restart. Deployment
`33328209418` passed migrations, reconciliation, restart, and health. Source
`ebcf1d634863e16a1245065897f4eb11d9051319` also rejects malformed or shorter
runtime overrides, and exact deployment `33328974769` installed that guard.

After the 30-minute destructive-safety grace, read-only run `33329084735`
proved all primary and replacement locators and the cleanup fence absent for
`r33327070651a1`. Cleanup-only run `33329224705` then deleted exactly that row,
created no replacement, issued no chat request, and returned a confirmed
cleanup receipt. This establishes that failed-candidate retirement is
convergent without weakening the exact identity fence.

Canary `33329614860` was the decisive image-level reproduction. It again
reached a ready tenant database and an exact Docker replacement, then retained
`ingress_mesh_auth_required`; read-only diagnostic `33330411640` showed six
retryable requeues and a terminal six-second attempt. Code and official
Tailscale behavior then identified the false positive: a fresh backend normally
passes through `NeedsLogin` while authentication starts, but both Eliza image
entrypoints killed `tailscale up` as soon as they saw `NeedsLogin` or
`machineAuthorized=false`. Those are transition facts, not proof that a tagged
pre-auth key was rejected. The repaired entrypoints keep observing them and
stop only for an actual AuthURL, `NeedsMachineAuth`, or explicit
invalid/expired/already-used key. Control-plane log classification uses the same
contract. Regression fixtures exercise both image entrypoints and prove that a
delayed successful auth-key join starts the agent while definitive interactive
auth still exits with the distinct re-key signal.

Canonical image build `33330636941` built source
`f154fd0d8b7e5a86c891e902566a04b28d701a92`, booted the real agent entrypoint,
published and attested `ghcr.io/elizaos/eliza:sha-f154fd0` at digest
`sha256:d4bc56fb4a4daac3aaecc5c743620eaa00e7a7796d7152eafab73134f900eb43`,
and proved anonymous pullability. That canonical publication is build evidence;
staging remains pinned to the separate digest-preserving `eliza-demo` canary
repository, so it must not be repointed until an exact demo promotion has passed
the same boot gate.

Demo publication run `33473710420` then rebuilt rebased source
`b8ba0e5908f6a70a6860ab29b3c24c5e293b45df`, booted the real entrypoint,
published the canonical image, and copied its manifest byte-for-byte to
`ghcr.io/elizaos/eliza-demo:sha-b8ba0e5`. Both repositories resolve to
`sha256:6cba66dd2f55656ee1f657679c0aff6af15d449ae55e84a85753da0572ad873c`;
the demo subject is attested and anonymously pullable. The protected staging
`ELIZA_AGENT_IMAGE` variable was then updated from its August 28 digest to the
exact `eliza-demo@sha256:6cba66dd...873c` reference and read back through the
GitHub environment API. No mutable tag is used by the worker.

Exact staging deployment `33475270167` then applied canonical migrations from
`b8ba0e5908f6a70a6860ab29b3c24c5e293b45df`, reconciled the protected worker
EnvironmentFile (including the new image digest, the repository-owned
180-second VPN observation budget, and warm pool disabled), restarted the
Hetzner control-plane services, and passed the sustained local and public
health gates. The deployment job and its environment-resolution job both
completed successfully; this is the source now responsible for the next cold
Dedicated acceptance run.

The September 1 branch rebase exposed a separate GitHub control-plane fact.
Staging uses a custom deployment branch policy whose only durable entry was
`develop`, so diagnostics dispatched from the repair branch were rejected before
runner allocation. Check-run annotations explicitly reported the branch-policy
denial; this was not an application, database, Hetzner, or runner-capacity
failure. An exact temporary policy entry for
`fix/dedicated-shared-bootstrap-isolation-29341` admitted only this repair branch
for the bounded staging recovery. It must be removed after the final canary so
the environment returns to its original develop-only policy.

Once admitted, read-only diagnostic `33473859601` re-proved that failed canary
`r33329614860a1` was `dedicated-always`, its tenant database was ready, its job
retained `ingress_mesh_auth_required`, and every one of the four primary and six
replacement infrastructure locators was absent. Cleanup-only run `33474048809`
then deleted exactly that target. Its strict artifact reports `verdict=pass`,
`createdAgents=0`, `chatRequests=0`, `recovery.match=one`,
`recovery.confirmed=true`, `cleanup.status=passed`, and
`possibleOrphan=false`. The stale database row and capacity guard are therefore
clear without guessing at remote infrastructure identity.

Fresh canary `33475627875` proved that the repaired entrypoint no longer
misclassified Headscale's normal authentication transition: the durable
category moved from `ingress_mesh_auth_required` to
`ingress_headscale_ip_missing`. It selected `dedicated-always`, created exactly
one agent, and reached a ready tenant database, but never recorded a Headscale
address, heartbeat, bridge, SSE completion, or chat path. Read-only diagnostic
`33526283803` found all primary and replacement locators absent and showed six
retryable requeues; its terminal attempt retained the missing-address category.
Cleanup-only run `33526404108` then matched and deleted exactly
`r33475627875a1`, with zero created agents, zero chat requests, a confirmed
recovery receipt, `cleanup.status=passed`, and `possibleOrphan=false`.

That failure exposed a second Headscale observation race. Provisioning records
`vpnRegistrationStartedAt` before Docker create, but the collision-suffixed
node lookup previously used a new timestamp captured only after Docker start
and immediately before polling. A container that joined quickly while the
preserved node still owned the base hostname was legitimately renamed by
Headscale, yet its `createdAt` preceded the poll timestamp and the safety filter
rejected it forever as if it were a stale orphan. The fix makes the durable
provisioning-attempt timestamp the suffix-admission boundary while retaining
the exact prior-node exclusion. A real-client regression covers a registration
that occurs after attempt start but before polling, and the provider contract
proves that it passes the persisted boundary. Exact source
`bc49934cb93dc5257a7138eae44bcb937d0293a4` passed the focused Headscale and
replacement-cleanup suites, Cloud shared typechecking, and formatting. Worker
deployment `33527374585` applied its migrations, reconciled and restarted both
Hetzner worker units, and passed the exact-source health gate. A fresh cold-path
canary was therefore required rather than treating the focused regression as
production proof.

Fresh canary `33527945357` still failed at the same observable boundary. Its
strict artifact selected `dedicated-always`, created exactly one agent, made no
chat request, and reported `provisioning_private_diagnostic` after 744,962 ms;
the first cleanup attempt could not prove deletion and correctly retained
`possibleOrphan=true`. Read-only database diagnostic `33529492209` then proved
the tenant database was ready, the terminal category remained
`ingress_headscale_ip_missing`, and the sixth retryable attempt retained exact
replacement locators for its sandbox, node, container, provisioning attempt,
and Docker container ID but no VPN node ID. The database and retry queue were
therefore functioning; the failure was after container creation and before
durable mesh registration.

Privacy-safe worker-journal diagnostic `33529982508` narrowed that exact attempt
to `registration_timeout`. It found no Headscale authentication or API failure,
binding mismatch, rename conflict, or terminal-container signal. Exact cleanup
`33532364883` subsequently matched and removed the single canary target. Its
strict artifact reports `verdict=pass`, `createdAgents=0`, `chatRequests=0`,
`recovery.match=one`, `recovery.confirmed=true`, `cleanup.status=passed`, and
`possibleOrphan=false`.

The journal category did not expose whether Tailscale inside the short-lived
container was waiting for authorization, failing to reach its daemon, or had
already exited. The recovery therefore added an exact-locator, read-only
candidate probe. It derives the active replacement locator from the database,
uses the host-key-pinned Hetzner SSH client, and emits only closed booleans and
enums for container state, Tailscale backend state, machine authorization,
socket/daemon reachability, mesh-address presence, and known startup-log
categories. It never exports database identities, hostnames, IP addresses,
container logs, or SSH errors. Early diagnostic-only runs exposed bounded-tool
defects rather than application evidence: one omitted the suffix environment,
and concurrent first-use SSH observations on one pooled client exceeded the
outer timeout. Exact source `98e8b865e296f93dfdd38361e13778fbccbd830a`
serializes those observations, bounds each at eight seconds, closes pooled SSH
handles, and exits explicitly. Worker deployment `33532669836` deployed that
exact source and passed its migration, restart, source-identity, and health
gates. The next failed exact candidate, if any, can now be distinguished without
guessing or exposing private infrastructure data.

Cold-path canary `33535281990` then reproduced the same failure on the exact
deployed worker source. Its artifact selected `dedicated-always`, created one
agent, issued no chat request, and failed after 741,550 ms with no running,
database-ready, heartbeat, mesh, bridge, SSE, or cleanup proof. Diagnostic
`33546043861` found the tenant database ready and the terminal
`ingress_headscale_ip_missing` result after six retryable requeues. Each failed
attempt's exact-success cleanup had already removed its candidate and cleared
the replacement fence before the diagnostic ran, so the out-of-band probe
correctly skipped; there was no surviving locator to inspect and no safe basis
for reconstructing one.

The final observation therefore belongs inside the provisioning attempt, before
its cleanup boundary. Source `d3a257a4659a017b89a7dfc413018900174445ef`
extends the already-bounded exact-candidate probe to reduce Docker, Tailscale,
and entrypoint output to a closed state vector: container state and exit code;
socket and daemon presence; status-query result; allowlisted backend state;
machine authorization; AuthURL and mesh-IP presence; and four startup-log
booleans. The raw status, URL, addresses, logs, host identity, container identity,
and SSH error are discarded. The closed vector becomes a durable causal error
before exact cleanup, and the database diagnostic maps it to a closed failure
family such as missing daemon/socket, unavailable status, pending login,
machine authorization, stopped/starting backend, or running without an IP.

The staging image path was then re-audited from the publishing workflow rather
than inferred from similarly named Dockerfiles. `build-agent-image.yml` builds
`packages/app-core/deploy/Dockerfile.ci`: the full `@elizaos/agent` host started
through `docker-entrypoint.sh`, with `packages/agent/dist/bin.js start` as the
runtime command. `Dockerfile.cloud-agent` is not the source of the protected
`ELIZA_AGENT_IMAGE` used by this Hetzner path. Its readiness and ESM fixes remain
valid hardening for that separate image, but are not evidence for the active
Dedicated startup failure. Build `33567044875` produced, boot-tested, attested,
and anonymously pull-tested the active demo image at
`sha256:3669a5aa86ec5a7bf0ec340e1fdbbfd2a38959a07ce1acb0374a93d9b7539d13`.
Staging was pinned to that immutable digest and the environment value was read
back before provisioning.

Worker deployment `33569186748` installed source
`79b2e0c5b4e005f2e79dde644568ee2ae4c7eca6`, ran canonical migrations,
reconciled systemd, restarted the Hetzner daemon, and passed health on its
second attempt. The first attempt spent exactly three minutes unassigned even
though the repository exposed eligible idle runners; that was a transient
GitHub runner-assignment failure, not a Hetzner or application failure. Exact
cleanup `33569019126` removed the prior synthetic row with the explicit
state-loss waiver allowed only for this controlled canary.

Fresh canary `33569952876` selected `dedicated-always`, created exactly one
agent, and issued no chat request, but failed after 753,332 ms. Read-only
diagnostic `33571111122` proved that its tenant database was ready and its job
queue had executed six bounded retryable requeues. The exact Docker replacement
identity was durable, while the VPN node identity was absent; the terminal
category was `ingress_headscale_ip_missing`, and the private worker journal
reduced the causal family to `registration_timeout`. This again rules out a
database, quota, or pre-Docker admission failure.

Cleanup attempt `33572040500` stopped at the HTTP 409 lifecycle boundary and
performed no mutation. The canary previously discarded the structured conflict
body, so source `872ea7b876a3ac6e8bef175182ea4cb74d1dbadb` added closed,
privacy-safe conflict categories without retaining agent or job identifiers.
Read-only source `fcfb0d8bf671f4f080be08a7c856821f9d27712f` also exposed the
database-owned lifecycle facts needed to distinguish an active executor from a
converging cleanup fence. Run `33573243386` proved the exact provision execution
was quiesced, its lease and lifecycle fence were absent, and the reconciler had
cleared the replacement locator. Cleanup-only run `33573378392` then deleted
exactly the stale target, created no agent, sent no chat request, and returned a
confirmed cleanup receipt. No safety fence was bypassed.

The in-attempt candidate observer was strengthened once more in source
`64dc20a6f4663a2f0b98a3f886c774ef4786cff9`: after the full Headscale
observation window it closes the pooled SSH connection, reconnects, and performs
one bounded synchronous observation of the exact persisted candidate before
cleanup. If even that path is unavailable, it persists a closed transport or
remote-observation category instead of erasing the evidence. Deployment
`33573400161` installed the descendant source
`fcfb0d8bf671f4f080be08a7c856821f9d27712f`, applied migrations, restarted the
Hetzner services, and passed the exact-source health gate. This is the worker
source responsible for the next cold-path acceptance result.

Canary `33573776398` then created one `dedicated-always` target and no chat
request, but failed after 732,108 ms. Diagnostic `33574914093` again proved a
ready tenant database, six retryable requeues, and an exact Docker replacement
identity without a VPN identity. Cleanup-only run `33576687216` subsequently
matched and deleted exactly that target with zero new agents, zero chat
requests, a confirmed receipt, and `possibleOrphan=false`. Worker deployment
`33576066979` installed source
`55502735d539746bc2ce9bcc55fc3a7ce4522b66`, including closed route, TUN, and
control-plane observations, and passed migrations, systemd reconciliation,
restart, and sustained health.

Fresh canary `33576910808` reproduced the failure after 739,432 ms. Its exact
candidate probe and later read-only diagnostics were decisive about what was
*not* broken: the container was running; its Tailscale socket and daemon were
present; `/dev/net/tun` and a default route existed; and the container could
reach the public Headscale health endpoint. The daemon was still in
`NeedsLogin`, with no mesh IP, no AuthURL, no explicit key rejection, and no
agent-start marker. Headscale had six recent, unexpired, reusable `tag:agent`
pre-auth keys and no exact invalid, expired, used, ownership, timeout, or tag
rejection log. This ruled out the tenant database, Docker create, missing TUN,
container routing, Headscale public reachability, and pre-auth-key creation.

Source `62508fe0abe270ae6e507eb7edccff845a0d6168` added a final privacy-safe
classification of the private `tailscaled` control exchange: control-key fetch,
login start, RegisterReq send, control-transport failure, TLS failure, and DNS
failure. Deployment `33587387098` installed that observer and passed the exact
worker gates. Cleanup-only run `33587750846` then removed the failed
`r33576910808a1` target before the next cold-path attempt.

Canary `33587889664` provided the final root-cause evidence. It selected
`dedicated-always`, created one agent, made no chat request, and timed out its
provision wait after 963,143 ms; its bounded cleanup also failed, correctly
retaining `possibleOrphan=true`. The in-flight diagnostic `33589001284` caught
the exact candidate before reconciliation removed it. The authoritative
database was ready and held every primary Docker locator plus a Headscale
address. Inside that exact container, `tailscale status --json` succeeded with
`BackendState=Running` and a mesh address, while the container remained before
the application-start marker. The worker journal independently classified
registration as observed. Headscale registration had therefore succeeded: the
foreground `tailscale up` process simply did not return, so the mesh-first
entrypoint never reached the agent command.

This behavior is consistent with the upstream client contract and incident
history rather than a database or Hetzner-capacity fault. `tailscale up` waits
for the backend to reach Running under its own timeout in the upstream
[`up` implementation](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/up.go),
but the pinned 1.90-series container client remained blocked after the daemon
had already reached that state. The upstream
[Docker 1.90.6+ hang report](https://github.com/tailscale/tailscale/issues/17912)
documents the same release family. The image also lagged the supported client
line even though Headscale v0.28 accepts clients from 1.80 onward.

Source `e4ebfbf35e120f93d7c63193858cb89dee97abc4` repairs both active and dormant
image entrypoints. While the foreground CLI is running, the entrypoint performs
a bounded, private daemon-status probe. `Running` plus a non-empty
`TailscaleIPs` list is authoritative success: the entrypoint terminates the
stuck CLI and starts the agent. An independent outer deadline terminates a CLI
that neither exits nor reaches that proven state, so a container can no longer
remain indefinitely in `starting`. Definitive AuthURL, `NeedsMachineAuth`, and
invalid/expired/used-key handling still takes precedence. Both images also move
from Tailscale 1.90.8 to the integrity-checked 1.98.3 tarball, the final stable
version available through Tailscale's architecture-specific tarball channel
before its [distribution change](https://github.com/tailscale/tailscale/issues/20299).
Deterministic Linux fixtures cover the success-after-stuck-CLI and bounded
non-ready cases for both entrypoints.

Build `33589931505` then built, boot-tested, attested, published, and anonymously
pull-tested that exact `e4ebfbf35e120f93d7c63193858cb89dee97abc4` source. The
staging environment was read back pinned to
`ghcr.io/elizaos/eliza-demo@sha256:7a3d318b392f3e137f63ee5ca40412a6eacec045c5f3d5a3ff19f2685980821f`.
Cleanup `33590846173` removed the prior failed canary only after diagnostic
`33590767961` proved its provision executor quiesced. Worker deployment
`33591362190` installed the same exact source, applied canonical migrations,
reconciled both systemd units, and passed its source-identity and health gates.

Fresh canary `33591733320` proved that the repaired container now crosses the
entrypoint boundary. It selected `dedicated-always`, created one agent, and
reached a ready tenant database. The worker observed Headscale registration,
the exact container stayed running, its private socket answered
`BackendState=Running` with a mesh address, and node-side HTTP/Docker health
passed. The application path still did not become reachable from the control
plane before the bounded canary and provision retries expired, so no chat was
sent and the canary retained `possibleOrphan=true` until its executor quiesced.

Read-only diagnostics `33592404806`, `33593459564`, `33593614955`, and
`33594307474` separated that failure from the prior entrypoint deadlock. The
primary Docker and Headscale locators were durable and the database/job queue
continued advancing. At `05:21Z`, the control-plane Tailscale daemon itself was
`Running` with a local mesh address, but the exact canary peer was absent from
its network map, Linux had no `tailscale0` route for the peer, Tailscale ping
failed, and the health URL was unreachable. By `05:33Z`, after the final
provision attempt and container retirement, the peer finally appeared offline
and the route existed. The problem is therefore delayed/split control-plane
mesh convergence, not Docker capacity, tenant database setup, agent admission,
or failure to register the container with Headscale.

The Headscale arm path contained a specific recovery weakness: it treated an
exactly named row in Headscale's database as sufficient proof that the local CP
router was enrolled. That row can outlive the local `tailscaled` session or a
control-URL migration, leaving the CP apparently enrolled but unable to see new
agent peers. Source `fbea3fb41789224ded404d74d293118a30e9748f` makes convergence
three-part and fail-closed: one unambiguous durable node, a local
`BackendState=Running` identity with a mesh IP, and an exact canonical
`ControlURL`. If any part differs, it mints a fresh single-use tagged key,
retires only the exact numeric stale node, forces local reauthentication, and
then re-proves all three facts. The regression renders the real remote script
and locks the ordering and postconditions. The live staging arm and a new
Dedicated canary remain the acceptance boundary; source inspection and the
eventual offline route are diagnostic evidence, not success.

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

## 2026-09-02 closure: signed-in Dedicated path restored

This section supersedes the intermediate acceptance language above. The full
investigation crossed several independent faults that presented as one long
"Dedicated agents do not start" symptom. The failures were repaired in causal
order and re-tested at their real boundaries instead of treating a public
health beacon, a Docker `running` state, or a database row as readiness.

The product routing invariant is now explicit:

- authenticated Eliza application and Cloud sessions select
  `dedicated-always`; they do not fall back to Shared on provisioning failure;
- anonymous/public `eliza.app` chat and explicitly Shared channel ingress may
  select Shared;
- Telegram, Discord, iMessage, and similar external ingress is Shared only
  when it is the public Eliza service, while a connector installed for a
  user's personal agent delivers to that user's Dedicated runtime;
- handoff transfers an explicitly delimited conversation state into the
  Dedicated owner and records provenance; it is not an implicit Shared
  continuation or a reason to route a signed-in turn through Shared.

The resulting end-to-end flow is:

```text
signed-in client
  -> authenticated Cloud route
  -> dedicated-always resolver
  -> agent_sandboxes durable lifecycle row
  -> provision_jobs leased by the Hetzner provisioning worker
  -> capacity selection / Docker node allocation
  -> tenant database creation and migration
  -> immutable agent image start
  -> Tailscale join through Headscale over TLS
  -> headscale_ip persisted only after observed mesh identity
  -> agent health + fresh heartbeat
  -> Cloud agent-router forwards the original per-agent host over the mesh
  -> Dedicated agent chat/SSE
```

Shared remains a separate edge-owned execution path:

```text
public or explicitly Shared ingress
  -> Shared admission and conversation Durable Object
  -> Shared runtime execution
  -> Shared response/channel delivery
```

The two paths may exchange a deliberate handoff envelope, but they do not
share runtime identity, storage ownership, health, or fallback semantics.

### Root causes and repairs

1. **Signed-in routing admitted Shared fallback.** The authenticated routes,
   SDK contracts, and regression suites now require `dedicated-always` and
   preserve a visible failure when Dedicated is unavailable. Merge
   `696922e0c0861348f3330b41378ef1b15630f12f` and exact hosted run
   `33596412886` established this boundary.
2. **The active agent image was initially misidentified.** The protected
   `ELIZA_AGENT_IMAGE` is built by `build-agent-image.yml` from
   `packages/app-core/deploy/Dockerfile.ci`, not the similarly named dormant
   Dockerfile. Build `33630300533` produced and pull-tested
   `ghcr.io/elizaos/eliza-demo@sha256:b4077a84eaa372f0b8b2d640f966869ae8d614009a6191bb8ed3df238cfa7897`.
3. **Headscale error reporting collapsed distinct causes.** Merge
   `4526287d7c9a90e7a0775a8dcd072d8938cff410` introduced closed safe
   categories; later diagnostics distinguish ingress, registration, peer,
   routing, application-start, and deletion failures without exposing keys or
   mesh addresses.
4. **The Headscale control-plane re-arm trusted a stale durable row.** Merge
   `408b4647d4880a751cffdce7912fbd7385da2932` requires the durable node, local
   Running state and IP, and canonical ControlURL together. Arm run
   `33630162925` converged successfully. Earlier arm failures `33621556735`,
   `33624576929`, and `33627254594` were retained as negative evidence rather
   than called success.
5. **Provisioning containers attempted the TS2021 exchange through plaintext
   port 80.** Headscale was healthy on the proxied TLS path, but Tailscale
   remained `NeedsLogin`. The image now sets `TS_FORCE_NOISE_443=1`, matching
   the upstream client and Headscale reverse-proxy contracts. Exact worker
   deployment `33650901840` installed the repair; cleanup `33651439541`
   removed the prior failed target.
6. **The canary could not safely observe mesh readiness through the owner
   API.** The raw Headscale address remains admin-only, while the owner DTO now
   exposes required boolean `meshAddressPresent`. This prevents a healthy mesh
   from being misreported as absent without widening private network data.
7. **Deletion retries could become permanently stranded after bridge loss.**
   The first delete attempt could remove or clear the bridge, and the next
   attempt returned before honoring its explicit `stateLossAcknowledged`
   authority. The repaired service binds the waiver to the exact lifecycle
   generation under lock, proceeds without fabricating or persisting a bridge
   URL, and still fails closed for ordinary unacknowledged deletion. Diagnostic
   `33658113000` isolated `pre_delete_capture_refused`; exact worker deployment
   `33661686020` installed the repair, and cleanup-only run `33662307557`
   confirmed deletion of `r33654221184a1` with no orphan.
8. **The Hetzner worker host depended on ambient Git credentials.** The public
   remote still returned an authentication challenge because host-level Git
   state contaminated the fetch. The deployment now resolves the installed
   host generation, constructs a bounded incremental Git bundle from the
   trusted exact-SHA runner checkout, hashes and transfers it over the existing
   protected SSH boundary, verifies it on-host, and imports it locally. No
   GitHub token crosses into Hetzner. Run `33661686020` proved bundle transfer,
   exact checkout, migration, build, systemd restart, router health, and worker
   health. Same-SHA retries include the target commit relative to its parent,
   avoiding an empty-bundle failure.

### Database findings

The tenant and control databases were not the startup root cause in the final
failed provisions. Canaries `33651867586` and `33654221184` reached a ready
tenant database and fresh worker heartbeat. Diagnostic `33656460024` showed a
terminal `deletion_failed` row with durable Docker and Headscale locators,
completed provisioning, and lifecycle events through `delete_failed`. The
initial generic "database" label was a diagnostic classifier bug: it matched
database-looking stack paths instead of the exact delete job's closed failure
category. Job-correlated diagnostics corrected that false attribution. The
deployment workflow nevertheless continues to run canonical migrations against
the protected environment DSN and to fence activation on the job-interruption
schema preflight.

### Hetzner, queue, and warm-pool weaknesses

- Cold provisioning remains sensitive to queue delay. Canary `33654221184`
  spent 619,598 ms queued and 37,890 ms executing before the later readiness
  and cleanup work. Queue age, execution time, and terminal category must stay
  separate in alerts.
- The self-hosted GitHub runner fleet repeatedly reported runners online while
  jobs terminated within four to five seconds at checkout. These attempts made
  no host or database mutation, but "online" is insufficient fleet health.
  Deployment receipts must therefore distinguish runner startup failure from
  host deployment failure, and operators should alert on repeated no-log job
  terminations. After merge, the same `_diag/pages` collision recurred on
  runners 11, 13, and 15 while the repository-wide emergency gate already said
  `HETZNER_FLEET_ONLINE=false`. The provisioning deployment was the exception:
  it ignored that gate and hard-routed both admission and mutation to the
  unhealthy generic runner labels. The workflow now uses the canonical
  fail-closed selector for both jobs: hosted `ubuntu-24.04` unless the fleet is
  explicitly set to lowercase `true`, otherwise the quarantinable
  `[self-hosted, hetzner-robot]` pool. The per-slot repair remains the
  repository-owned `cloud/runners/repair-runner-slot.sh` runbook; deployment no
  longer depends on those repairs completing before a release can proceed.
- The provisioning host no longer needs outbound Git authentication, removing
  a mutable credential/configuration dependency from disaster recovery and
  ordinary rollout.
- The warm pool remains protected-off. It was not used to conceal cold-path
  faults, and it should not be enabled until both the API claim half and daemon
  replenish half pass the billing, starvation, generation, and rollback
  evidence enumerated above.

### Acceptance state

At the feature-source boundary, the repaired worker has terminal proof for
canonical migrations, exact incremental-source admission, systemd identity,
worker/router health, and recovery of the known deletion orphan. A final fresh
signed-in create/chat/SSE/delete canary must run from the merged `develop`
revision after the owner-safe mesh DTO is deployed to Cloudflare; running it
against the older API would produce a known false negative. That post-merge run
is the final release receipt for the complete path, not a substitute for the
causal evidence above.
