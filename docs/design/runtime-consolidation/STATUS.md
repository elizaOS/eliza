# Runtime consolidation: acceptance ledger

Tracking: [elizaOS/eliza#31532](https://github.com/elizaOS/eliza/issues/31532).
The issue and original runtime-simplification plan remain the specification.
This ledger replaces chronological checkpoint notes. Implementation is not yet certified complete. The original cleanup history is pushed; the rebased delivery branch is not yet published; current integration qualification, final root verification, PR/merge and delivery to `~/v3` remain acceptance work. The cold-bootstrap repair passed a fresh normal install and full root verification at5359.

## Measurement checkpoint

At `12db3a6b0e38762c64b6ea94d1c9a9e64f0470b2`, against develop
`7084d6847bde067d2b16d9d420451520e9a5a50c`, the tracked text diff contains
372,780 additions and 467,014 deletions: **94,234 net lines removed**. Root
commands decrease from 208 to 77. These counts include tests, fixtures,
documentation, configuration and lockfiles; they are not executable LOC or
bundle sizes. Relocated code receives no net deletion credit.

Using the original eight-extension script/action census on both revisions,
script files decrease from 2,173 to 2,124 and physical lines from 740,375 to
724,521: **49 fewer files and 15,854 fewer lines**. The original review snapshot
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

The current AST proxy compares develop `d07f6dc2e2` with combined revision
`8f74cf19fa`. It counts one per function plus if/ternary/loop/case/catch/boolean
and nullish decisions, with nested functions measured separately. It is not
complete McCabe analysis. Its 19 owner scopes include core, former auth/vault/
logger/registry, credentials, common, testing, assistant, registry plugin, SQL,
OpenAI, agent, app-core, shared, in-memory storage, scenario runner, prompts and
maps. Non-test JS/TS decision scores are **152,199 → 148,305** (−3,894, or 2.6%);
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

## Acceptance evidence and remaining gates

Counts below describe completed local runs, not every check on one final merged
SHA. Full-suite retries must finish; a focused retry does not erase an earlier
full-run failure. Artifact logs remain outside git per CONTRIBUTING.md.

| Gate | Observed result / remaining requirement |
| --- | --- |
| Core complete suite | At8f74:7391 passing tests,2 skipped,479 passing files. Core source is unchanged through5359; delivery includes later upstream changes that need current qualification. |
| Assistant complete checkpoint | Atfe66:4628 tests across358 files passed; its tree is identical through5359. New upstream streaming and evaluator changes are now transplanted into assistant and require focused and final qualification. |
| App-core complete checkpoint | At5359:4567 tests passed,25 skipped;360 files passed,1 skipped, plus24 script tests. Delivery includes new upstream first-run activation behavior; current qualification remains due. |
| PostgreSQL | At `d640bb74b0`: private PostgreSQL 48 files / 471 tests passed without skips; PGlite 69 files / 614 passed, 36 skipped. PostgreSQL receipt records identical start/end revisions and successful teardown. |
| Real inference | At `aed153a41b`: three actual Cerebras calls, an actual PGlite read and exact random-marker final delivery pass after the task-admission shutdown repair. No room-queue-closed or task-tick failure occurs during teardown. Controlled embeddings remain a fixture, not embedding-quality evidence. |
| Packed kernel | At `1c2b199e2d`, the full root gate includes the actual isolated six-package installed production closure, Node boot, deterministic inference, logger, root-only exports and TypeScript consumer. Later cold-bootstrap configuration changes require final verification. |
| Packed host/client | External host install/build/startup and client bundle checks run in integration lane; attach final revision and artifacts. |
| Full agent suite | At5359:all782 batches finished, with one30-second WebSocket-auth test timeout. Its isolated15-test retry passed. The original full run remains failed; final delivery qualification must account for that result and new upstream behavior. |
| Canonical install + verify | At5359:normal frozen install648s and full root verify2879s passed in a fresh isolated checkout;377/377 tasks plus audits passed, source clean. Current rebased delivery qualification remains due. |
| Canonical scripts | At `d640bb74b0`: 3,602 passed, 29 skipped, zero failures. The entire packages/scripts source tree is identical at `8f74cf19fa`. The later cold-bootstrap workflow expectation change passes its focused tests and remains subject to final combined validation. |
| Generated source leakage | Wallet inherited source aliases emitted 238 shared declarations. Build-only dist aliases fix the actual emitter; real build and zero-leak inspection passed. Original generated files were preserved with a hash manifest. Repeat the source audit after the final combined build. |
| Desktop/mobile | At8f74:230 audit checks,all224 captures and two25-step walkthrough videos manually reviewed. Add-conversation and horizontal calendar scrolling passed real Chromium interactions. Upstream UI changes arrived afterward; current capture attribution/refresh remains due. Mock UI evidence does not prove live-model or device behavior. |
| Rebased fixture consumers | Private testing 121; scenario runner 783 plus 19 mock-boundary tests; evaluator wire 6; merged Telegram route/real 25+2; orchestrator 1; person-link real ingress 5; consolidated receipt suite 155 passed. These supplement, rather than replace, final package gates. |
| Stored-role freshness | At `d640bb74b0`, both retained-authority and revocation-during-validation cases pass against real PGlite and private PostgreSQL. The test changes the stored role while validation awaits, then proves the effect marker is absent after revocation. |
| Develop and hosted workflows | Branch chore/refactor-rebase is pushed at `8f74cf19fa`. Platform run 35365319453 fails on both macOS and Windows before tests because prompts builds before common. The isolated cold-bootstrap repair addresses that ordering; no hosted pass, PR or merge is claimed. |
| Requested checkout | Delivery candidate is in `v3-delivery`; original pushed history remains in `v3-refactor-rebase`. Synchronize into `~/v3` after merge while preserving the user's untracked WORKFLOW_SIMPLIFICATION_PLAN.md. No stash/reset of another task's work. |

Completion requires final evidence for these gates, the residual-complexity
review, and the requested develop delivery. Update this ledger with terminal
results rather than appending another contradictory checkpoint narrative.
