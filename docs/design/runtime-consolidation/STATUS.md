# Runtime consolidation: acceptance ledger

Tracking: [elizaOS/eliza#31532](https://github.com/elizaOS/eliza/issues/31532).
The issue and original runtime-simplification plan remain the specification.
This ledger replaces chronological checkpoint notes. Implementation is not yet
certified complete: final verification, residual-complexity review, delivery to
`~/v3`, and hosted workflow results remain acceptance work.

## Measured candidate

Source measurements compare `13cc36d4acbe0f29f426cd9e6e69aeb262abe818`
(current develop base) with `6953b993febeab582c3d30da2ec6bcc8495251c9`.
Later documentation-only commits do not change source measurements.

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
| Empty kernel, explicit assistant composition | Core registers supplied contributions; it installs no default message service. `plugins/plugin-assistant` owns message processing, planner and conversational features. |
| Authorization and effects remain in kernel | Core owns action admission, roles/grants/approvals, audience checks, cancellation, effect receipts and terminal settlement. Assistant calls the core executor. |
| No cloud/registry/provider/storage implementation dependency in core | Registry installation moves to `plugins/plugin-registry/src/runtime`; cloud routing stays in hosts; SQL and inference remain plugins. Packed dependency closure is checked recursively. |
| No HTTP route exports or runtime route table | `packages/shared/src/api` owns host contracts and route lifecycle; hosts explicitly install that lifecycle. Packed core verifies no route table and no exported Route type. |
| Auth/vault consolidation | `packages/credentials/src/auth`, `vault` and `kms`; optional adapters remain outside core. Account refresh and encrypted storage retain separate internal responsibilities. |
| Synchronous logger | Core owns Adze, sinks and ring buffer. Browser clients use `@elizaos/shared/logger`; pure redaction/error primitives live below both in `packages/common`. Old logger package removed. |
| Local and ordinary server SQL | Existing SQL plugin retains PGlite, PostgreSQL and Drizzle. Neon/Electric default integration and write-back paths removed. Identity HTTP moves outward. |
| OpenAI-compatible inference | Existing plugin owns SDK/protocol conversion, streaming and Cerebras behavior. One Node entry replaces platform variants. |
| Deterministic inference tests | Private `packages/testing` owns strict known-value fixtures with expected-call and consumption checks. Fixtures are not core production exports. |
| Canonical action and turn contracts | Tool calls use id/name/params; legacy argument wrappers and aliases removed. Action results require explicit success. TurnOutcome distinguishes completed/denied/cancelled/failed independently of delivery. |
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

Core declares seven production dependencies: `@elizaos/common`,
`@elizaos/prompts`, `adze`, `zod`, `handlebars`, `json5`, and `file-type`.
Common supplies pure shared contracts/errors; prompts supplies authored keyword
metadata; Handlebars and JSON5 support the retained generic prompt APIs; file-type
is loaded lazily at attachment MIME inference. Zod and Adze remain intentional.
The plan's conditional Zod-plus-Adze target is **not fully reached**. A lazy import
removes startup cost, not ownership or dependency cost; further extraction must
migrate real consumers rather than replace mature libraries with handwritten code.

Keep freshness checks immediately before effects/disclosure, encrypted AAD,
scoped cache keys, SSRF protection and approval binding. These enforce real
boundaries after asynchronous work. The deleted cpuMs wrapper did not terminate
JavaScript and had no production caller. In-process plugins are trusted Node code;
mediated role checks are not hostile-code isolation. Native library containment
remains at its actual host resolver, including symlink/cross-bundle rejection.

## Residual complexity: incomplete simplification review

The AST proxy counts one per function plus if/ternary/loop/case/catch/boolean and
nullish decisions, with nested functions measured separately. It is not complete
McCabe analysis. Across core, former auth/vault/logger/registry, credentials,
common, testing, assistant, registry plugin, SQL, OpenAI, agent, app-core and shared,
non-test JS/TS decision scores are **142,564 → 139,578** (−2,986); functions above
25 decisions are **401 → 395**. Scripts are included; a 517-decision UI test-server
stub must not be described as a production runtime hotspot.

Core alone falls 50,530 → 21,150, but assistant now contains 24,170. That reduction
mostly measures relocation. The full owner graph is the relevant comparison.

| Function | Before → after decision score | Disposition |
| --- | --- | --- |
| Agent handleConversationRoutes | 430 → 430 | Large endpoint dispatcher remains; original route-table simplification is not demonstrated. |
| Agent handleRequest | 217 → 217 | Host ownership is correct; middleware/dispatch consolidation still requires review. |
| Assistant runPlannerLoopIterations | 310 → 310 | Extracted policy and typed effect contracts; internal planner complexity remains. |
| Core useModel | 205 → 206 | Cancellation/failure provenance strengthened; no claim of dispatcher complexity reduction. |
| Assistant runV5MessageRuntimeStage1 | 188 → 182 | Some branch deletion, not wholesale rewrite. |
| Core dynamicPromptExecFromState | 161 → 161 | Generic structured-prompt implementation retained; ownership/recovery disposition remains to close. |
| Assistant processMessage | 144 → 133 | Terminal ownership consolidation reduces local decisions. |
| Agent startEliza | 138 → 132 | Explicit composition removes some inferred modes. |
| Core stem | 372 → 372 | Snowball linguistic algorithm; do not rewrite solely to lower a complexity score. |

Do not certify all requested simplification from a green suite or smaller core
alone. Close the remaining ownership/recovery/dispatch findings against the
original plan; cosmetic wrapper extraction is not a reduction in workflow policy.

## Acceptance evidence and remaining gates

Counts below describe completed local runs, not every check on one final merged
SHA. Full-suite retries must finish; a focused retry does not erase an earlier
full-run failure. Artifact logs remain outside git per CONTRIBUTING.md.

| Gate | Observed result / remaining requirement |
| --- | --- |
| Core complete suite | 529 files passed, 2 skipped; 7,959 tests passed, 2 skipped (`refactor-composition-final-core.log`). |
| Assistant complete checkpoint | 342 files / 4,411 tests passed (`refactor-rebased-assistant-final-full.log`); final run including moved failure-reply tests pending. |
| App-core complete checkpoint | 360 files passed, 1 skipped; 4,574 tests passed, 25 skipped, plus 24 companion script tests (`refactor-rebased-built-appcore-full.log`). Final evidence must identify the tested revision. |
| PostgreSQL | Final bootstrapped artifact reports 466 passed, no skips; retain database lifecycle evidence with the result. |
| Real inference | Live Cerebras native tool selection → core executor → PGlite read → final model response recorded outside git. This complements deterministic fixtures. |
| Packed kernel | External installed closure reports 24 packages; actual Node boot, TypeScript consumer, known-value dispatch and root-only exports pass. Prohibited dependency families are checked recursively. |
| Packed host/client | External host install/build/startup and client bundle checks run in integration lane; attach final revision and artifacts. |
| Full agent suite | Earlier full run failed while another build changed prompt output; exact-file retry passed. Serial full rerun is still required. |
| Canonical install + verify | Final install + verify at `6953b993fe` completed with exit 0 (`refactor-delivery-verify.log` and `.exit`). Earlier observation ambiguity is resolved. |
| Generated source leakage | Final post-build source-artifact audit pending; authored declarations must not be removed as compiler leakage. |
| Desktop/mobile | Current walkthrough capture/review in progress; mock-backed UI evidence and real native startup must be labeled separately. |
| Develop and hosted workflows | PR/merge, exact merged SHA checks and applicable workflow results remain pending. Local green is not hosted verification. |
| Requested checkout | Combined candidate is in `v3-refactor-rebase`; synchronize into `~/v3` while preserving the user's untracked WORKFLOW_SIMPLIFICATION_PLAN.md. No stash/reset of another task's work. |

Completion requires final evidence for these gates, the residual-complexity
review, and the requested develop delivery. Update this ledger with terminal
results rather than appending another contradictory checkpoint narrative.
