# Runtime consolidation: acceptance ledger

Tracking: [elizaOS/eliza#31532](https://github.com/elizaOS/eliza/issues/31532).
The issue and original runtime-simplification plan remain the specification.
This ledger records implementation and acceptance by tested revision. Final integration and delivery are tracked in the linked pull request; historical failures remain attributed to their original runs.

## Measurement checkpoint

At `b3f79752c8a2d62652f849d6ff08a3e91ab02975`, against develop
`7084d6847bde067d2b16d9d420451520e9a5a50c`, the tracked text diff contains
372,836 additions and 467,058 deletions: **94,222 net lines removed**. Root
commands decrease from 208 to 77. These counts include tests, fixtures,
documentation, configuration and lockfiles; they are not executable LOC or
bundle sizes. Relocated code receives no net deletion credit.

Using the original eight-extension script/action census on both revisions,
script files decrease from 2,173 to 2,124 and physical lines from 740,375 to
724,533: **49 fewer files and 15,842 fewer lines**. The original review snapshot
had 2,175 files and 743,254 lines; upstream changes explain the different current
baseline. Compare each candidate with its own develop base.

## Ownership and implementation

| Requirement | Implemented owner and observable contract |
| --- | --- |
| Node-only runtime, one public surface | Core exports only `.`; distribution is `dist/index.js` plus `dist/index.d.ts`. No browser/edge/testing/source-condition entries. |
| Empty kernel, explicit assistant composition | Core installs no default message service. Assistant owns message processing, planner, prompt batching and concrete structured-prompt execution. Hosts now explicitly supply database adapters; no constructor/environment fallback remains. |
| Authorization and effects remain in kernel | Core owns action admission, roles/grants/approvals, audience checks, cancellation, effect receipts and terminal settlement. Assistant calls the core executor. |
| No cloud/registry/provider/storage implementation dependency in core | Registry installation belongs to its plugin; cloud routing stays in hosts; SQL, inference and per-instance ephemeral storage remain plugins. The existing in-memory plugin runtime leaf now owns the former core adapter. Its shared/HNSW root preserves a different existing contract. Packed kernel closure remains independent. |
| No HTTP route exports or runtime route table | `packages/shared/src/api` owns host contracts and route lifecycle; hosts explicitly install that lifecycle. Packed core verifies no route table and no exported Route type. |
| Auth/vault consolidation | `packages/credentials/src/auth`, `vault` and `kms`; optional adapters remain outside core. Account refresh and encrypted storage retain separate internal responsibilities. |
| Synchronous logger | Core owns Adze, sinks and ring buffer. Browser clients use `@elizaos/shared/logger`; pure redaction/error primitives live below both in `packages/common`. Old logger package removed. |
| Local and ordinary server SQL | Existing SQL plugin retains PGlite, PostgreSQL and Drizzle. Neon/Electric default integration and write-back paths removed. Identity HTTP moves outward. |
| OpenAI-compatible inference | Existing plugin owns SDK/protocol conversion, streaming and Cerebras behavior. One Node entry replaces platform variants. |
| Deterministic inference tests | Private `packages/testing` owns strict known-value fixtures with expected-call and consumption checks. Fixtures are not core production exports. |
| Canonical action and turn contracts | Tool calls use id/name/arguments; legacy argument wrappers and aliases removed. Action results require explicit success. TurnOutcome distinguishes completed/denied/cancelled/failed independently of delivery. |
| One effect/terminal lifetime | Core terminal owner and assistant turn lifetime retain receipts, reject late work and prevent effect replay after failed delivery. Provider cancellation stays terminal; transport retry budgets do not restart under another registration. |
| No generated application catalogs | Authored action metadata and prompt keywords replace generated wrappers/spec catalogs and their generators. Declaration output belongs in dist; typechecks use noEmit. |
| One composition model | Retired basic/extended constructor flags, feature preset tables, document core/headless presets and browser/edge implementations are removed. Hosts select explicit contributions. |
| Root verification | Root build:core, test:core, verify and test lanes use consolidated script owners. Packed consumers exercise published output without source aliases. |
| Detailed runtime graph | [FLOWS.md](FLOWS.md) contains seven diagrams and the file-level I/O ledger. Diagrams describe ownership and authority, not permission for plugins to bypass the executor. |

## Actual deletions versus moves

Deleted paths include browser environment stores, browser/edge parser replacements,
CSP fallback branches, the handwritten SHA-1/cache-warming implementation, unused
native-feature tables, generated application catalogs, legacy argument/result
normalizers, unused generic setup adapters, the unused capability timer wrapper,
and default hosted SQL integration. Native Node crypto preserves historical IDs
and encryption formats; dotenv loading belongs to the opt-in live test host.

Assistant workflows, registry installation, auth/vault, client helpers, Markdown
and their behavioral tests were **moved**, not eliminated. Markdown's last move
was +3,154/−3,122 lines, a 32-line net increase; this is not restored runtime policy.

Obsolete platform/export/preset and duplicated metadata-equality tests were
removed. Behavioral coverage for authorization, stale roles, disclosure, delivery
failure, cancellation, scoped storage, parser behavior and real host composition
remains with the owning implementation. Moving a test is not evidence of reduced
test burden; deleting a test is justified by a retired contract or equivalent
behavioral coverage, not by its difficulty or failure.

## Retained dependencies and trust boundaries

Core declares three production dependencies: `@elizaos/common`, `adze`, and
`zod`. Common supplies pure shared contracts, errors and deterministic primitives.
The installed kernel at `60f6b1ac1e` contains six packages including core itself:
common, Adze, Zod, `@ungap/structured-clone`, and `picocolors`.

Authored keywords, matching, JSON5 parsing and Handlebars rendering belong to
`@elizaos/prompts`; conversational entity resolution belongs to assistant;
attachment MIME detection belongs to `@elizaos/shared/media`. Prompts is a core
dev dependency for retained contract tests, and does not enter its production
closure. Actual packed-consumer verification confirms these dependency boundaries;
relocated implementations remain maintained code and receive no deletion credit.

Keep freshness checks immediately before effects/disclosure, encrypted AAD,
scoped cache keys, SSRF protection and approval binding. These enforce real
boundaries after asynchronous work. The deleted cpuMs wrapper did not terminate
JavaScript and had no production caller. In-process plugins are trusted Node code;
mediated role checks are not hostile-code isolation. Native library containment
remains at its actual host resolver, including symlink/cross-bundle rejection.

## Residual complexity and ownership review

The current AST proxy compares develop `7084d6847b` with combined revision
`b3f79752c8`. It counts one per function plus if/ternary/loop/case/catch/boolean
and nullish decisions, with nested functions measured separately. It is not
complete McCabe analysis. Its 19 owner scopes include core, former auth/vault/
logger/registry, credentials, common, testing, assistant, registry plugin, SQL,
OpenAI, agent, app-core, shared, in-memory storage, scenario runner, prompts and
maps. Non-test JS/TS decision scores are **152,451 → 148,558** (−3,893, or 2.6%);
functions above 25 decisions are **446 → 434**. The earlier 15-owner totals used
a different scope and must not be compared directly with this measurement.

Scripts are included; a UI test-server stub is not a production runtime hotspot.
Moving code out of core earns no reduction credit across the complete owner set.
Conversation routing's entrypoint reduction mostly distributes branches into
named handlers; use the combined totals, not that single function, to assess
actual complexity reduction.

| Function | Before → after decision score | Disposition |
| --- | --- | --- |
| Agent handleConversationRoutes | 430 → 4 | Fifteen independently maintained selectors now use one ordered route table and shared request preparation. Named handlers retain domain authority and room/effect lifetimes. The change adds 50 net lines; it is dispatch consolidation, not a line reduction. |
| Agent handleRequest | 217 → 217 | Ordered authority, platform and transport branches retained after full source review; 100 net lines of unreachable helpers and aliases removed. |
| Assistant runPlannerLoopIterations | 310 → 286 | Shared required-tool miss and evaluator finish policy removes 104 net implementation lines. Remaining reply/scope states preserve different effect and delivery contracts; current score includes the consolidated paths. |
| Core useModel | 205 → 198 | Direct Node clock removes fallback probes; cancellation, streaming and failure ownership stay distinct. |
| Assistant runV5MessageRuntimeStage1 | 188 → 182 | Some branch deletion, not wholesale rewrite. |
| Structured prompt execution | Relocation; no deletion credit | Concrete schema/template/recovery execution moved to assistant. Core delegates to an explicitly registered executor and fails before model dispatch when absent. Generic prompt rendering remains a kernel API. |
| Assistant processMessage | 144 → 133 | Terminal ownership consolidation reduces local decisions. |
| Agent startEliza | 138 → 132 | Explicit composition removes some inferred modes. |
| Core stem | 372 → 372 | Snowball linguistic algorithm; do not rewrite solely to lower a complexity score. |

Do not certify all requested simplification from a green suite or smaller core
alone. Complete final verification against the original plan; cosmetic wrapper
extraction is not a reduction in workflow policy.

## Acceptance evidence

Evidence is attached to the delivery PR, outside the source tree. Results are
bound to their tested revisions. Unchanged-source attribution is explicit;
a focused retry does not relabel a failed full run as passing.

| Contract | Reviewed result |
| --- | --- |
| Root gates | At b3f79752c8, verify passes all 377 tasks with zero cache hits and all repository audits. Normal frozen install passes at 072f; the only intervening change is a scenario fixture import. Final integration gate is recorded in the PR. |
| Core and assistant | At b3f79752c8, core passes 7,392 tests with 2 skips; assistant passes 4,636 tests. |
| SQL | At 072f, PGlite passes 793 tests with 36 backend-specific skips. PostgreSQL passes 471 tests with zero skips; all 36 PGlite skips map to executed PostgreSQL cases. A separate supplement passes 19 migration, locking and concurrent membership/rollback cases. Teardown succeeds. |
| Credentials and provider | At 072f, credentials pass 601 tests; OpenAI passes 520; the actual-runtime lane passes 23 with 3 explicit live-only skips. These code trees are unchanged at b3f. |
| Real inference | At b3f, four actual Cerebras qwen-3.8-27b calls select and execute a PGlite read and deliver its unpredictable marker exactly. No retries. Complete request parameters, outputs, tool results and final reply are retained. Embeddings are controlled fixtures; no external connector or embedding-quality claim. |
| Packed consumers | 96 real archives have no missing concrete distribution export targets after the packaging repair. Fresh generated project and plugin install, typecheck, build and tests pass. Project cold/warm startup activates all 14 required plugins, serves documents/inbox routes and closes owned ports. Three formerly source-only export branches resolve from actual repaired archives. |
| CLI upgrade | The earlier 376e generated-project upgrade preserves local overrides and passes reinstall/types/build/startup. CLI source is unchanged through b3f. |
| Agent staging | The b3f full agent run exposes a repository-relative Unicode import in the staged assistant plugin. The repair uses the already-public core export; the PR contains its focused staged-consumer result and final suite attribution. |
| Scripts | The b3f full run exposes a missing GNU utility in the macOS PATH and a Git ancestry fixture timeout. All four failure files pass unchanged with the utility available: 79 tests. The original failure record remains attached; final canonical execution is recorded separately. |
| UI | Independent baseline 7084 and candidate b3f builds each pass 230 audit checks and produce 224 manually reviewed captures. Both have 201 good and 23 needs-eyeball verdicts, zero needs-work/broken, and identical diagnostic arrays. The current named bundle verifies all 678 artifacts. |
| Walkthrough | All 50 desktop/mobile steps and 50 decoded MP4 frames are inspected. Both viewport gates have no page/console/server failures. Videos are paced captured states, not continuous pointer recordings. API/model fixtures do not prove live provider or device behavior. |
| App-core and scenario | Current terminal results and final revision attribution are recorded in the delivery PR. Earlier app-core qualification at 5359 passed 4,567 tests with 25 skips plus 24 script tests. Current scenario corpus validation passes at b3f. |
| Native/platform | Distinct target/compiler/signing and browser contracts remain with their owners. Hardware execution is not claimed from browser fixtures. The PR records hosted platform outcomes and explicit unavailable checks. |

The three changed package-export branches retain explicit `eliza-source`
selection for repository tooling while ordinary Bun/worker/development consumers
use files actually included in the archive. Complete runtime outputs must be
built before packing; a view-only dist directory is insufficient.

The reduction preserves stored-role freshness, encrypted AAD, cancellation,
exact evidence provenance and lossless model context. No production maintenance,
registry publication, paid compute or model upload is part of this cleanup.
