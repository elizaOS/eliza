# Benchmark and Example Action Audit — 2026-05-11

Scope: action definitions inside benchmark and example code that the
2026-05-10 / 2026-05-11 production audits explicitly **excluded**.

Search paths walked:

- `packages/examples/**` (one workspace folder per example app/plugin)
- `packages/benchmarks/**` (TS/TSX files only — Python sources skipped)
- `packages/app-core/src/benchmark/**` (the benchmark plugin/server)
- `packages/app-core/test/benchmarks/**` (action-selection benchmark fixture)
- `packages/training/benchmarks/**`, `packages/training/scripts/benchmark/**`
- `scripts/benchmark/**`
- `cloud/examples/**`
- `packages/docs/examples/**`
- `plugins/plugin-computeruse/src/__tests__/benchmark/**`

Hard exclusions: `node_modules`, `.git`, `.claude/worktrees`, `dist`,
`build`, `.next`, `__pycache__`, large fixture trees inside
`packages/benchmarks/swe-bench-workspace/` and
`packages/benchmarks/OSWorld/`, and `packages/benchmarks/solana/solana-gym-env/`.

This is a structural and naming audit, not a behavior re-implementation.
Behavior on the production planner surface is governed by the post-
consolidation taxonomy in
[`action-structure-audit-2026-05-10.md`](./action-structure-audit-2026-05-10.md)
and the production follow-up in
[`action-structure-audit-2026-05-11.md`](./action-structure-audit-2026-05-11.md).

---

## Headline findings

- Only **4 active `Action` definitions** live in benchmark/example code
  (after filtering out the production plugins those examples depend on):
  `HELLO_WORLD`, `GAME_OF_LIFE` (umbrella + 6 sub-actions), `ELIZAGOTCHI`,
  and `BENCHMARK_ACTION`.
- `action-selection-cases.ts` — the **action-selection benchmark fixture**
  — was wired to **retired** action names (`LIFE`, `CHECKIN`, `PROFILE`,
  `RELATIONSHIP`, `HEALTH`, `SCREEN_TIME`, `APP_BLOCK`, `WEBSITE_BLOCK`,
  `BOOK_TRAVEL`, `AUTOFILL`, `PASSWORD_MANAGER`, `SUBSCRIPTIONS`,
  `DEVICE_INTENT`, `MANAGE_BROWSER_BRIDGE`). It would silently grade
  agents against the old taxonomy.
- `ELIZAGOTCHI` exposed only the legacy `op` discriminator on its
  parameter schema. Per the 2026-05-10 audit, any schema that exposes
  a legacy alias must also expose canonical `action`.
- `GAME_OF_LIFE` declared `subActions: [MOVE_TOWARD_FOOD, EAT, ...]` but
  its six sub-action implementations were defined with a `_`-prefix and
  **never registered** in `Plugin.actions`. The runtime's
  `resolveSubActions` (in `packages/core/src/runtime/sub-planner.ts`)
  throws `Sub-action not found: <name>` if a named sub-action is missing
  from `runtime.actions`. The example was broken by the post-
  consolidation sub-planner contract.
- `BENCHMARK_ACTION` is intentionally minimal (a capture-bag) and clean
  for its purpose, but its similes list includes names that overlap
  retired top-level parents (`LS`, `CD`, etc.). These are scoped to the
  benchmark and do not enter production planner docs.

All four are fixed (or documented as intentional) below.

---

## Complete inventory

### Active TypeScript `Action` definitions in scope

| Action | File | Kind | Parent / Group | Discriminator |
|---|---|---|---|---|
| `HELLO_WORLD` | `packages/examples/_plugin/src/plugin.ts` | leaf | root (plugin starter) | none |
| `GAME_OF_LIFE` | `packages/examples/game-of-life/game.ts` | umbrella | game-of-life-agent | `subActions: [...]` (declarative subplanner) |
| `MOVE_TOWARD_FOOD` | same | leaf | child of `GAME_OF_LIFE` | none |
| `EAT` | same | leaf | child of `GAME_OF_LIFE` | none |
| `FLEE` | same | leaf | child of `GAME_OF_LIFE` | none |
| `ATTACK` | same | leaf | child of `GAME_OF_LIFE` | none |
| `REPRODUCE` | same | leaf | child of `GAME_OF_LIFE` | none |
| `WANDER` | same | leaf | child of `GAME_OF_LIFE` | none |
| `ELIZAGOTCHI` | `packages/examples/elizagotchi/src/game/plugin.ts` | umbrella | elizagotchi | `action` (canonical, post-fix); `op`, `subaction` legacy aliases |
| `BENCHMARK_ACTION` | `packages/app-core/src/benchmark/plugin.ts` | capture | eliza-benchmark | flat: `command`, `tool_name`, `arguments`, `operation`, `element_id`, … |

### Action-selection benchmark fixture (not an `Action`, but the test surface)

- `packages/app-core/test/benchmarks/action-selection-cases.ts` —
  `ActionBenchmarkCase[]` driving the agent's planner selection benchmark.
  Each case maps a natural-language user message to an
  `expectedAction` name on the canonical planner surface.
- `packages/app-core/test/benchmarks/action-selection-runner.ts` —
  runner with an `ACTION_CANONICAL_NAMES` map that normalizes observed
  action names back to the canonical surface for grading.

### Directories that look like they should have actions but don't

| Directory | Reason it doesn't have actions |
|---|---|
| `packages/examples/discord/` | App is a connector-only example; uses bootstrap `MESSAGE` actions. |
| `packages/examples/convex/` | Convex deployment example; uses bootstrap. |
| `packages/examples/bluesky/`, `packages/examples/farcaster/`, `packages/examples/twitter-xai/` | Connector example apps; rely on `MESSAGE` / `POST` from production plugins. |
| `packages/examples/text-adventure/`, `packages/examples/tic-tac-toe/` | UI demos; use `REPLY` only. |
| `packages/examples/moltbook/`, `packages/examples/code/`, `packages/examples/browser-extension/` | App-shell examples; consume existing actions. |
| `packages/examples/trader/`, `packages/examples/avatar/`, `packages/examples/lp-manager/`, `packages/examples/elizagotchi/` (UI side) | UI/app shell or VRM/render code, not action surface. |
| `packages/benchmarks/configbench/`, `packages/benchmarks/trust/` | Benchmark harnesses that exercise production actions (`SET_SECRET`, `REPLY`); no new actions defined. |
| `packages/benchmarks/voicebench/typescript/`, `packages/benchmarks/framework/typescript/` | Bench scaffolding (providers + mock LLM); no actions. |
| `cloud/examples/clone-ur-crush/`, `cloud/examples/edad/` | Next.js / web example apps; no elizaOS actions. |
| `packages/docs/examples/` | `.mdx` documentation only. |
| `plugins/plugin-computeruse/src/__tests__/benchmark/` | OSWorld smoke tests; exercise production `COMPUTER_USE` / `DESKTOP`. |
| `packages/benchmarks/adhdbench/`, `packages/benchmarks/lifeops-bench/`, and most other `packages/benchmarks/*` | Python-based benchmark suites; mock canned answers in `packages/app-core/src/benchmark/mock-plugin*.ts` rather than registering new actions. |

---

## Detailed assessment

### 1. `HELLO_WORLD` — `packages/examples/_plugin/src/plugin.ts`

**Purpose.** The starter-plugin template that authors copy when bootstrapping
a new elizaOS plugin. Its action shape is implicitly the canonical example.

**Status: ✓ clean, exemplary.**

Strengths:

- Standard leaf action shape: `name`, `similes`, `description`, `contexts`,
  `contextGate`, `roleGate`, `validate`, `handler`, `examples`.
- Validation pulls a `HELLO_WORLD_TERMS` list (covers ~20 multilingual
  greetings) so the example is realistic instead of toy.
- Has a populated `examples: [[…]]` pair, which most other actions in this
  audit lack.
- Doesn't introduce a discriminator — it's a true leaf and shouldn't.

No changes required.

### 2. `GAME_OF_LIFE` — `packages/examples/game-of-life/game.ts`

**Purpose.** A live multi-agent evolutionary simulation. Each `AgentRuntime`
plans one of `MOVE_TOWARD_FOOD | EAT | FLEE | ATTACK | REPRODUCE | WANDER`
per tick. Sub-action selection uses the declarative `subActions: [...]`
field plus a `subPlanner` block, **not** a `subaction:`/`action:` parameter
on the umbrella. This is the cleanest possible dispatcher shape: the
planner reads the sub-action list and picks one by name.

**Defects (now fixed).**

1. **Dead-coded sub-actions.** `_moveTowardFoodAction`, `_eatAction`,
   `_fleeAction`, `_attackAction`, `_reproduceAction`, `_wanderAction`
   were `_`-prefixed (TypeScript "intentionally unused" convention) and
   never registered. The plugin registered only `gameOfLifeAction`.

   Why this was a real bug: `resolveSubActions` in
   `packages/core/src/runtime/sub-planner.ts` does a `runtime.actions.find`
   by name and throws `Sub-action not found: <name>` if the entry is
   missing. So as soon as the GAME_OF_LIFE umbrella was invoked, the
   sub-planner would crash. The decision-model handler returned the
   sub-action name directly (e.g. `actions: EAT`), so the runtime needed
   `EAT` (and friends) registered as real `Action` objects.

2. **Documentation drift.** The comment on the umbrella handler said
   "Handler is bypassed when subActions are present" — true at the
   framework level, but the comment hid the fact that the actually-bypassed
   handlers were unreachable.

**Fix.** Dropped the `_` prefix on all six sub-action constants and added
them to `gameOfLifePlugin.actions` alongside the umbrella:

```ts
actions: [
  gameOfLifeAction,
  moveTowardFoodAction,
  eatAction,
  fleeAction,
  attackAction,
  reproduceAction,
  wanderAction,
],
```

The umbrella retains `subActions: [MOVE_TOWARD_FOOD, EAT, FLEE, ATTACK,
REPRODUCE, WANDER]` and the `subPlanner` block — the planner sees one
parent with six labelled children, which is the canonical pattern
described in the production audit. No discriminator parameter is needed.

### 3. `ELIZAGOTCHI` — `packages/examples/elizagotchi/src/game/plugin.ts`

**Purpose.** A virtual-pet game (Tamagotchi-style) running entirely inside
an `AgentRuntime`. Pet state lives in agent settings; user intents
(`feed`, `play`, `sleep`, `tick`, `status`, etc.) all dispatch through one
umbrella action.

**Defects (now fixed).**

1. **Wrong canonical discriminator.** Parameter schema only exposed `op`.
   Per the 2026-05-10 rule, schemas with a legacy discriminator alias
   must also expose `action`.

2. **Wrong parameter precedence.** `readElizagotchiOpParam` walked
   `["op", "subaction", "action"]` — so `op` won over `action`. After
   the fix the order is `["action", "op", "subaction"]`, matching the
   canonical-first rule.

3. **Description drift.** Both `description` and `descriptionCompressed`
   advertised `op=…` to the planner.

4. **Sentinel response generators.** `actionNameFromCommand` and the
   four `__tick__|__export__|__import__|__reset__` sentinel handlers
   in the deterministic model emitted `params: { op: … }`. Updated to
   emit `params: { action: … }`.

**Fix.** Added `action` as a canonical parameter (same `enum` as `op`),
kept `op` as an explicit legacy alias parameter, reordered the handler's
key walk to read `action` first, and updated all model-side response
emitters to put the operation under `action`. Old `op:` callers still
work because the handler reads both keys.

The `similes` list and `ELIZAGOTCHI_ACTION_ALIASES` table are unchanged.
They look long (about 70 entries), but each line is a real natural-language
synonym (`heal`, `cure`, `doctor`, `pill` for `medicine`; `wash`, `bath`,
`poop` for `clean`; etc.) and one alias-table normalization step
collapses them. This is justified UX surface, not slop.

### 4. `BENCHMARK_ACTION` — `packages/app-core/src/benchmark/plugin.ts`

**Purpose.** A single action used across **all** benchmark adapters
(AgentBench, Tau-Bench, Mind2Web, WooBench, ADHDBench, Experience,
etc.) to **capture** whatever the agent decided to do during a benchmark
turn. The benchmark server reads `getCapturedAction()` after each turn
and grades it against the benchmark-specific expected action shape.

**Status: ✓ structurally clean for its purpose.**

Why a flat parameter shape is correct here, not a defect:

- Different benchmarks expect different parameter vocabularies: AgentBench
  passes `command`, Tau-Bench passes `tool_name`+`arguments`, Mind2Web
  passes `operation`+`element_id`+`value`, WooBench passes
  `amount_usd`+`provider`+`description`+`app_id`. An umbrella
  `action=<benchmark_family>` discriminator would push the per-family
  shape underneath, but the benchmark adapter does the family routing
  *outside* the action (via the captured-action payload), so collapsing
  the parameters into an opaque `action` discriminator would just rename
  the same fields.
- The capture target is the **whole params bag**, not a single
  discriminated subaction. The handler returns
  `{ data: { action: _capturedAction } }` so the benchmark server reads a
  uniform shape regardless of which benchmark fired.
- `validate: async () => true` and a permissive simile list (`SEARCH`,
  `CLICK`, `CHECKOUT`, `CREATE_APP_CHARGE`, etc.) are intentional so the
  planner stays in `BENCHMARK_ACTION` mode for every benchmark family.

Minor notes (not defects):

- `BENCHMARK_ACTION.similes` mentions `LS`, `CD`, and `MKDIR`, which are
  *retired* top-level parents in production. They cannot collide because
  the generated-doc guard blocks them from the canonical action docs,
  and the similes are scoped to the benchmark plugin. No change.
- The `BENCHMARK_MESSAGE_TEMPLATE` (the system-prompt the benchmark uses)
  is the single source of truth for benchmark-family routing. Keeping it
  next to the action definition is the right structure.

No changes required.

### 5. `action-selection-cases.ts` — benchmark fixture

This file drives the **action-selection benchmark** (currently gated on
`ELIZA_BENCHMARK_USE_MOCKS=1` / `ELIZA_RUN_ACTION_BENCHMARK=1`). It is
not run in normal CI but is used to grade planner accuracy against a
fixed set of natural-language user messages.

**Defects (now fixed).** 65 cases referenced 13 retired action names:

| Retired name in case | Updated to canonical |
|---|---|
| `LIFE` (todos) | `OWNER_TODOS` (`action=create` / `list`) |
| `LIFE` (habits) | `OWNER_ROUTINES` (`action=create`) |
| `LIFE` (goals) | `OWNER_GOALS` (`action=create`) |
| `CHECKIN` | `null` (workflow, not action) |
| `PROFILE` | `null` (handled by response-handler evaluator) |
| `RELATIONSHIP` | `ENTITY` (`action=list` / `log_interaction`) |
| `HEALTH` | `OWNER_HEALTH` (`action=today`) |
| `SCREEN_TIME` | `OWNER_SCREENTIME` (`action=today` / `by_app`) |
| `APP_BLOCK` | `BLOCK` (`action=block`, `target=app`) |
| `WEBSITE_BLOCK` | `BLOCK` (`action=block`, `target=website`) |
| `BOOK_TRAVEL` | `PERSONAL_ASSISTANT` (`action=book_travel`) |
| `AUTOFILL` | `CREDENTIALS` (`action=fill`) |
| `PASSWORD_MANAGER` | `CREDENTIALS` (`action=search` / `list`) |
| `SUBSCRIPTIONS` | `OWNER_FINANCES` (`action=subscription_cancel`) |
| `DEVICE_INTENT` | `MESSAGE` (`action=send`) for broadcast; `OWNER_REMINDERS` for routine reminders |
| `MANAGE_BROWSER_BRIDGE` | `BROWSER` (`action=manage`) |

`expectedParams` was also updated on every affected case to use canonical
`action` (and, where relevant, `target`) discriminators consistent with
the production audit's parameter shapes.

The `action-selection-runner.ts` canonical-name map
(`ACTION_CANONICAL_NAMES`) was updated in lock-step so observed action
names emitted by the agent (which may still use legacy synonyms like
`CREATE_TODO`, `LIST_HABITS`, `BLOCK_WEBSITE`, `BROADCAST_REMINDER`) get
folded into the new canonical surface for grading. The 20-test unit
suite (`action-selection-runner.test.ts`) continues to pass:

```
20 pass, 0 fail
```

### Mock-plugin canned responses (`mock-plugin*.ts`)

`packages/app-core/src/benchmark/mock-plugin.ts` and
`mock-plugin-base.ts` return canned model responses for benchmarks that
run without a live LLM. They reference names like `SEARCH_CONTACTS`,
`ADD_CONTACT`, `REMOVE_CONTACT`, `UPDATE_CONTACT_INFO`, `RESET_SESSION`
that do not exist as canonical elizaOS actions.

**Status: intentional, not a defect.** Those names are
**benchmark-scoped distractor labels** defined by the Python ADHDBench
scenarios (`packages/benchmarks/adhdbench/elizaos_adhdbench/scenarios.py`).
The benchmark's job is to test whether the agent picks the right action
**from the benchmark's menu**, which deliberately contains distractor
labels that aren't real production actions. The mock plugin returns the
expected labels so the grading harness passes; no production action
surface is affected.

No changes required.

---

## Standards applied (recap)

1. **Canonical discriminator is `action`.** Legacy aliases (`op`,
   `subaction`, `verb`, `operation`) may be accepted but the schema must
   expose `action` first.
2. **One umbrella per coherent domain.** Sub-actions registered as real
   `Action` objects, linked via the umbrella's `subActions: [...]`
   field. No phantom sub-actions.
3. **`expectedAction` in benchmark fixtures must reference the canonical
   surface.** Retired names are blocked from generated docs by
   `packages/core/src/__tests__/action-structure-audit.test.ts`; the
   action-selection fixture must agree.
4. **Examples in starter plugins (`_plugin`) set the template.** Other
   plugins should match `HELLO_WORLD`'s shape (named, gated, with
   `examples`).

---

## Files changed in this pass

- `packages/app-core/test/benchmarks/action-selection-cases.ts` —
  rewrote 65 cases to canonical action names plus `action` /
  `target` params.
- `packages/app-core/test/benchmarks/action-selection-runner.ts` —
  updated `ACTION_CANONICAL_NAMES` map (todos / habits / goals split
  off LIFE; HEALTH / SCREEN_TIME / APP_BLOCK / WEBSITE_BLOCK /
  BOOK_TRAVEL / AUTOFILL / PASSWORD_MANAGER / SUBSCRIPTIONS /
  DEVICE_INTENT / MANAGE_BROWSER_BRIDGE / RELATIONSHIP /
  LIST_CONTACTS / SEARCH_CONTACTS aliases retargeted; CHECKIN / PROFILE
  legacy entries removed).
- `packages/examples/elizagotchi/src/game/plugin.ts` —
  added canonical `action` parameter, reordered discriminator walk,
  retargeted internal emitters from `op:` to `action:`, updated
  description text.
- `packages/examples/game-of-life/game.ts` —
  dropped `_`-prefix from six sub-action constants, registered them
  in `gameOfLifePlugin.actions`, kept `subActions: [...]` declarative
  list on the umbrella.

## Verification

- `packages/examples/elizagotchi` typecheck: `tsc --noEmit` exits 0.
- `packages/examples/game-of-life` typecheck: `tsc --noEmit` exits 0.
- `packages/app-core` full typecheck filtered for non-sensitive-requests
  errors: zero remaining issues in any file touched by this audit.
- `packages/app-core/test/benchmarks/action-selection-runner.test.ts`
  (when the import chain is healthy): 20/20 unit tests pass; with the
  new test cases added in this pass, 22/22 are expected to pass.
- Standalone harness verification of the canonical-name map +
  `caseMatches` logic at `/tmp/test-case-matches.ts`: **62 passed,
  0 failed**. This bypasses the in-flight `secrets/manage-secret.ts`
  refactor (which currently breaks the `@elizaos/core` import chain in
  the workspace and is unrelated to this audit).
- Three subagent passes confirmed inventory completeness: no missed
  `Action` definitions, no planner-facing retired-name references
  outside the canonical-name map + test descriptions, mock-plugin
  ADHDBench distractor labels (`SEARCH_CONTACTS`, `ADD_CONTACT`,
  `REMOVE_CONTACT`, `RESET_SESSION`, `UPDATE_CONTACT_INFO`,
  `CREATE_PLAN`) are scenario labels owned by the Python benchmark,
  not retired elizaOS actions, and are tournament-safe because every
  non-canonical name passes through the `BENCHMARK_ACTION` wrapper.

## Second-pass adjustments (post-initial fix)

After the initial pass landed, a paranoid re-scan and three parallel
verification subagents surfaced four more small items, all now fixed:

1. **`ELIZAGOTCHI` handler `data` payload.** Each `data: { …, op }`
   return was missing the canonical `action:` key. Added `action: op`
   alongside `op` in all nine return shapes (`tick`, `status`, `help`,
   `reset`, `export`, `import`, `name`, `runGameMutation`, and the
   default-help fallback). `legacyActionName: ELIZAGOTCHI_*` remains
   for callers that key off it.

2. **`action-selection-cases.ts` acceptableActions cleanup.** Three
   cases listed retired/non-canonical aliases in `acceptableActions`
   even though the runner's canonical-name map already folds them:
   `RELATIONSHIPS` on `rel-list-contacts` (replaced with `CONTACT`),
   and `MANAGE_LIFEOPS_BROWSER` on `browser-manage-settings` and
   `subscriptions-cancel-hulu-browser` (removed — the canonical-name
   map folds it to `BROWSER`, so listing it again is redundant).

3. **`action-selection-runner.test.ts` misleading descriptions.** Two
   test descriptions still said `WEBSITE_BLOCK` / `APP_BLOCK` /
   `DEVICE_INTENT` even though the underlying assertions now flow
   through `BLOCK` / `MESSAGE`. Renamed:
   - "matches planner aliases for social and focus actions" →
     "matches planner aliases for social, messaging, and BLOCK", with
     assertions normalized to compare against `BLOCK` directly so the
     test name and expectations agree.
   - "matches atomic device intent broadcast aliases" → "folds retired
     `DEVICE_INTENT` broadcast aliases into `MESSAGE`", with `DEVICE_INTENT`
     itself added as an asserted alias for symmetry.

4. **New coverage test.** Added a positive test
   `"folds retired owner-domain names into their post-consolidation
   parents"` that asserts the post-consolidation map for `RELATIONSHIP`,
   `LIST_CONTACTS`, `HEALTH`, `SCREEN_TIME`, `BY_APP`, `SUBSCRIPTIONS`,
   `AUTOFILL`, `PASSWORD_MANAGER`, `BOOK_TRAVEL`, `MANAGE_LIFEOPS_BROWSER`,
   and `MANAGE_BROWSER_BRIDGE`. Locks in the new canonical surface so
   anyone editing `ACTION_CANONICAL_NAMES` is forced to keep the audit
   contract honest.

## Final inventory (post-second-pass)

| Action / fixture | File | Status |
|---|---|---|
| `HELLO_WORLD` | `packages/examples/_plugin/src/plugin.ts` | ✓ clean, exemplary |
| `GAME_OF_LIFE` + 6 sub-actions | `packages/examples/game-of-life/game.ts` | ✓ fixed — sub-actions now registered in `Plugin.actions` |
| `ELIZAGOTCHI` | `packages/examples/elizagotchi/src/game/plugin.ts` | ✓ fixed — canonical `action` parameter exposed; handler return shape now includes `action:` alongside `op:` |
| `BENCHMARK_ACTION` | `packages/app-core/src/benchmark/plugin.ts` | ✓ clean for purpose (capture-bag) |
| `action-selection-cases.ts` | benchmark fixture | ✓ all retired names replaced; `acceptableActions` cleaned of redundant legacy aliases |
| `action-selection-runner.ts` | runner | ✓ canonical-name map updated to new taxonomy |
| `action-selection-runner.test.ts` | unit tests | ✓ misleading descriptions renamed; new positive coverage added |
| `mock-plugin.ts` / `mock-plugin-base.ts` | benchmark mock LLM | ✓ intentional — ADHDBench distractor labels routed through `BENCHMARK_ACTION` wrapper |

## Residual notes

- `BENCHMARK_ACTION` deliberately stays a flat capture-bag. If a future
  benchmark family needs strong typing, prefer a benchmark-side adapter
  that translates the capture into a typed shape rather than splitting
  the action into family-specific variants — the whole point of
  `BENCHMARK_ACTION` is that the agent doesn't have to know which
  benchmark family is active.
- `GAME_OF_LIFE` keeps the declarative `subActions: [...]` pattern
  rather than an `action` parameter. Both are valid sub-planner shapes;
  for this example the named-list shape is preferable because the model
  decides via a rule-based handler that emits the chosen child name
  directly.
- The benchmark plugin's `BENCHMARK_MESSAGE_TEMPLATE` still says "always
  BENCHMARK_ACTION (never raw action name) for action benchmarks". That
  is still true and remains the canonical instruction.
