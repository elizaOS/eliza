# Agent host and assistant ownership review

This is the implementation ledger for the agent/assistant review, under
[the existing runtime-consolidation issue](https://github.com/elizaOS/eliza/issues/31532).
It records inspected source and acceptance work, not a claim that the broad
refactor is complete. The shared checkout is undergoing concurrent changes;
recheck callers and the final diff before each migration.

## Target boundaries

| Owner | Responsibility | Reason |
| --- | --- | --- |
| `packages/core` | Runtime lifecycle, authorization, cancellation, effect settlement, model dispatch, storage interfaces, task clock | These guarantees must hold for any registered message processor or feature. |
| `plugins/plugin-assistant` | Message policy, planning, response evaluation, grounded replies, conversational feature contracts | A host can replace assistant behavior without replacing the kernel or HTTP server. |
| `packages/agent` | Process boot, host configuration, HTTP/WebSocket authentication and transport, filesystem adapters, local installation and native integration | These decisions depend on deployment, process state and transport authority. |
| Domain plugins | Domain records, actions, state machines and adapters | Domain behavior should be independently composed; host boot selects it. |
| `packages/shared` | Platform-neutral value utilities and explicitly shared transport contracts | Shared is not a destination for policy merely to avoid an import cycle. |

Ports belong with their consumer. Concrete host adapters implement those ports
without making assistant import agent. Preserve deliberate compatibility exports
until callers migrate. A file move is not a deletion or a performance improvement.

## Evidence and decisions

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
policy in assistant. Before extracting repeated code, trace JSON and SSE paths
through cancellation, callback delivery, reply persistence and post-turn evidence.
Do not unify these by dropping one transport's settlement behavior. Existing
conversation-idempotency and turn-lifetime tests are acceptance owners.

### Trajectories: reconcile writers before moving storage

Agent's trajectory-storage/internals/export modules and assistant's
`features/trajectories/TrajectoriesService.ts` both contain substantial persistence
and read shaping. The host export module already delegates canonical export
serialization through the assistant service. Similar names do not establish
identical contracts: inspect schema generations, agent scoping, append ordering,
step ownership, late writes, recovery and archive behavior before consolidation.

Target: one persistence contract and canonical record decoding/serialization;
host-specific recovery/archive paths remain adapters. Preserve complete raw model
requests and results and existing stored records. Prove roundtrip equivalence,
concurrent settlement and failed-write behavior before deleting an old writer.

### Relationship graph: retain injection, review domain authority

Agent's `services/relationships-graph.ts` is a wrapper around assistant graph
contracts, injecting host owner identity and cloud account lookup. It is not a
second graph implementation. Preserve this injection seam. Its header still
says graph types belong in core, contradicting its actual assistant imports.
Assistant's relationships service and graph builder remain large; compare their
actual authority with `plugin-relationships` before migrating them. The agent
README explicitly documents that legacy relationship inventory is not a completed
ownership migration. Do not delete legacy storage on an inventory result.

### Retention: one scheduler, separate data policies

Agent memory/log retention services duplicate timeout/interval lifecycle and
swallow adapter failures into apparently empty sweep results. Both already use
the pure `memory-retention.ts` planner. Logs and memory need different adapters;
a shared table enum would erase that distinction.

Target: drive both through core TaskService, retaining separately configured
policies and explicit inactive/skipped/failed outcomes. Require startup,
restart, overlapping invocation, shutdown and failed-adapter tests. Audit memory
retention against the repository's complete-history invariant before carrying
its deletion policies into a new implementation. This review does not authorize
new memory caps or silently change persisted user data.

### Analysis-mode scaffolding: unused output path, unresolved product behavior

Assistant's analysis-mode handler intercepts bare `analysis`/`as you were` before
ordinary admission when its environment gate is enabled. Its room-state reader
and sidecar renderer have no production consumers in the initial repository-wide
search. The header claims it mirrors a host file that no longer exists.

Do not present this as a working diagnostic mode. Decide whether to remove the
unimplemented toggle and route ordinary text normally, or wire a real authorized
diagnostic surface. Deletion is preferable to maintaining a success response for
an unavailable feature, but needs turn-level regression evidence for gated and
ordinary text and a check of any external UI consumer first.

### Tests and documentation: finish ownership migration

Initial search found 206 core test files importing assistant source directly.
Assistant's own test lane includes only its `src/**/*.test.ts`. This means running
assistant tests alone misses much of its migrated behavior. Core-kernel tests may
legitimately compose assistant; those should remain integration tests. Classify
by system under test, then move pure assistant tests and their private fixtures
to assistant, preserving suite discovery and real runtime fixtures. Do not mass
move every import match or replace runtime behavior with source-inspection tests.

Assistant README/AGENTS referenced deleted `docs/design/runtime-consolidation`
files at the initial scan. Agent's eliza-plugin header also claimed automatic
compaction and replacement of memory actions by todos despite current imports
and repository policy. Repair these descriptions from current registrations;
keep durable architecture rationale near the owning package.

## Implementation sequence and acceptance

1. **Canonical character persistence port** — implemented; focused verification
   in progress. Preserve host API aliases; test actual lookup and writes; build
   and import the published subpath outside workspace aliases.
2. **Finish ownership audit** — trace all host registrations and external
   consumers, classify assistant features and reverse dependencies, and record
   explicit keep/move/delete decisions. The inventories above are a starting
   point, not exhaustive acceptance.
3. **Move assistant-owned tests** — inventory all affected suites and fixtures,
   prove discovery before/after, then run owning package and remaining core lanes.
4. **Remove verified dead scaffolding and stale descriptions** — distinguish
   public wildcard exports, host hooks and dynamically registered services from
   true dead code. Each deletion names the observed caller outcome.
5. **Consolidate retention lifecycle** — use existing TaskService authority and
   typed failure reporting; preserve separately approved storage policies.
6. **Reconcile trajectory persistence** — migrate consumer by consumer with
   stored-data compatibility, concurrency and complete-record tests.
7. **Extract message/transport seams** — make canonical shared operations own
   actual repeated behavior; preserve final delivery, cancellation, interactive
   callbacks, receipt binding and post-turn ordering. Capture real model paths
   where policy or model-facing content changes.
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
- Full tests, builds, root verification and PR delivery remain unproven.
