# Runtime consolidation: acceptance ledger

Tracking: [elizaOS/eliza#31532](https://github.com/elizaOS/eliza/issues/31532).
The issue and original runtime-simplification plan remain the specification.
This ledger replaces chronological checkpoint notes. Implementation is not yet
certified complete: final verification, refreshed complexity measurements, delivery to
`~/v3`, and hosted workflow results remain acceptance work.

## Historical measurement checkpoint

The table below compares `13cc36d4acbe0f29f426cd9e6e69aeb262abe818`
with `6953b993febeab582c3d30da2ec6bcc8495251c9`. These are historical measurements.
The combined branch now includes later ownership changes and is rebased onto
`47216363f51bcd1057b20b55f9666d5f7013c927`. Refresh the full measurement table
after final combined verification; do not attribute upstream additions
or relocated implementations to newly added runtime policy.

| Measure | Before / after or net change |
| --- | --- |
| All tracked text, including lockfiles | 321,222 additions; 404,909 deletions; **83,687 net lines removed** |
| Non-test JS/TS across the repository | **28,668 net lines removed** |
| Tests and fixtures | **13,474 net lines removed** |
| JSON and lockfiles | **41,064 net lines removed** |
| Core non-test JS/TS | 328,452 → 144,487 lines; 861 → 422 files |
| Assistant non-test JS/TS | 145,453 lines / 337 files after extraction; primarily relocation |

These are tracked text lines, including comments and build scripts, not executable
LOC or bundle sizes. Tests are classified by test/spec/fixture/mock filenames and
test directory names. Moves and formatting can appear as additions plus deletions.
Do not describe the entire net reduction as deleted runtime logic.

From integration checkpoint `27312a89f6` to `182428a97a`, total size increased
34,618 lines. The corresponding develop update `215bd8a541` → `13cc36d4ac`
added 35,268 lines: our intervening changes removed another 650 net lines.
The subsequent `6953b993fe` adds 30 workflow lines, not runtime functionality.

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

The current AST proxy compares develop `47216363f51` with combined revision
`e6bdb88622`. It counts one per function plus if/ternary/loop/case/catch/boolean
and nullish decisions, with nested functions measured separately. It is not
complete McCabe analysis. Its 19 owner scopes include core, former auth/vault/
logger/registry, credentials, common, testing, assistant, registry plugin, SQL,
OpenAI, agent, app-core, shared, in-memory storage, scenario runner, prompts and
maps. Non-test JS/TS decision scores are **152,211 → 148,386** (−3,825, or 2.5%);
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
| Structured prompt execution | Historical 161 → 161; refresh required | Concrete schema/template/recovery execution moved to assistant. Core delegates to an explicitly registered executor and fails before model dispatch when absent. Generic prompt rendering remains a kernel API. |
| Assistant processMessage | 144 → 133 | Terminal ownership consolidation reduces local decisions. |
| Agent startEliza | 138 → 132 | Explicit composition removes some inferred modes. |
| Core stem | 372 → 372 | Snowball linguistic algorithm; do not rewrite solely to lower a complexity score. |

Do not certify all requested simplification from a green suite or smaller core
alone. Complete final verification and the stored-role freshness acceptance row against the
original plan; cosmetic wrapper extraction is not a reduction in workflow policy.

## Acceptance evidence and remaining gates

Counts below describe completed local runs, not every check on one final merged
SHA. Full-suite retries must finish; a focused retry does not erase an earlier
full-run failure. Artifact logs remain outside git per CONTRIBUTING.md.

| Gate | Observed result / remaining requirement |
| --- | --- |
| Core complete suite | Combined revision `e446d4e0e0`: 481 passing files / 7,406 passing tests, 2 skipped. Later changes through `a9f5787bb5` affect only UI/finances TypeScript configuration; core source/tests are unchanged. |
| Assistant complete checkpoint | 343 files / 4,441 tests passed (`refactor-delivery-assistant.log`) before batching/structured ownership changes. Full final-candidate run remains required. |
| App-core complete checkpoint | 360 files passed, 1 skipped; 4,574 tests passed, 25 skipped, plus 99 companion script tests (`refactor-rebased-built-appcore-full.log`). Final evidence must identify the tested revision. |
| PostgreSQL | Final bootstrapped artifact reports 466 passed, no skips; retain database lifecycle evidence with the result. |
| Real inference | Live Cerebras Stage-1 → native planner call → core executor → actual PGlite read → exact-marker final delivery passes at `a9f5787bb5`. Synthetic read-only action explicitly allows guests; the earlier default-role denial is retained as a negative control. Controlled embeddings are test dependencies, not embedding-quality evidence. Full traces remain outside git. |
| Packed kernel | At `60f6b1ac1e`, the isolated installed closure contains six packages. Actual Node boot, TypeScript consumer, known-value dispatch and root-only exports pass. Prohibited dependency families are checked recursively; refresh at the final candidate. |
| Packed host/client | External host install/build/startup and client bundle checks run in integration lane; attach final revision and artifacts. |
| Full agent suite | Last 786-batch run failed only the optional-entrypoint stdout fixture. A dedicated subprocess result file fixes that race and its focused check passes. Full final-candidate rerun remains required; no full green claim. |
| Canonical install + verify | Normal frozen install passes at `5c61379147`. Root verify there failed in finances shared-UI typechecking after 271 successful tasks; `a9f5787bb5` fixes the missing Vite declarations and focused typecheck passes. Last full green verify remains `c6dca7653d` (376/376); current combined verify and owner suites remain required. |
| Generated source leakage | Wallet inherited source aliases emitted 238 shared declarations. Build-only dist aliases fix the actual emitter; real build and zero-leak inspection passed. Original generated files were preserved with a hash manifest. Repeat the source audit after the final combined build. |
| Desktop/mobile | Previous native build/install, 224-capture app audit and 50-step desktop/mobile walkthrough were inspected. Upstream UI changes arrived afterward; final capture attribution or refreshed affected captures remain required. Mock UI evidence does not prove live-model or device behavior. |
| Rebased fixture consumers | Private testing 121; scenario runner 783 plus 19 mock-boundary tests; evaluator wire 6; merged Telegram route/real 25+2; orchestrator 1; person-link real ingress 5; consolidated receipt suite 155 passed. These supplement, rather than replace, final package gates. |
| Stored-role freshness | Final role-bypass mutation detects supplied-role checks, but does not prove a real stored revocation during an in-flight turn. That original acceptance row remains under targeted review; do not mark complete from the weaker evidence. |
| Develop and hosted workflows | PR/merge, exact merged SHA checks and applicable workflow results remain pending. Local green is not hosted verification. |
| Requested checkout | Combined candidate is in `v3-refactor-rebase`; synchronize into `~/v3` while preserving the user's untracked WORKFLOW_SIMPLIFICATION_PLAN.md. No stash/reset of another task's work. |

Completion requires final evidence for these gates, the residual-complexity
review, and the requested develop delivery. Update this ledger with terminal
results rather than appending another contradictory checkpoint narrative.
