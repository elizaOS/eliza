# `@elizaos/agent`

Standalone elizaOS agent and HTTP backend. Plugin routes can be registered on `AgentRuntime` and are served by the agent’s HTTP stack.

## Documentation

- **Paid HTTP routes (webhooks, plugins):** see the docs site section on [webhooks and routes](https://docs.elizaos.ai/plugins/webhooks-and-routes).
- **x402 micropayments on plugin routes:** configured through the runtime's `x402` config block and the `X402_API_KEY` environment variable (see `packages/agent/src/runtime/eliza.ts`).

## Local development

From this package:

```bash
bun install
bun run typecheck
bun run test
```

See `package.json` for `build`, `lint`, and other scripts.

## Trajectory viewer access

Raw trajectory reads require owner authority at the HTTP boundary. Authenticated
non-owner sessions and shared gateway credentials do not grant developer-view
access. Standalone trusted-local access, configured API owner credentials, and
authorized owner sessions retain the existing read-service contract. Product
role resolvers must grant both owner authority and route access.

## Memory search results

Planner-owned `MEMORY action=search` calls return each complete source once in
`data.memories`, with its exact text, IDs, author, room, timestamps and evidence
status. The text field explains search scope and pagination. Standalone callers
retain the complete text rendering as well as structured records. Ownership comes
from the existing trusted execution context, never model-supplied arguments.
For message results, `data.messageAuthorCounts.matching` counts all matching
message records after the requested filters; `returned` counts only the current
page. Counts distinguish requester, assistant and other speakers, exclude facts
and other record types, and do not replace the original records. A zero under an
author filter says nothing about excluded authors' stored messages.
The normal model-boundary redactor handles source strings before serialization;
stored records and structured runtime results remain intact.

When smaller, planner search results factor metadata identical on every returned
record into `sharedMemoryFields`. Each `memories` entry inherits those fields;
merging them reconstructs the complete original record. IDs, exact source text,
timestamps, ordering, counts and pagination remain intact. The wire legend names
this encoding and distinguishes chronological from keyword-ranked results.
Runtime data and standalone callers keep complete records; small results retain
their original representation. This adds no model call or retrieval limit.

Explicit malformed room/entity UUIDs reject before reading records; search never
drops an invalid scope filter. A pagination rejection identifies the missing page
size so a corrected matching search can resolve it without an extra failure-only
reply. Unrelated queries do not resolve the original failure, and both attempts
remain in the trajectory.

The promoted `MEMORY_SEARCH` tool requires an explicit `author` choice:
`requester` for the current user's messages, `assistant` for the agent's replies,
or `any` for no author restriction. `any` preserves other type, entity and room
filters, including searches for facts or another speaker. Legacy direct
`MEMORY action=search` callers may still omit `author` for unfiltered searches.

The promoted search also requires explicit `query` and `limit` choices. An empty
keyword query intentionally searches all records within the other filters;
`limit` (1–50) sizes a page, not the total result set. Follow `nextOffset` and
`snapshot` for further pages. Legacy `MEMORY action=search` keeps these fields
optional. Mutation parameters and permission checks are unchanged.

For an exact quotation, `queryMode=literal` matches the supplied `query` as a
case-sensitive substring of source text, including punctuation, whitespace and
Unicode. It preserves all other filters and returns every match through the same
pagination contract. Omitted `queryMode` or `keywords` keeps ranked keyword
recall. Literal queries cannot be empty, and invalid modes fail explicitly.

The default test command runs isolated Vitest batches. The repository runner
requests `--reporter=default --reporter=junit --outputFile.junit=<path>` and the
batch runner validates every report before writing one combined JUnit artifact.
Missing, malformed or failed batch evidence rejects the run; entirely skipped
suites do not satisfy the repository's required-work gate.

## Trajectory viewer access

Raw trajectory reads require owner authority at the HTTP boundary. Authenticated
non-owner sessions and shared gateway credentials do not grant developer-view
access. Standalone trusted-local access, configured API owner credentials, and
authorized owner sessions retain the existing read-service contract. Product
role resolvers must grant both owner authority and route access.

## Backup restore generations

Snapshot capture, local backup publication, and restore share an exclusive
claim under the configured state directory's `.backup-authority` directory.
Destructive domain workflows use `withAgentBackupAuthority` and retire the
agent's previous generation before deleting data. Earlier snapshots remain
stored but cannot restore that agent; this is a restore restriction, not proof
that retained backup bytes have been purged. The domain must separately expose
and execute its backup retention policy.

Retirement remains pending until the domain verifies primary cleanup and calls
`completeRetirement` with the matching operation ID and generation. Pending
retirement blocks both capture and restore, including after a process restart.
Retries of the same operation reuse its generation; a different operation cannot
take over pending cleanup. The domain can inspect `pendingRetirement` to
reconcile an uncertain transaction before retrying or acknowledging completion.

New snapshots record the current generation. Legacy snapshots belong to the
initial generation and remain restorable until that generation is retired.
Authority files are excluded from capture and state pruning, and restore
rejects payloads or configured targets that would replace them. A failed or
uncertain deletion does not automatically reinstate an earlier generation.

An interrupted process can leave `.backup-authority/operation.lock`. Operations
then return `AGENT_BACKUP_AUTHORITY_UNAVAILABLE`; elapsed time never authorizes
automatic removal. For recovery, stop every process using that state directory,
inspect the interrupted operation and its domain journal, and reconcile any
database or storage effects before removing that exact claim and syncing its
parent directory. Preserve all generation records. Restart users only after
reconciliation; removing a claim does not roll back a completed deletion.

## Research tasks

`ResearchTaskExecutor` requires a provider registered for
`ModelType.RESEARCH`. Provider absence, rejection, or an empty report returns an
unsuccessful `TaskResult` with a stable `errorCode`; it never falls back to
ordinary `TEXT_LARGE` synthesis and labels that output as research.

## Message-interaction session persistence

`FileMessageInteractionSessionStore` is the durable single-host adapter for
core's message-interaction session authority. It serializes independent local
processes, writes a 0600 regular file through same-filesystem fsync and atomic
rename, fails fast on corruption and symlinks, qualifies Linux lock owners by
boot/process generation, and generation-fences stale takeover and release with
an atomically published transition marker. A complete owner inode is fsynced
before no-replace hardlink publication; malformed owners have a bounded
recovery ceiling, while a live PID that cannot be generation-qualified fails
closed. An abandoned transition marker also fails closed because portable
filesystems cannot conditionally unlink a pathname generation; an operator may
remove it only after stopping every store user and verifying that no host
process owns the store. Operations report
`INTERACTION_STORE_RECOVERY_REQUIRED` and do not mutate state while that marker
remains; this state has no bounded automatic recovery. The marker path is
reported in `error.context.markerPath`; with the default filename it is
`<stateDirectory>/message-interaction-sessions.v1.json.lock.transition`.
Recovery requires stopping every process that uses the store, verifying that
none owns the adjacent `.lock` owner file, removing that exact `.transition`
path, fsyncing the state directory, and only then restarting store users. Its
boundary is one machine and one state directory. Multi-host deployments must
supply a transactional database implementation of
`MessageInteractionSessionStore` and use the session replay key as the effect or
outbox idempotency key.

Transition cleanup reports machine-distinct retry outcomes. A failure during
pre-operation stale recovery is
`INTERACTION_STORE_RECOVERY_CLEANUP_FAILED` with `committed: false`; a failure
after the durable transaction commit is
`INTERACTION_STORE_COMMITTED_CLEANUP_FAILED` with `committed: true`, so callers
must not retry the mutation. Every other release failure after the durable write
is `INTERACTION_STORE_COMMITTED_RELEASE_FAILED` with the same no-retry contract;
combined operation/release failures retain the release code and recovery
context. If publication sees a transition marker after linking its complete
owner, no transaction starts. Offline recovery must additionally verify the
reported owner token/inode, remove both the exact marker and owner paths, fsync
the parent directory, and restart. Owner-candidate cleanup failure is likewise
typed as pre-mutation (`INTERACTION_STORE_OWNER_CANDIDATE_CLEANUP_FAILED`,
`committed: false`) whether or not the candidate was published; a published
owner is safely detached when possible and `context.published` records which
case occurred.
After the state temp is renamed, a parent-directory sync failure reports
`INTERACTION_STORE_COMMIT_AMBIGUOUS` with `committed: "unknown"`; a close
failure after successful sync uses the same code with `committed: true`.
Both are non-retryable and require reading the reported state file to reconcile
the persisted session outcome. If lock unlink and transition cleanup both fail,
the committed cleanup error retains the unlink cause, cleanup error, marker,
lock identity/token, and exact offline recovery authority.

The file authority durably commits an effect before dispatch. If the process
dies after that commit but before retaining the receipt, the session remains
`committed` for operator reconciliation; it is never lease-transferred,
automatically retried, or revoked as if cancellation succeeded. The store lists
ambiguous commits and accepts only a verified receipt to reconcile them without
re-execution. Completed receipts are retained for seven days and unreconciled
commits for thirty days by default, after which bounded collection prevents
permanent capacity exhaustion.

The bundled `eliza` plugin registers `MessageInteractionHostService` as the one
runtime authority connectors resolve through `MESSAGE_INTERACTION_HOST_SERVICE`.
Connectors submit capability profiles and trusted render bindings to `prepare`,
then send authenticated inbound provider receipts to `consume`. Only host-owned
effect handlers execute retained operations; completed receipts preserve the
provider event, canonical inbound event, audit id, and app-state proof for replay.

## Approval-bound plugin installation

`installPlugin` always installs the canonical npm package declared by the
registry (`plugin.npm.package`), even when lookup used a display name or alias.
Existing callers may continue passing a version string as the third argument.
Security-sensitive callers can instead bind the package and exact version they
showed an operator for approval:

```ts
const result = await installPlugin("friendly-registry-alias", undefined, {
  expected: {
    packageName: "@vendor/canonical-plugin",
    version: "2.4.1",
  },
});
```

The installer rejects a changed package or version before creating the install
directory or executing a package manager. A bound install uses that exact npm
package/version and does not silently fall back to a local workspace or moving
Git branch. Successful results include `provenance` identifying the actual
`local`, `npm`, or `git` source. npm/Bun lock integrity and resolved tarball
metadata are returned when available; unavailable integrity stays `null`, and
Git installs report the cloned commit.

## Core relationships inventory

`archiveCoreRelationshipsInventory` snapshots the complete legacy Core
`RelationshipsService` rows for one agent using a
`CoreRelationshipsInventoryDatabase` whose transaction owns one PostgreSQL-compatible
session. It reads agent-scoped entities, relationships, identities and merge
candidates, and contact components scoped to the agent's relationships world
and source identity. Every complete JSON payload is archived and hash-checked.

This explicit operator operation takes source-table `SHARE ROW EXCLUSIVE` locks
inside a serializable transaction. Run it during a global maintenance window:
these locks block source writers across tenants. A successful run reports
`archived` and replaces that agent's current source snapshot, including removing
archive rows no longer present in the source. It does not retain immutable history.
A missing/unreadable source schema or failed archive readback rolls back the
operation with a typed error, preserving the previous snapshot.

The helper never writes canonical entities, identities, edges, or their provenance,
and never deletes or updates legacy source rows. It provides no migration,
projection verification, caller cutover, or authority transfer. The separate
legacy-schema startup guard remains fail-closed until actual ownership migration
is designed and performed.

## x402 at a glance

Paid routes set `x402` on a `Route`. The middleware returns **402** with payment options and accepts on-chain proofs, facilitator payment IDs, or standard payment payloads (`PAYMENT-SIGNATURE` / `X-Payment`), then verifies and settles through a facilitator before running the handler.

For environment variables, events, replay protection, and buyer guidance, use the linked docs above.

## Production chat latency evidence

`bun run --cwd packages/agent perf:cerebras-chat` drives the real
`generateChatResponse`/AgentRuntime/PGLite path. Run from a clean committed
checkout. It requires an explicitly verified `ELIZA_CEREBRAS_CHAT_MODEL` and
`CEREBRAS_API_KEY`; do not treat an old model name or historical report as
current availability proof.

The command now requires a real configured embedding service:
`OPENAI_EMBEDDING_URL`, `OPENAI_EMBEDDING_MODEL` and
`OPENAI_EMBEDDING_DIMENSIONS`. Set `OPENAI_EMBEDDING_API_KEY` through the normal
local environment if that service needs authentication. Without the explicit
endpoint, the Cerebras adapter uses feature-hash embeddings, which cannot
certify production embedding latency. The report must contain a successful
embedding execution and its actual outbound request.

Select the experiment explicitly:

- `ELIZA_CEREBRAS_CACHE_MODE=automatic` omits optional routing keys; ordinary
  provider prefix caching remains available.
- `ELIZA_CEREBRAS_CACHE_MODE=existing` retains the production prefix strategy.
- `ELIZA_CEREBRAS_CACHE_MODE=conversation` applies an opaque key scoped to the
  agent, room, model, stage and stable prefix after core cache-plan assembly.
  It fails explicitly when any text-model call lacks that prefix; current
  post-delivery `TEXT_SMALL` calls can make this mode unsupported for a full run.

The two keyed modes require
`ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED=true` **after independently
confirming account support**. This flag records the operator's attestation; it
is not an account-capability probe. These overrides belong only to the
benchmark and do not change production defaults or another provider's policy.
Successful runs verify the effective SDK wire: automatic mode must contain no
optional cache key, and conversation mode must retain the exact expected key
from its model invocation. Async context joins the invocation and actual SDK
request. This detects crossed or overwritten hints, not upstream cache residency.

Set `ELIZA_CEREBRAS_CHAT_PATH=direct` or `gateway`. For gateway runs, configure
`CEREBRAS_BASE_URL` to the authorized compatible endpoint and set
`ELIZA_CEREBRAS_GATEWAY_SOURCE_REVISION` to its independently attested deployed
SHA. The command checks the SHA's syntax, not remote deployment provenance.
The text and embedding endpoints must not contain embedded credentials,
queries or fragments.

`ELIZA_CEREBRAS_CHAT_CONDITION` selects the workload:

- `rolling-history`: all measured turns append to the existing conversation.
- `fresh-room`: each sample starts a new conversation on the same runtime.
  This is **not** proof of a cold provider cache; a shared prefix may be reused.
- `post-idle`: each sample gets its own primed conversation, then resumes after
  a shared idle wait. `ELIZA_CEREBRAS_CHAT_IDLE_MS` defaults to 360000. Reports
  include the actual interval since each room's prior completion.

`ELIZA_CEREBRAS_CHAT_SAMPLES` defaults to 30 and
`ELIZA_CEREBRAS_CHAT_WARMUPS` to 3. A post-idle run adds one priming turn per
sample; the existing cancellation probe also makes a live call. Compare matched
model, tier, endpoint, embedding service, settings and workload across runs.
Classify actual cache misses/reuse from upstream cached-token counts rather
than labels, and report unavailable upstream metrics explicitly. There are no
CI latency thresholds.

Set `ELIZA_CEREBRAS_CHAT_REPORT` to a protected artifact path. Newly created
reports use mode 0600 and contain complete synthetic prompts, SDK request
bodies, outputs, model execution timings, provider spans and persistence
receipts. Authorization headers are never recorded. First visible text,
response headers, foreground completion and background quiescence are distinct;
HTTP header latency is not provider TTFT. Missing queue time and acoustic audio
latency are explicitly unavailable. Inspect artifacts before publishing.

This text-runtime command does not certify app rendering, audio playback,
real connector delivery or a separate deployed gateway's identity. The strict
proof checks abort on a failed sample, so a successful report's error rate is
zero. Both terminal success and failure reports retain every started turn in
`turnObservations`, including its phase, last validation stage, partial streaming
and timing observations, and completed persistence receipt when available.
Unreached measurements remain null. Concurrent checks settle every started room
before failure evidence is written. Retain failed runs rather than dropping them
from a comparison. #17072 still requires current live production evidence, concurrent
and resumed-session correctness, and any reproduced bottleneck's matched
before/after result. Preparing this command alone does not complete the issue.

For an installed desktop native embedding model, set
`ELIZA_CEREBRAS_EMBEDDING_MODE=native`, `MODELS_DIR`,
`LOCAL_EMBEDDING_MODEL`, and `LOCAL_EMBEDDING_DIMENSIONS` instead of the HTTP
embedding settings. This runs the canonical `ensureLocalInferenceHandler`
boot and selects its `eliza-local-inference` embedding handler explicitly;
it never substitutes a benchmark embedding implementation or silently falls
back to the OpenAI-compatible synthetic embedding path. The report records
model and fused-library paths and SHA-256 hashes separately from HTTP wire
evidence. Every returned vector must have the configured dimension and finite,
nonzero values. Native readiness does not prove remote gateway readiness.

For a controlled provider-only comparison after collecting a successful keyed
runtime report with at least 30 sample requests, run:

```bash
ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED=true bun --conditions=eliza-source packages/agent/scripts/cerebras-cache-wire-replay.ts /path/to/runtime-report.json /path/to/replay-report.json
```

The replay preserves every original message, tool, schema and model setting;
only the optional cache hint changes. Shared-prefix and conversation hints
use a fresh run scope. Mode order rotates for each matched request. It records
complete SSE responses and every HTTP attempt, paces calls three seconds apart,
and permits at most three attempts per request. A longer-than-60-second
`Retry-After` stops the run instead of starting an unbounded retry loop.
Automatic prefix caches may already be warm, and routing hints cannot guarantee
independent cache residency. Replay results therefore describe a provider
experiment, never app/runtime/gateway acceptance.

The chat command's `wallMs` includes `generateChatResponse`'s room background
drain. Use `firstVisibleTextMs` and the runtime's response-finalization spans
for delivery timing. `backgroundQuiescenceMs` measures only an additional
residual drain after command return. Report HTTP 429 and transport-attempt
counts separately from completed-turn success; successful runs do not erase
failed preflights or recovered retries. Failed-run reports retain attempted model
inputs (including rejected experiment preflights), model outcomes, returned chat
responses and wire attempts. A delivered reply cannot make a run successful if
its post-delivery model work failed. Provider account tier and invoice cost are
not measured by this command; comparisons must disclose those limits.

### Builtin evaluator semantic evidence

`packages/agent/scripts/cerebras-evaluator-semantics.ts` is a separate semantic
check, not a latency workload. It persists two controlled conversations in a
new isolated PGlite directory and runs the actual fact, relationship, identity,
and task-completion evaluators through the provider. The negative conversation
contains a deliberately failed booking action-result fixture; no booking or
external identity API is called. Acceptance requires actual owned fact and
identity rows, a supported colleague relationship, and matching completion
memory/cache values. It awaits the production RelationshipsService before use.

Use the normal root environment file, independently verified
`ELIZA_CEREBRAS_CHAT_MODEL=qwen-3.8-27b`, and the native384 settings described
above. From the repository root:

```bash
bun --env-file=.env.local --conditions=eliza-source packages/agent/scripts/cerebras-evaluator-semantics.ts --output=/tmp/evaluator-live.json --pglite-dir=/tmp/evaluator-live-db
```

Both output and database paths must be new. The report contains full model and
wire output, fixture definitions, before/after domain records, final isolation
readbacks, and explicit failures. Checks reject foreign-fixture claims and
contradictory same-message completion rows even alongside valid results. Full
reasons and relationship descriptions still require semantic inspection; a
nonempty explanation alone is not proof of grounded reasoning. The database is retained after canonical
runtime shutdown. Verify those exact effects in a fresh process with:

```bash
bun --conditions=eliza-source packages/agent/scripts/cerebras-evaluator-semantics.ts --resume=/tmp/evaluator-live.json --output=/tmp/evaluator-resumed.json
```

Resume requires a successful report containing the original process and agent
identities. It reopens the existing database, forbids network requests, and
compares complete persisted effects with the original readbacks without running
evaluators again. Missing or changed records, a changed agent, the same process,
and failed shutdown reject the receipt. This proves retained semantic effects;
it does not certify resumed chat routing, real tool execution or app latency.
The original live command makes nominally two merged evaluator calls, with every actual attempt recorded.
Inspect and scan artifacts before publishing.

Replay a successful report through the actual SDK and the current evaluator
consumer on a loopback server using `--replay=/tmp/evaluator-live.json` and new
output/database paths. `--finish=original` preserves the saved response body;
`--finish=length`, `content_filter`, or `malformed` requires explicit evaluator
failure with no persisted effects. Replay blocks remote network calls and
records the source artifact hash. These controls are deterministic transport
replays, not additional live-model trials. Comparing an older consumer requires
an independently pinned compatible harness; this command does not emulate old
production behavior. Semantic success and cache/latency improvement remain
separate claims.

Action relevance checks use the same prepared multilingual keyword predicates
as complete match collection, but stop once any strong or weak term matches.
Negative checks still inspect every available source. Promoted tools may reuse
the same keyword result for one message only after comparing the complete fresh
text snapshot and vocabulary identity. Edits, removals, changed state or locale
are rechecked; weak message keys release retained snapshots. This does not cache
action validation or permission decisions, remove history, change vocabulary,
or alter the complete match collector used by consumers that need every match.

### Windows installation identity

Windows runtime boot stores its durable installation identity in the current
user's Windows Credential Manager, using the existing credentials package.
The normalized configured absolute state path identifies the credential account;
filesystem redirects and file contents do not supply the identity. Changing
that configured path selects a separate identity. Clearing state files at the
same path does not clear this OS-owned identity. No plaintext identity file or
passphrase fallback is used on Windows.

A current-user/SYSTEM-only global Windows mutex serializes credential creation
across processes and login sessions. Boot fails explicitly if Windows
PowerShell 5.1, the protected mutex or the native keyring is unavailable, or if
the stored key is malformed. POSIX hosts retain their existing filesystem
ownership and durability checks.

## Plugin view assets

Use the `bundleUrl` or `frameUrl` returned by the view catalog. Local URLs bind
all relative resources to one runtime installation and modality:
`/api/views/<id>/installations/<installation>/<gui|tui|xr>/<bundle|frame>/<file>`.
Replacing or removing a plugin invalidates its old URLs. Clients must reload the
catalog rather than construct a URL or retry an old installation against a new one.

A local root file can declare its published siblings in an adjacent sidecar:

```json
{"version":1,"files":["frame.html","main.js","styles/main.css","media/icon.svg","engine.wasm"]}
```

For `frame.html`, name the file `frame.html.assets.json`; for `bundle.js`, use
`bundle.js.assets.json`. Paths are relative to the root file's directory. The
root itself is always included. Registration captures the declared bytes and
rejects paths outside that directory. Delivery checks role, installation and
content for GET, HEAD and conditional requests. Unlisted files are not served;
changed files require a new registration. The server never publishes a directory
by scanning it.

The shared view Vite configuration emits this manifest from that build's actual
outputs, excluding source maps. It does not include unrelated compiler output,
types or test fixtures. Custom frame builds must emit their own sidecar, including
CSS, media, WASM and modules used by relative imports. Existing single-file views
work without a sidecar; existing views with siblings must add one. Legacy root
requests with a current installation binding redirect to the catalog URL;
unbound roots and legacy sibling paths require migration.

Host-external bundles loaded through a blob factory must be a single module.
The canonical build inlines dynamic imports. Relative imports and nonliteral
dynamic imports in custom factory bundles return `VIEW_MODULE_GRAPH_UNSUPPORTED`
before execution; use a self-contained build, or a frame/raw module graph with
an explicit asset manifest. Remote capability URLs remain owned by their host.
Hero images use the same view role and installation checks, with private caching;
authorized mobile clients can load images without permission to load remote code.


## Recalled conversation discovery

The relevant-conversations provider may use an existing retention checkpoint
from an owner-private source room to defer reviewed originals. It validates the
complete source snapshot and scope, then intersects visibility with the records
already admitted by recall access checks. Retained constraints and pending
originals remain inline. Missing or stale checkpoints, mismatched record bytes,
other worlds and group rooms retain complete admitted recall. Stored records and
the full provider result are unchanged.

The discovery notice offers complete originals through the existing read path.
A native direct-text history read also restores these authorized provider bodies
in its existing decision round, separately from the current-room search receipt.
A fresh provider review may then select originals for planning and completion;
invalid review keeps them all. No similarity cutoff, result-count limit or new
classification call is introduced.

## Pinned dstack evidence

A single Eliza agent can collect dstack guest-v1 evidence over its CVM's Unix
socket and invoke a locally pinned `dstack-verifier`. This integration targets
[dstack upstream `d9de8915a648c889714b187c984059b05debef49`](https://github.com/Phala-Network/dstack/tree/d9de8915a648c889714b187c984059b05debef49):
`POST /v1/Attest` and `dstack-verifier --config <file> --verify <input>`.
The agent contains the transport and admission adapter; operators must install
the real verifier built from the reviewed source revision in the measured image.
A normalized evidence object is not a cryptographically verified quote.

Set `ELIZA_DSTACK_EVIDENCE_CONFIG_JSON` to a JSON object with these fields:

| Field | Required value |
| --- | --- |
| `socketPath` | Absolute path to this CVM's private guest-agent Unix socket |
| `verifierPath`, `verifierConfigPath` | Absolute regular-file paths inside the measured image |
| `verifierSha256`, `verifierConfigSha256` | Reviewed SHA-256 digests of those exact files, 64 hex characters |
| `appId` | Deployment app ID, hex; omit in signed production mode |
| `composeHash`, `osImageHash` | Approved compose and OS-image SHA-256 digests; omit in signed production mode |
| `variant` | `dstack-tdx` or `dstack-nitro-enclave` |
| `timeoutMs` | Optional overall deadline, default 60000, maximum 300000 |

The executable and configuration must be immutable to the agent and host-side
untrusted workloads. Hash checking is an admission check, not protection against
privileged mutation inside the CVM. Pin verifier trust roots, collateral/image
sources and its dependencies in the release; the process receives no inherited
`DSTACK_VERIFIER_*` overrides. The adapter bounds guest replies and verifier
stdout/stderr at 16 MiB, kills aborted verifier processes, and removes private
temporary evidence files. Collection errors fail boot; there is no fallback.

Production identity must be supplied separately from the measured compose to
avoid embedding the compose's own hash in its bytes. Put the Ed25519 authority's
SPKI PEM in measured `ELIZA_DSTACK_RELEASE_PUBKEY` and omit `appId`, `composeHash`
and `osImageHash` from the measured local configuration. After producing the
exact compose, sign a release payload containing only:

```text
schemaVersion: 1
appId: hex deployment ID
composeHash: 64 hex characters
osImageHash: 64 hex characters
variant: dstack-tdx or dstack-nitro-enclave
notBefore: ISO-8601 UTC timestamp
expiresAt: ISO-8601 UTC timestamp
```

Sign the bytes `UTF8("eliza-dstack-release-v1\0") || UTF8(payloadJSON)` using
Ed25519, where `\0` denotes a single NUL byte. Supply
`ELIZA_DSTACK_RELEASE_POLICY_JSON` as an object with `payload` (canonical base64
of those exact JSON bytes) and `signature` (base64 signature), through separately
authenticated encrypted launch configuration. JSON key ordering is preserved by
signing the supplied bytes; reserializing the payload requires a new signature.
The CPU profile requires the envelope and pinned authority, rejects identity
conflicts, and checks the signed validity interval at resolution and before and
after each evidence collection. Release expiry bounds replay; shorter validity
and signed revocation policies are still needed for emergency withdrawal.
Validity uses the CVM wall clock; deployments must establish clock discipline.
Cached boot trust does not continuously reattest or revoke already released
secrets. Fresh KMS authorization and revocation enforcement remain separate
operational requirements. Do not
replace the expected identity with unchecked guest `Info` fields.

Use `ELIZA_TEE_PRODUCTION_PROFILE=dstack-cpu` for a CPU-only confidential-agent
CVM. This named profile requires this concrete adapter, its approved kind/provider,
compose and OS measurements, debug rejection and at most five-minute evidence
freshness. Caller requirements and revocations remain in force. The adapter
binds fresh request data to the verified hardware report, checks app ID and the
image/compose allowlist, rejects advisories and development images, and requires
Intel `UpToDate` plus verified ACPI measurements on TDX. Nitro Enclave has no
Intel TCB status; its absent TCB remains absent. The upstream verifier owns quote
signatures, certificate/collateral and event-log/image validation and debug
rejection. Build/test results for that verifier must be retained separately from
agent protocol-test results. Missing verifier, unavailable collateral, invalid
report, unknown variant, digest mismatch or stale request never enable secrets.

`ELIZA_TEE_PRODUCTION_PROFILE=true` retains the original profile requiring
additional accelerator and platform claims. The CPU profile supplies none of
those unsupported claims. It cannot authorize remote inference: deployments
must independently require an approved confidential-inference endpoint and its
attested key/channel policy before sending prompts or releasing inference keys.
Local confidential-weight release retains its existing independent policy.

Deploy one agent/container and its SQLite state per CVM trust domain. A shared
physical server may host multiple CVMs; containers inside one CVM share the
attestation boundary. Never expose or share the guest socket between tenants,
mount a host Docker socket, or treat per-container SQLite as hardware isolation.
Use an encrypted state volume, authenticated ingress, and measured pinned images.
The adapter does not provision storage, authorize support access, establish
HIPAA/SOC 2/GDPR compliance, or prove a live hardware deployment.

### Attested inference transport

`services/tee-attested-inference` provides a fetch-compatible client and a
measured server using the versioned TLS ALPN `eliza-attested-inference/1`.
This is a dedicated framed protocol, not an ordinary HTTP endpoint. It buffers
complete request/response bodies; configurable payload limits reject the whole
payload and never truncate model content. Streaming delivery, connection pooling
and automatic retries are not supported in this version. It does not provide
incremental SSE or real-time voice latency. Provider SDK retries and runtime
failover must also be disabled after ambiguous confidential dispatch; transport
errors expose a conservative `dispatchState` in their typed context.

The client validates the normal TLS certificate chain and DNS name, then sends
only a fresh nonce and approved route policy. Both peers compute a SHA-256
transcript containing the protocol domain, nonce, actual certificate SPKI, a
TLS exporter from that exact socket, route ID and policy revision. The server
constructs these values itself, obtains raw guest-v1 evidence, and returns it.
The client independently appraises that raw evidence using the same pinned
verifier as local boot admission, including the expected remote deployment
identity. It never substitutes its own local guest evidence for remote proof.

After proof verification, the required `beforeDispatch` hook must commit the
same-agent durable audit and recheck current route authority. Only then are
application headers and the complete body sent over that same socket. Configure
this transport per approved attempt; the host confidential profile must prohibit
ordinary-fetch fallback. A request always gets a fresh connection, and ambiguous
failures are returned without retry. The hook receives only routing metadata and
proof/session digests; never record prompts, credentials or raw quotes there.

`services/tee-dstack-tls-identity` obtains a fresh key and certificate through the
private guest-v1 `IssueCert` endpoint and constructs the listener without
exporting the key through its public interface. The pinned image/compose must
confine that socket and the listener process inside the same approved CVM.
Dstack returns the private key to this process, so this is not non-exportable
HSM storage. The listener's measured handler must independently enforce any
second inference hop; a valid CPU quote does not establish GPU confidentiality.

Tests use actual TLS connections, certificates, exporters, Unix sockets and
subprocesses, with explicitly synthetic platform quote responses. Captured
platform cryptography tests and these transport tests do not replace a live
hardware run with current collateral and approved measurements.

A local timeout or disconnect closes the session and cancels any late response
stream. It cannot undo a remote handler effect already accepted before abort;
reconciliation or explicit application idempotency is required before redispatch.

The client optionally accepts a constructor-owned absolute `unixSocketPath`
for a measured byte-forwarding sidecar. This changes only the physical dial
path: the approved HTTPS URL, TLS SNI, certificate chain/name checks, peer SPKI
and same-session exporter remain unchanged. The path is snapshotted and must
name a real Unix socket; requests cannot select a different path and failures
never fall back to TCP. A network-disabled agent can use this path without
performing destination DNS resolution. The sidecar must itself restrict its
outbound destination in measured configuration. Local forwarding tests do not
prove Linux namespace/DNS isolation or constrain verifier collateral egress;
those require separate deployment controls and packet-level acceptance evidence.
