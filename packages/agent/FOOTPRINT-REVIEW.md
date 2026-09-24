# Agent footprint and ownership review

The host should own process assembly, authenticated transport, configuration,
installation policy, and adapters to host storage and native capabilities.
Assistant behavior belongs in `plugin-assistant`; domain implementations belong
in their plugins. Core should receive reusable runtime contracts only when it
actually has consumers for them, without acquiring HTTP, product configuration,
provider SDKs, or deployment policy.

This review continues the scope of issue #31532. It inventories the entire agent
package, traces internal imports/re-exports and external package imports, checks
dynamic boot and deployment entries, and compares duplicate function bodies.
Implementation review concentrates on deletion candidates and changed contracts.
The inventory is not an exhaustive correctness or security audit of every
retained function. Existing concurrent chat, trajectory, browser and UI work is
outside this patch.

## Changes implemented

| Change | Result and caller contract |
| --- | --- |
| Remove nine `agent-backup-restore-v3-candidate-*` modules | Removes 11,871 lines of unfinished staging machinery. Imports and 80 distinctive exported symbols had no callers outside the cluster. Current restore routes continue using snapshot restore. |
| Merge capture-v2 into `services/agent-backup.ts` | One backup implementation file owns snapshot capture/restore, encrypted local backups and binary capture. Directory constants, filesystem existence/containment and vault classification are shared. Streaming, cancellation, frame hashes, memory preflight and snapshot format remain distinct where required. |
| Preserve the published capture-v2 subpath | Package export mapping points at the consolidated implementation; no forwarding source file remains. Internal HTTP imports and the services barrel use the canonical module. |
| Consolidate wallet key handling | `api/wallet-keygen.ts` owns generation, EVM/Solana derivation, bounded Solana decoding and environment synchronization. `wallet.ts` imports/re-exports that implementation. Configuration imports the leaf without loading RPC/config cycles. The old env-sync package subpath maps to this leaf. |
| Remove disconnected helpers | Removes the unused app-launch agents-list guard, terminal routing predecessor, canonical-memory writeback, memory-soak harness, public-route source scanner and tool-cache action wrapper. The active shell router, canonical file boot, app stability suite and externally consumed cache library remain. |
| Remove unused TypeSafe client | Removes its unintegrated client and local README; no runtime registration or consuming source was found. |
| Remove unused task-executor scaffold | Removes the standalone task registry and research executor, whose only consumers were exports/documentation. Existing runtime task scheduling and model providers remain. |
| Remove unused remote live-report writer | No report producer calls it. Existing artifact validators remain. |
| Move remote conformance out of runtime source | The retained RPC conformance harness lives in `scripts/lib/`; its CI surface audit points at that location. It is no longer exported/shipped as a runtime service. |
| Deduplicate media mode selection | Image, video and audio use one identical cloud-selection predicate; model dispatch and provider behavior remain separate. |
| Remove unused direct dependencies | Removes `git-workspace-service`, `jsdom`, `lucide-react` and the unused development declaration package `@types/jsdom`. The lockfile is regenerated with pinned Bun. Other workspaces may still require these packages. |

The patch removes **22 runtime source paths** and **15,193 runtime source lines**
relative to the initial working-tree inventory. Of those lines, **1,461 move to
tooling**, so the net reduction across existing runtime/tooling implementations
is **13,732 lines**, before adding regression tests. These are physical lines,
including comments and whitespace, not executable LOC or bundle bytes. Unrelated
concurrent edits are excluded from the change calculation. The initial runtime
inventory contained 533 TypeScript files and 212,896 physical lines.

## Package-wide placement decisions

| Area | Decision | Reason / consolidation boundary |
| --- | --- | --- |
| `bin.ts`, `cli/`, process lifecycle, runtime installation identity | Keep in agent | These own the executable and process/installation authority. CLI, startup and teardown are different consumers and lifetimes. |
| `runtime/eliza.ts`, boot pipeline, blocking/deferred boot, plugin resolution | Keep host ownership; simplify orchestration by phase | These assemble the concrete host. Moving them into core would pull application configuration and installed-package policy into the kernel. Do not merge readiness, deferred cancellation and process teardown into a larger startup file. |
| `api/server*`, route dispatch, HTTP/Hono adapters, WebSocket/PTY adapters | Keep transport in agent | One authenticated dispatcher can serve several protocols. Separate listener lifetime, authentication, request translation and domain work. Existing concurrent chat/trajectory cleanup owns those edited paths. |
| `api/conversation-*`, `chat-*`, message idempotency/interaction services | Preserve transport and durable-effect boundaries | Shared lifecycle operations are good extraction targets, but their ordering, leases, delivery settlement and persistence must remain authoritative. Merging all conversation files would obscure rather than remove those responsibilities. |
| `actions/`, conversational providers, research/media orchestration | Prefer assistant or domain plugins when host dependencies are removed | Memory/knowledge/contact behavior and conversational policy should not require the host. Existing actions call host configuration, owner identity and APIs; those ports must be supplied by composition before moving implementations. |
| Page-scoped context, view registry/assets/interactions | Keep host adapters | These know the authenticated renderer, installed app revision and current view. The shared rendering vocabulary may belong in UI/shared, but host admission and per-client state do not. |
| `providers/media-provider.ts`, `services/media-generation.ts` | Provider implementations should converge on provider plugins | Direct provider HTTP implementations duplicate the model-provider layer. Retain the current adapter until every image/video/audio path has equivalent model handlers, credentials, cancellation and result shapes. Moving it into core is inappropriate. |
| `api/wallet*`, `tx-service.ts`, signing policy/backends | Key duplication fixed; remaining wallet business logic is a plugin-wallet candidate | HTTP admission, host environment/config persistence and TEE/vault injection stay host-side. Balance fetches, DEX pricing and trading analytics are domain logic; migrate them behind plugin contracts without introducing a plugin-to-agent cycle. |
| `config/`, owner contacts, env authority, provider switching | Keep persistence/projection in host | Configuration loading, secret redaction, first-run and runtime switching have different failure contracts. Shared config types already live in shared. Tiny re-export paths are compatibility, not duplicate implementations. |
| `config/zod-schema*`, `config/schema.ts` | Retain compositional schemas | Runtime, connector, session and hook validation are separate concepts. UI-schema generation is a consumer of validation. Combining all schemas saves filenames but does not remove a responsibility or duplicated computation. |
| `services/registry-client*`, plugin installer/compiler, app-package resolution | Keep host loading/install policy; review overlapping discovery algorithms | Shared catalog data already owns first-party inventory. Endpoint normalization, network/cache behavior, local package discovery and presentation metadata are distinct. Registry queries and runtime resolver should share exact package-resolution rules where equivalent, rather than share a giant registry file. |
| Remote capability router, adapter, endpoint provisioning, coding runner | Keep composition in host; leave canonical wire types in core | These adapt remote execution into the running host. The coding runner is dynamically imported through a variable and is not dead. Conformance/reporting tooling is removed from production source. |
| `services/permissions*`, native bridge and probers | Keep host registry; native probing belongs with native/platform ownership | Calendar/reminders/contacts and camera/microphone have useful factory opportunities. Their upgrade/request semantics differ, and they require native acceptance. Do not collapse platform policy solely to save their small files. |
| `services/tee-*`, `security/confidential-*`, confidential boot | Retain explicit deployment boundaries | Evidence normalization, policy, key release, revocation, protected storage and same-session transport are different authorities. Concrete dstack collection is a provider/plugin extraction candidate; generic core must not acquire dstack process/socket dependencies. Documented deployment entrypoints remain even without internal callers. |
| `services/agent-backup*`, `agent-export.ts` | Consolidate backup formats; keep export separate | A backup restores exact agent storage; portable export remaps graph IDs and omits vectors. They are not interchangeable serialization paths. Backup generation authority is also used by destructive domain workflows and remains a separate shared boundary. |
| `services/file-storage.ts`, `api/media-store.ts`, VFS | Keep the canonical media adapter and distinct project VFS | FileStorage delegates to the one content-addressed media store. VFS models mutable project trees and Git, not a competing attachment store. Do not merge them into a second generic file abstraction. |
| Audio redaction | Keep execution, verification and publication boundaries | Process budgets, independent transcription verification and content-addressed publication are separate stages of one fail-closed workflow. A single file would not remove that ordering requirement. |
| Retention, triggers, scheduling helpers | Keep host policy on the existing task clock | The scheduler is already core-owned. Trigger configuration and human phrasing are adapters; do not create or move a second scheduler. Storage deletion policy is separate from when jobs run. |
| Trajectory modules | Continue the existing storage-contract reconciliation | Canonical serialization belongs in core, assistant recording in assistant, host persistence/API in agent. Current files have active concurrent edits. Combining readers/writers before reconciling stored representations would only hide duplication. |
| Workspace hooks | Keep host discovery/loading; retain event registry separation | Discovery performs filesystem and package work; eligibility evaluates machine requirements; the event registry dispatches in-process callbacks. They have distinct lifetimes and contracts. |
| Tool-call cache | Keep externally consumed library; remove unwired wrapper | The app re-exports the library. Cache-key canonicalization, privacy projection and storage each protect different invariants. No live host action registration called the removed wrapper. |
| `scripts/`, `test/`, fixtures and platform stubs | Keep tooling outside runtime source | Executable/package/CI references are roots even when no source imports exist. Platform stubs are selected by bundlers. Conformance moved here; regression scenarios use real host/storage/crypto paths. |
| `types/`, `contracts/`, awareness and diagnostics re-exports | Retain compatible public paths | Most already delegate to their actual owner. Deleting these is API churn with negligible implementation reduction; it is not equivalent to removing duplicate behavior. |

## Specific remaining opportunities and constraints

1. **Wallet ownership:** finish moving balances/pricing/trading logic behind the
   existing wallet plugin's injected dependencies. This is the largest clear
   domain misplacement in `api/`; HTTP modules should translate its results.
2. **Media providers:** remove direct provider duplication only after matching
   each path to its model-handler implementation and verifying real generation.
   Moving a file without removing a second provider path is not a reduction.
3. **SQL error compatibility:** `runtime/pglite-error-compat.ts` duplicates the
   SQL plugin's error utilities. The plugin's root exports them, but lacks a
   lightweight error subpath. Importing its full root eagerly into boot would
   alter the startup dependency graph. Add and qualify the leaf export before
   replacing this compatibility copy.
4. **Permission factories:** group truly identical native probing mechanisms,
   keeping per-permission upgrade/request behavior explicit. Test on native
   platforms before claiming equivalent prompts or grants.
5. **Host-free assistant actions:** replace configuration/API imports with
   narrow injected host ports, then move behavior into its owning plugin. Core
   should not become the destination for application behavior just because it
   is already installed everywhere.
6. **Legacy feature gates:** `native-runtime-features.ts` probes
   `isTrajectoriesEnabled`/`isDocumentsEnabled`, whose implementations were not
   found in current core. Establish the current supported feature contract
   before replacing those gates; deleting checks can accidentally enable work.

The new backup scenario also exposed an existing protocol mismatch: name-hashed
runtime IDs use the historical UUID version-zero format, while capture-v2's
shared schema requires RFC UUID versions accepted by Zod. Such IDs get HTTP 400
before capture. The acceptance fixture uses a valid RFC agent ID; this cleanup
does not change the deployed capture schema or historical identity derivation.

## Verification

- Both backup formats exercised over the real host HTTP server with file-backed
  PGlite, complete multi-frame media, an empty file, state/vault classification,
  cache exclusions and actual database export.
- Backup admission rejects unauthenticated, wrong-agent and expired requests;
  tampered snapshot bytes are rejected without changing the original media.
- Real wallet generation, validation, import and public-address environment
  readback pass, including malformed and oversized input rejection.
- All seven current agent test files pass; agent typecheck, read-only lint and
  build pass. Lint retains nine existing warnings.
- The relocated remote-capability CI audit passes all published RPC checks.
- Native Node imports through both built compatibility subpaths pass actual key
  derivation and typed capture-rejection checks.
- Root verification did not pass. The first run encountered transient JSON
  merge-conflict markers in the shared checkout. After those disappeared, the
  retry reached Turbo and failed in `@elizaos/configbench#typecheck`, including
  TS5097 errors for testing-source imports without `allowImportingTsExtensions`.
  It reported 211 successful tasks. Both logs are in the evidence directory.
  These are shared-working-tree results, not an isolated PR/head or deployed
  acceptance.

Machine-readable before/inventory/external-consumer records, a per-file
`source-review-inventory.csv`, and command logs are
under repository-root `test-results/agent-footprint/`. Generated evidence stays
ignored. No UI, model prompt, native permission flow or deployment was changed,
so visual, live-model and hardware acceptance are not claimed for this patch.
