# Agent host and assistant ownership review

This is the implementation ledger for the agent/assistant review, under
[the existing runtime-consolidation issue](https://github.com/elizaOS/eliza/issues/31532).
It records inspected source and acceptance work, not a claim that the broad
refactor is complete. The shared checkout is undergoing concurrent changes;
recheck callers and the final diff before each migration.

## Target boundaries

| Owner | Responsibility | Reason |
| --- | --- | --- |
| `packages/core` | Runtime lifecycle, authorization, cancellation, effect settlement, model dispatch, storage interfaces, task clock, canonical trajectory records and serialization | These guarantees must hold for any registered message processor or feature. |
| `plugins/plugin-assistant` | Message policy, planning, response evaluation, grounded replies, conversational feature contracts | A host can replace assistant behavior without replacing the kernel or HTTP server. |
| `packages/agent` | Process boot, host configuration, HTTP/WebSocket authentication and transport, filesystem adapters, local installation and native integration | These decisions depend on deployment, process state and transport authority. |
| Domain plugins | Domain records, actions, state machines and adapters | Domain behavior should be independently composed; host boot selects it. |
| `packages/shared` | Platform-neutral value utilities and explicitly shared transport contracts | Shared is not a destination for policy merely to avoid an import cycle. |

Ports belong with their consumer. Concrete host adapters implement those ports
without making assistant import agent. Preserve deliberate compatibility exports
until callers migrate. A file move is not a deletion or a performance improvement.

## Composition audit

`runtime/assistant-plugins.ts` is the host assembly point. It always installs
assistant, connector-account management, identity HTTP, documents, trajectories,
relationship services and credential setup. Autonomy and trust are setting-gated;
advanced memory and planning use explicit character flags. The relationship
assembly contributes services only: its conversational actions/providers already
come from assistant's advanced capabilities. Registering the whole relationship
plugin again would duplicate contributions rather than simplify composition.

| Current surface | Disposition | Ownership reason / remaining acceptance |
| --- | --- | --- |
| Assistant message service, planner, evaluator, prompts | Keep in assistant; extract cohesive operations within it | These implement conversational policy. Core retains execution and disclosure authority. |
| Assistant basic/advanced contribution arrays | Keep explicit composition; correct obsolete flag-based descriptions | `createAssistantPlugin` composes both arrays; host feature gates are separately visible in `createAssistantPlugins`. |
| Personality, experience, conversational facts and reflection | Keep assistant-owned | These describe assistant behavior and post-turn learning. Host character persistence is a port implementation, not the policy owner. |
| Documents | Keep existing optional feature factory for now | Agent routes/actions consume its access policy. A later standalone plugin needs a complete public consumer migration, not another loader. |
| Advanced memory and planning | Keep optional factories | Hosts intentionally select them. Their authored prompt files additionally feed training and cannot be deleted by runtime graph analysis. |
| Relationships and follow-ups | Preserve host identity injection and existing feature service assembly | Canonical relationship-domain migration is not complete; maintain record compatibility and avoid duplicate action registration. |
| Autonomy | Keep optional assistant feature using core task clock | The decision to act is assistant policy; the clock and execution authority stay in core. |
| Trust contributions | Keep optional policy layer; kernel remains authoritative | Removing them on the assumption that core security duplicates them would conflate policy with enforcement. |
| Secret setup and activation | Keep current consumer ports pending auth/host adapter audit | Credential workflows and concrete storage have different owners. No new secret store or upstream host import is justified. |
| Credential proxy, child credential scope and payments | Retain public optional exports | Their package-root exports are real external contracts even when omitted from ordinary host composition. Absence from the default host is not dead-code evidence. |
| Approval, handoff, pause and pending prompts | Keep assistant services; host registers and exposes HTTP | These were already migrated. Their host routes still own caller authentication and protocol translation. |
| Agent process boot, config, plugin loading and native integration | Keep agent-owned | Deployment/runtime selection is host policy, not assistant behavior. |
| Agent HTTP dispatch, route matching, Hono and IPC adapters | Keep agent-owned; canonical matcher now shared | Protocol adaptation and admission should not pull in assistant policy. Preserve each transport's semantics. |
| Agent media store and file adapter | Keep one content-addressed store | Moving conversational media generation policy does not justify a second storage authority. |
| Agent trajectory persistence/archive | Reconcile with assistant feature before migration | Matching names conceal different late-write, recovery and archive contracts. |
| Agent retention workers | Move scheduling to core TaskService only after policy audit | Logs are operational data; memory deletion affects retained dialogue and needs an explicit compatible contract. |
| Unreachable OAuth and plugin-config scaffolding | Delete | Neither package exports nor runtime registrations reach these implementations; live OAuth and setup routes have other owners. |

## Evidence and decisions

### Disconnected feature scaffolding: delete, preserve the shipped catalog

The current import graph covers 926 production TypeScript files across both
packages. Traversal from every assistant package export reaches 376 files.
Nineteen implementation files are outside that closure. Repository-wide searches
of their module paths, symbols, action names and service tokens distinguish two
unused feature trees from authored prompts used by training:

- Delete the unexported OAuth action/plugin/local-callback-bus implementation and
  its private tests. No runtime host registers these actions or service clients.
  Cloud has its own active OAuth implementation. Preserve `OAuthProvider`,
  `OAUTH_PROVIDERS` and `CONNECTOR_NATIVE_OAUTH_PROVIDERS`, the actual public API.
- Delete the unexported plugin-config action/plugin implementation and its private
  tests. Its proposed client service is not registered by any production caller.
- Keep parameter/contact/advanced-memory/advanced-planning prompt modules:
  `packages/training/scripts/export-owned-prompts.ts` explicitly reads them and
  shared authored-template fixtures import them. Runtime reachability alone
  would wrongly classify these training inputs as disposable.

This removes 26 files plus unused OAuth contracts: 4,055 net lines. The manifest
exports remain identical. Rebuilding produced byte-identical JavaScript for all
four published entry points; only the root declaration's documentation changed.
Typecheck and build passed. This is source/test deletion, with no claimed bundle
size saving: the disconnected implementations were already absent from the build.
The inventory is retained at `/tmp/agent-assistant-import-inventory.json` and the
pre-deletion output hashes at `/tmp/assistant-before-dead-feature-removal.json`.

### HTTP route matching: one host-owned matcher

An AST scan found three identical function bodies in dispatch-route,
runtime-plugin-routes and server-lazy-routes, plus a boolean-only equivalent in
the runtime-mode guard. All now use `api/plugin-route-path.ts`. Hono imports that
small module directly; the old runtime-plugin-routes export remains compatible.
Transport matching stays in agent; no assistant or kernel dependency is needed.
Public-route intent checks, method normalization and authentication remain at
their existing boundaries. A differential check against both prior matchers
passed 16,641 route/path pairs, including malformed URI escapes and wildcard
patterns. Eight focused route, wallet and model-provider suites subsequently passed
after the concurrent Vitest configuration repair.

### Wallet provider inventory: use the wallet owner

The same 2,593-character function body existed in model-provider-helpers and
wallet-rpc. Wallet RPC owns this inventory; model-provider-helpers now re-exports
it for existing consumers, and server imports it from wallet-rpc directly.
There is no wallet-to-model-provider import cycle. Keep the existing wallet and
first-run behavior tests; duplicating array literals in a new test adds no proof.

### Assistant request predicates: consolidate without widening routing

`looksLikeActionExplanationRequest` had identical bodies in coding-request and
direct-action-heuristics. The generic heuristic now owns it; coding-request
imports and re-exports it for existing callers. No regex, ordering, prompt or
model call changed. The existing 126-test heuristic suite passed.

### Character persistence: consolidate the port, retain the host adapter

The personality feature's `character-persistence.ts` declares the service token
and service-locator interface. Agent's `services/character-persistence.ts`
independently declared the same token, request and result; character-history
also declared the source enum and snapshot shape. Personality actions resolve
this service, while the host writes config, the agent row and history.

Implementation in this working change:

- The personality feature owns `PersistableCharacter`, request/result types,
  source values and the existing token and resolver.
- A dependency-free `@elizaos/plugin-assistant/character-persistence` entry point
  lets the host import this port without loading the assistant root barrel.
- The host adapter implements the port. Existing host token and history type
  exports remain aliases, preserving consumers.
- Replace token-literal tests with host resolution and persistence readback:
  real temporary config plus explicit database/history collaborators.

This does not make the three persistence sinks transactional. The host currently
writes config before the agent row and history. The file manager also writes an
optional character file before invoking the host. Failure reconciliation needs
its own behavioral change and failure-injection evidence; moving code cannot
solve it. Do not silently alter those failure semantics in the port migration.

### Message lifecycle and transport: separate responsibilities, then extract

Inspected entry points: agent `api/chat-routes.ts`, `api/conversation-routes.ts`,
`api/server.ts`; assistant `services/message/turn-lifetime.ts`,
`services/message/processor.ts`, `runtime/planner-loop.ts`, and `runtime/evaluator.ts`.
At initial inventory, chat and conversation routes exceeded 5,000 and 7,000 lines;
planner-loop exceeded 9,600. Size identifies review targets, not removable code.

Keep authentication, HTTP/SSE framing and persistence settlement at the host
boundary. Keep planner admission, tool-result interpretation and final-reply
policy in assistant. The current JSON and streaming handlers already share
`resolvePersistedAssistantTurn`, callback-history persistence, reply recovery
and outcome construction. Their orchestration differs deliberately: streaming
publishes `reply_ready` before durable completion, handles disconnect/voice
fences and publishes `done` after persistence; JSON sends its response after
settling the durable outcome. Both retain the completion promise fence and
post-delivery failure reporting. Do not merge these state transitions into a
single callback merely because the persistence calls resemble each other.

Pure SSE framing is now extracted into host `api/chat-stream-writer.ts`.
Conversation routes import it directly, and chat routes retain compatibility
re-exports. The module depends on Node HTTP types and shared wire contracts;
it has no assistant, model, filesystem or persistence import. Its twelve moved
function/type declarations remain AST-identical after comment removal
(`/tmp/chat-stream-extraction-equivalence.json`). Existing admission, generation,
room leases and delivery settlement code remains in its owner.

The real loopback HTTP scenario validates legacy and delta token reconstruction,
complete Unicode/newline payloads, provisional flags, geometric snapshots,
authoritative replacement, multiline named events, event-name injection
rejection and writes after response end. It uses real Node responses and fetch,
without mocked transport. This is wire-contract evidence, not live-model or
end-to-end room-settlement evidence; those policies did not change in this
extraction.

### Trajectories: canonical serialization in core, storage reconciliation next

Canonical JSON/JSONL/CSV/ART serialization now lives beside core's trajectory
record types in `packages/core/src/services/trajectory-export.ts`. It has no
assistant policy, HTTP dependency or concrete store. The host and assistant's
SQL trajectory service import the core barrel directly. Assistant retains its
previous export module as a compatibility re-export; shared continues to own
plaintext presentation. Core gains no package dependency or extra public subpath.

The seven existing export tests moved with the implementation. They pass in core,
covering stored/inline steps, corrupt JSON rejection, usage/cache accounting,
native wire output, request-message precedence and streaming boundaries. The
implementation body was byte-identical before formatting; AST-normalized bodies
also match afterward (`/tmp/trajectory-export-ast-equivalence.json`). Core's real
packed-consumer verifier now exercises JSON/JSONL export with a complete large
Unicode request and corrupt-data rejection outside workspace aliases. That
verification passed with the same five-package production dependency closure.

The two persistence paths remain a separate task. Assistant uses
`trajectory_step_index`; host capture uses `trajectory_steps` with legacy
`steps_json`, recovery ownership, late-write routing and archives. The host bridge
replaces the resolved service's lifecycle, capture and read methods; it does not
forward model captures into both writers because their step/reward shapes differ.
`DatabaseTrajectoryLogger` is also a publicly exported alternative with repeated
read operations. List/detail implementations now share `listDatabaseTrajectories`
and `getDatabaseTrajectoryDetail` in the host storage module. Both bridge and
standalone entry points retain their public signatures. An AST comparison against
both original bodies confirms identical query behavior after substituting the
runtime receiver; filtering, pagination, agent scoping and typed query failures
remain unchanged (`/tmp/trajectory-read-equivalence.json`). Statistics now use
one host-owned computation with explicit response adapters: the class retains
`total`, `enabled`, `byStatus` and `bySource`; the bridge retains aggregated
counters, duration, `totalTrajectories`, `bySource` and `byModel`. The viewer route
forwards the bridge DTO directly. Model and status breakdowns now contain actual
counts instead of fabricated empty objects. Model counts select dedicated step
records, falling back to compatibility snapshots only for trajectories without
dedicated rows. Aggregation stays in SQL, so full request/response payloads do not
cross into JavaScript just to count calls. Invalid models and call arrays fail
explicitly. Both APIs now share the same schema and data-failure behavior.

The real-storage regression first failed on the old empty status breakdown.
Coverage includes empty datasets, agent-isolated model/status counts, stale
compatibility snapshots, legacy-only records, malformed models, aggregate token
counts above 32-bit range, and HTTP failure/recovery. This preserves public DTOs;
it does not unify assistant's independent persistence schema. The additional
model aggregation reads all owned step records; large-dataset performance has
not been benchmarked, and separate queries retain the existing non-atomic
statistics semantics during concurrent writes.

The new host `test/trajectory-read-persistence.test.ts` exercises both read surfaces
against real PGlite and the actual viewer HTTP formatter over loopback transport.
It writes and settles model-call records through the host logger, compares list
filters and pagination, excludes a foreign-agent row, verifies missing detail,
preserves a 180,000-character request through detail/HTTP reads, and turns a
renamed/unavailable table into direct and HTTP failures before restoring it.
The fixture waits for the runtime's actual service-start promise and supplies the
required model-call purpose/action fields. No storage, service or route is mocked;
this scenario does not claim outer-host authentication or live-model generation.
The focused scenario passes.

The existing `plugin-trajectory-logger` is a view-only plugin with a UI dependency;
moving persistence into its root would couple headless storage to the product UI.
Retain the viewer's current composition while introducing any storage owner
through an explicit headless contract. A same-name plugin is not evidence of a
safe storage destination. Recovery/archive adapters stay host-owned. Preserve
complete raw requests/results and prove stored-data, failed-write and concurrent
settlement behavior before deleting either writer.

### Trajectory writer admission and bridge ownership

The bridge's public-method inventory exposed one remaining split write path:
`applyReward` still used assistant's private write queue after captures and
lifecycle had been replaced by the host. The standalone host logger already
implemented the required row lock, agent scope, persisted idempotency key and
logging-enabled check. That transaction now lives in one private host operation;
both the bridge and standalone service use the host capture queue and the
current enabled state. Reward policy and event production remain outside it.

The retained methods have deliberate owners:

| Surface | Bridge behavior and owner |
| --- | --- |
| Start/step/call/provider/semantic capture, completion, reward and terminalization | Host storage queue, ownership records and admission |
| Flush and stop | Host drain/recovery plus the captured original service shutdown |
| List/detail/statistics/delete/clear/ordinary export | Host database operations with agent scope |
| Legacy `logLLMCall` and provider-by-trajectory helper | Assistant compatibility forwarding into replaced public capture/current-step methods; no independent write |
| ZIP builder | Presentation over replaced public readers, with complete selection |
| Enablement | Existing service setting wrapped with host routing cleanup |
| Initialization | Original schema/service setup, already complete before bridge installation |
| Legacy in-memory inspection | Existing synchronous empty/null compatibility surfaces; persisted inspection uses detail/list |

The real host scenario verifies concurrent replay through both reward entry
points commits once, disabled bridge rewards do not write, foreign-agent rewards
are rejected, and the committed total is read directly from storage. Detail DTOs
do not expose the training reward field, so DTO absence is not a persistence
assertion.

Keep the independent SQL service and host persistence modes distinct in this
change. Their step indexes, recovery ownership, late captures and archives are
not interchangeable. Shared value serialization belongs in core; concrete
queries stay with their storage owner. The similarly named viewer plugin still
has production UI dependencies, so moving the SQL implementation there would
expand headless assistant dependencies without unifying either stored schema.
A future domain-package migration requires an explicit headless package contract
and stored-data migration; a file relocation alone would not complete it.

### Complete trajectory export selection

The host bridge replaces ordinary export and read methods but retains the
assistant service's public ZIP builder. The builder therefore needs to consume
its public read methods rather than reach into assistant-only storage. Its old
single 500-row list call silently omitted further matches; the host's separate
ordinary export query also imposed an unrequested 10,000-row limit.

ZIP now traverses the complete filtered inventory through the selected reader.
Both readers order tied timestamps by ID, and traversal rejects repeated IDs,
changed totals, unexpected offsets and premature empty pages. Missing or
inaccessible selected details produce `TRAJECTORY_EXPORT_INCOMPLETE` instead of
a successful partial ZIP. The ordinary host exporter has no row cap and selects
only IDs before loading canonical details, avoiding the previous duplicate full
row transfer. Serialization and recovery/archive ownership remain unchanged.

A real PGlite regression reproduced 500 exported ZIP entries for 501 matches.
The expanded host scenario also covers more than 10,000 stored trajectories,
same-timestamp pagination, unique manifest IDs, both patched and independent
assistant ZIP readers, and inaccessible/missing explicit selections. These
checks exercise stored records without substituting the writer or reader.
Paging detects observable inventory inconsistency; it does not promise a single
transactional snapshot against same-count concurrent replacements. A future
snapshot export contract must belong to the storage owner, not ZIP presentation.

### Relationship graph: retain injection, review domain authority

Agent's `services/relationships-graph.ts` is a wrapper around assistant graph
contracts, injecting host owner identity and cloud account lookup. It is not a
second graph implementation. Preserve this injection seam. Its header now identifies assistant as the graph implementation owner.
Assistant's relationships service and graph builder remain large; compare their
actual authority with `plugin-relationships` before migrating them. The agent
README explicitly documents that legacy relationship inventory is not a completed
ownership migration. Do not delete legacy storage on an inventory result.

### Retention: one scheduler, separate data policies

Agent memory/log retention now registers work with core TaskService through
`runtime/retention-task.ts`. The helper owns worker registration, the existing
30-second startup delay, a stable task identity, concurrent-start exclusion,
shared in-flight sweeps and draining shutdown. It creates no timer. Disabling a
policy removes a stale owned task; stopping deletes its schedule, drains writes,
and releases only its own worker. Core owns recurrence, backoff and failure
reporting. Both services retain their public service names and adapter type
shapes for existing consumers.

The pure `memory-retention.ts` planner and independent configuration prefixes
remain unchanged. These are pre-existing opt-in storage-deletion policies, not
prompt projection or context-size controls. No new cap, default deletion policy,
partition or summary was introduced. Memory deletion now uses the canonical
runtime `deleteMemories` method so evidence invalidation runs; the obsolete
`deleteManyMemories` adapter check had silently disabled retention on SQLite.
This intentionally repairs configured SQLite retention rather than silently
claiming the unsupported path was already functional. Logs remain on the log
adapter's separate deletion API. The existing scan bounds and planning policy
still require separate completeness review; scheduler consolidation does not
establish correctness for arbitrarily large retention inventories.

Storage failures now throw typed errors with causes instead of returning empty
success results. Core TaskService records failed runs and retry state. Direct
callers receive the same failure. Overlapping callers join one sweep rather than
receiving a false empty result; calls after shutdown fail explicitly. With no
configured policy, the existing designed-empty result remains supported and no
worker or new scheduled row is installed.

`test/retention-lifecycle.test.ts` exercises real AgentRuntime, core TaskService
and file-backed SQLite: default opt-out, delayed/due scheduling, independent log
and message deletion, concurrent registration, service restart, concurrent direct
sweeps, draining shutdown, sub-millisecond interval rejection and corruption
recovery. A malformed stored log produces a typed direct failure and persisted
scheduler failure/backoff; repairing the row lets a later run reset that state.
All four scenarios pass. Test corruption is applied with the adapter closed to
respect SQLite's exclusive ownership contract; no storage or scheduler is mocked.

### Analysis-mode scaffolding: remove the unused server toggle

Repository-wide consumer searches found one caller of the activation hook, in
assistant turn handling, and no production reader of its room flag or sidecar
renderer. The UI has an independent local `analysisMode` display state; it does
not consume this server flag. The obsolete hook intercepted ordinary `analysis`
and `as you were` messages and acknowledged a mode that produced no output.

Deleted the unexported handler and its turn interception. Both phrases now use
normal message admission, model handling, delivery and persistence. The existing
real-runtime/SQLite delivery suite covers both phrases with the old environment
gate enabled and disabled. Its two enabled-gate cases failed before deletion
because the model was never invoked. No UI display state was removed.

### Document ingestion: mutation authority is separate from read visibility

The full assistant suite exposed a real SQLite storage defect, tracked in
[issue #32490](https://github.com/elizaOS/eliza/issues/32490). Pending and failed
documents are intentionally hidden from retrieval, but SQLite also applied that
read filter before compare-and-swap and snapshot deletion. As a result, an
authorized ingestion worker could neither settle a pending document nor clean up
a failed attempt. The fix belongs in the adapter, not in assistant retry logic.

Both mutation operations now check mutation authority while retaining the old
visibility-dependent forbidden/not-found response for unauthorized callers.
Exact snapshot, agent and table checks remain. A real-file SQLite regression
covers hidden pending creation, unauthorized mutation, ready settlement, stale
snapshot conflict, restart readback, failed-state hiding and snapshot deletion.
It failed before the fix and passes afterward. The entire SQLite suite passes:
5 files and 36 tests; build, typecheck and lint also passed.

Assistant document fixtures now explicitly choose their embedding dimensions and
expect cross-agent insertion to be rejected by the single-agent adapter. Six
affected document suites pass, with 59 tests. Background-evaluator fixtures also
choose their three-dimensional test vectors explicitly. Their reordered-entity
case reverses actual query results at the runtime read boundary instead of
assuming SQL insertion order. Reply-persistence fault/ordering injection now
runs before the adapter transaction, so its gate cannot hold SQLite's transaction
queue and falsely block an unrelated room. Evaluator fallback assertions retain
complete schema and per-room prompt checks while allowing the established
runtime-wide cache of unsupported schema output. All three affected service
suites pass: 140 tests before the four analysis-message cases were added.

### Tests and documentation: finish ownership migration

The current core test inventory has one assistant-source consumer:
`src/plugins/core-security-hooks.test.ts`, which checks kernel registration and
boot bookkeeping while composing assistant. It stays in core. The earlier
206-file inventory became obsolete during concurrent test cleanup and is not
used as migration authority.

The remaining attachment live test now lives beside assistant's
`readAttachmentAction`. Its core config previously excluded it even from the
post-merge lane. Assistant discovery includes it in that lane, while default
runs still exclude live tests; actual execution requires `ELIZA_LIVE_TEST=1`
and OpenAI/Cerebras credentials. The call now passes `action: read` explicitly
(the action still supports its existing read default). Assertions observe a
real `MODEL_USED` event for `TEXT_SMALL` and the exact visible callback, as well
as complete attachment content in the action result. The existing live fixture
is shared with other assistant live tests through the app test helper; no new
production dependency or duplicate runtime harness was introduced.

The migrated test passes against the live provider under pinned Node 24.15.0.
An initial `bunx` attempt failed SQLite's runtime admission before model use;
the explicit pinned-Node invocation passed. Discovery/opt-out evidence is
separate from that live receipt. Logs use `/tmp/attachment-owner-*`.

Assistant README/AGENTS referenced deleted `docs/design/runtime-consolidation`
files at the initial scan. Agent's eliza-plugin header claimed automatic
compaction and replacement of memory actions by todos despite current imports
and repository policy. Those host headers are now corrected. The canonical comment-only checker
verified the prose edits against HEAD in an isolated two-file snapshot; subsequent
Biome import ordering also moved the relationship wrapper imports below its
header, so that final file is not classified as comment-only. Assistant guide/README links now target
this review, and local Markdown link/path validation passed.

## Implementation sequence and acceptance

1. **Canonical character persistence port** — implemented with host compatibility
   aliases, published-subpath build and native consumer verification recorded
   below. Final isolated-revision qualification remains part of item 8.
2. **Finish ownership audit** — trace all host registrations and external
   consumers, classify assistant features and reverse dependencies, and record
   explicit keep/move/delete decisions. The inventories above are a starting
   point, not exhaustive acceptance.
3. **Move assistant-owned tests** — the current inventory is reconciled: core's
   kernel security integration stays, and attachment live coverage now belongs
   to assistant with explicit discovery, opt-in and live-provider evidence.
4. **Remove verified dead scaffolding and stale descriptions** — distinguish
   public wildcard exports, host hooks and dynamically registered services from
   true dead code. Each deletion names the observed caller outcome.
5. **Consolidate retention lifecycle** — implemented through existing TaskService
   authority with typed failures and real-storage lifecycle coverage. Review the
   inherited inventory-bound policy separately before claiming arbitrary-size
   retention correctness.
6. **Reconcile trajectory persistence** — migrate consumer by consumer with
   stored-data compatibility, concurrency and complete-record tests.
7. **Extract message/transport seams** — pure SSE framing is extracted and
   verified over real HTTP. JSON/SSE completion keep their distinct ordering
   while sharing existing persistence helpers; no model-facing policy changed.
8. **Qualify and ship** — both package tests, typecheck, lint, assistant build,
   relevant host build/packed consumer, root `bun run verify`, required runtime
   evidence and final diff review. Prepare an isolated `chore/` or `fix/` branch
   rebased on current develop for PR delivery; do not rebase or reset the shared
   dirty checkout. No completion claim before these gates and scope review.

## Current verification

- Pinned Bun 1.3.14 and Node 24.15.0 are available.
- Assistant typecheck passed after the initial port change.
- Two focused assistant persistence suites passed: 9 tests.
- Initial host tests could not load their config because an unrelated concurrent
  merge left conflict markers in `packages/shared/package.json`.
- Initial host typecheck found missing source mapping for the new subpath (fixed)
  plus pre-existing/concurrent moved-test imports in conversation-idempotency.
- The three focused host persistence/history suites passed; host typecheck passed.
- Both package lint commands passed with existing warnings/informational findings.
- Assistant build passed, including the new declaration and JavaScript output.
  An isolated native Node consumer resolved and called the built subpath with no
  runtime dependencies installed.
- Full assistant run: 378 suites passed, 34 failed; 4,454 tests passed and 14
  failed. Failures include shared-package resolution and document ingestion
  contracts. These need reproduction after concurrent merge/config changes;
  they are not waived or assumed to be caused by this patch.
- Full agent and root verify runs were started. Subsequent route suites failed
  before tests because concurrent default Vitest config references an undefined
  `vitestResolveAlias`. Preserve logs under `/tmp/agent-assistant-review-*`.
- Current full-suite qualification and PR delivery remain unproven.


### Latest qualification update

The post-consolidation host and assistant typechecks passed. Assistant rebuilt
successfully after predicate consolidation. Root verify reached the Turbo gates
and failed in plugin-discord typecheck: core unicode uses `String.toWellFormed`
but that consumer lacks an ES2024 library. Full assistant validation was restarted
after dependency builds resolved earlier missing outputs. The full host run
observed multiple generations of concurrent test/config edits and cannot certify
a single final revision; retain its failure log and rerun on a stable candidate.
Another workspace change subsequently deleted many host tests, including the
new persistence test. Do not claim those earlier passing suites remain present
or cover the final checkout without rechecking the new test layout and owners.


### Subsequent full-suite result

The second full assistant run completed: 403 suites passed and 9 failed, with
5,296 passing and 23 failing tests. Remaining failures concern document ingestion,
SQLite-backed evaluator/persistence behavior and a room concurrency timeout.
These preceded the disconnected-feature deletion. Investigate the real adapter
and consumer contracts rather than deleting tests to obtain a green result.
The earlier full host run completed with 370 failed batches out of 763 while
concurrent config and test-layout changes were in flight; it is failure evidence,
not a stable candidate qualification.


After deleting the disconnected feature trees, the full assistant suite completed
with 392 passing and 9 failing suites (5,208 passing, 23 failing tests). The failing
case set is identical to the pre-deletion run; 11 private suites and 88 passing
tests left with their unshipped implementations. No new failing case appeared.
This comparison isolates deletion impact; it does not waive the existing failures
or qualify the full goal. Build, typecheck and lint passed after the deletion.


### Current qualification pass

Assistant and host typechecks and read-only lint pass after the storage and
fixture corrections. The full assistant lane passes: 401 suites and 5,235 tests.
The current host lane passes both discovered end-to-end suites. Assistant build
passes, including declarations; the first attempt failed when shared-package
declarations were unavailable during a concurrent rebuild, and the retry passed
after those outputs returned. Root verify failed at UI's design-system inventory
check (`packages/ui/scripts/check-design-system.test.mjs:1391`): 58 violations
were reported where zero were expected. Turbo reported 138 successful tasks out
of 142 before stopping. No UI implementation or design-system baseline was
changed in this review; the root gate is not green.

The host lane now discovers only two package-wide real end-to-end suites after
concurrent removal of its former tests. Earlier host suite results do not prove
coverage of the current tree. These are current working-tree results, not an
isolated final revision or PR qualification. Logs are in
`/tmp/assistant-boundary-*`, `/tmp/agent-boundary-current-*` and
`/tmp/sqlite-ingestion-*`.


### Retention qualification

All four retention scenarios pass, and the full current agent lane passes all
three discovered files. Agent typecheck and read-only lint pass (lint retains
nine warnings). Root verify remains red: the subscription-gateway manifest fails
formatting, and OS typecheck cannot resolve `@elizaos/shared/brand`. That root run
completed 37 of 102 Turbo tasks before stopping. Logs use `/tmp/retention-*`.

A prior broad run observed a concurrent deletion of core's skill-eligibility
source while loading its barrel; the fresh final agent run passed afterward.
The interval test uses a sub-millisecond value because the existing config
parser deliberately clamps oversized intervals; that policy remains unchanged.
Agent build also passes, including the package-boundary check and Node ESM import
rewriting. No final revision or PR is qualified.


### Trajectory export qualification

Core and assistant builds and all three affected package typechecks pass. The
packed core verifier passes, including the new complete-export behavior. Core's
full current test lane passes 164 tests in 16 suites, with two suites/tests
skipped; skipped live paths are not qualified by that result. Core lint passes.
Assistant's full lane passes 400 suites and 5,228 tests; the seven moved export
tests account for its reduced total. All three current host suites pass. Both
package lint checks and host build pass. The built assistant compatibility export
also preserves a complete 200,000-character request in a native Node invocation.
Root verification failed at app lint: formatting in
`packages/app/scripts/copy-publish-assets.test.mjs` (41 successful Turbo tasks
out of 102 before stopping). This review did not modify that file. Logs are
`/tmp/trajectory-*`. No final revision or PR qualification is claimed.


### Host trajectory-read qualification

List/detail duplication is removed with unchanged query bodies and real-storage
readback evidence. All four current agent test files pass, and agent typecheck,
read-only lint and build pass. Lint retains nine existing warnings. Root
`bun run verify` now passes with exit 0: all 262 Turbo tasks succeeded, the packed
kernel check passed, and the final audit found no focused tests or orphaned skips
across 6,529 files. Logs are in `/tmp/trajectory-read-*`. This qualifies the observed
shared working tree, not an isolated final PR revision. Statistics DTO
reconciliation and the two stored step representations remain open; this
extraction does not claim to have unified those contracts.


### Host trajectory-statistics qualification

Both host statistics entry points now use one computation and retain their
public response shapes. All four agent test files pass, along with agent
typecheck, read-only lint (nine existing warnings), build and root verification.
Root verify completed all 262 Turbo tasks successfully and found no focused
tests or orphaned skips across 6,529 files. The review's local Markdown links
resolve. Logs use `/tmp/trajectory-stats-*`; the initial regression fails on the
old empty status breakdown, and the final real-storage lane passes. Statistics
DTO reconciliation is complete for the two host entry points. Assistant's
independent writer/schema, remaining ownership work and isolated PR delivery
remain open. These checks qualify the observed shared working tree only.


### Complete-export qualification

The final real-storage scenario passes both tests, including 501 ZIP matches
through each reader and 10,003 complete model-call rows from more than 10,000
stored trajectories. All four current agent files pass. Both package builds and
typechecks pass, and the package lint runs pass with existing warnings. The full
assistant rerun passes 400 suites and 5,228 tests. Its first attempt had 19 suite
import failures while shared build outputs were unavailable; no assertion
failures were reported in that attempt. Builds completed and the full retry
passed. Test and build phases must not overlap dependency-output replacement.

Root verify fails at agent formatting in concurrently changed
`src/api/diagnostics-routes.ts` and `src/api/server.ts`; a focused read-only
recheck confirms those failures remain. That run completed 36 of 102 Turbo
tasks before stopping. These files were not changed by the export work.
The review's local links and changed-source whitespace check pass. Evidence
uses `/tmp/trajectory-export-complete-*`. This is working-tree evidence, not a
qualified PR revision; the wider ownership/persistence review remains active.


### Reward writer qualification

All four agent scenario files pass after sharing reward persistence between the
bridge and standalone logger. Agent typecheck and build pass. Both changed
source/test files pass read-only Biome and the diff whitespace check; the review
links resolve. Package lint and root verify fail on formatting in the concurrently
changed `src/providers/page-scoped-live-state.ts`, which this change does not
modify. Root verify stopped at agent lint. Logs use `/tmp/trajectory-reward-*`.
The first reward test attempt incorrectly inspected the public detail DTO for a
training-only reward field; the corrected scenario checks the persisted row.
This is not an observed pre-fix behavior regression result. The final passing
scenario verifies shared-entry-point replay, disabled admission and agent scope.
The larger review and isolated PR qualification remain open.


### Chat wire extraction qualification

All five current agent scenario files pass, including three real HTTP wire
cases. Agent typecheck, read-only lint (nine existing warnings) and build pass.
A native Node consumer imports the built stream module and receives the exact
Unicode SSE frame over HTTP. Root `bun run verify` passes with exit 0. The
changed-source whitespace check and review link validation pass. Evidence uses
`/tmp/chat-stream-*`; declaration equivalence is recorded separately in
`/tmp/chat-stream-extraction-equivalence.json`. No model-facing or durable turn
policy changed, and the wire harness does not claim live-model/room-settlement
acceptance. Remaining ownership and PR qualification work stays active.
