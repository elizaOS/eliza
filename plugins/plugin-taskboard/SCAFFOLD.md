# Scaffold instructions for coding agents — plugin-taskboard

You (a coding agent) are responsible for turning this directory from a **design
plan** (`README.md`) into a working elizaOS plugin. **Read `README.md` in full
first** — it is the authoritative design and cites every runtime primitive
(file:line) you will build against. This file is the build contract; do not
start until the plan is reviewed and Phase-0 rooms QA (README §9) has run.

## 0. Prerequisite — the one upstream change

Before Phase 1, land the `plugin-github` extension the plan requires (README
§3.1): add a typed `graphql<T>(query: string, vars: Record<string, unknown>):
Promise<T>` method to `GitHubService`
(`plugins/plugin-github/src/services/github-service.ts`) and to the
`IGitHubService` contract (`plugins/plugin-github/src/types.ts:143`). Projects v2
writes are GraphQL-only; this keeps the "one GitHub client" invariant instead of
forking a second Octokit. Ship it as its own PR with its own tests. Do **not**
add a second GitHub client anywhere in `plugin-taskboard`.

## 1. Package metadata

Fill in `package.json`:
- `name`: `@elizaos/plugin-taskboard`.
- One factual `description` sentence.
- `elizaos.plugin.category`: `dev-tools`.
- `dependencies`: `@elizaos/core`, `@elizaos/plugin-github`,
  `@elizaos/plugin-scheduling`, `@elizaos/plugin-sql` (workspace `*`).
- No dependency on `@elizaos/app-core` or `@elizaos/agent` (README §1 boundary —
  it breaks the mobile bundle; `@elizaos/plugin-scheduling`'s `CLAUDE.md`
  documents the same rule).

## 2. Build the surface (README §2–§5), in phase order

Phase 1 (skeleton):
- `src/types.ts` — `WorkboardColumn`, `WorkboardBinding`,
  `TaskboardCardComponentData`, action option types, `GitHubActionResult`-shaped
  results. Strong types only.
- `src/services/taskboard-service.ts` — `TaskboardService` (`serviceType
  "taskboard"`). Composes `GitHubService.getOctokit(...)` + the new
  `graphql<T>()`; owns create/adopt board, resolve `WorkboardBinding` from a
  room's `World.metadata`, read/mutate cards (Projects v2
  `updateProjectV2ItemFieldValue`), maintain the card `Component` cache,
  regenerate the tracking-issue body (preserve the `## Notes` section),
  reconcile.
- `src/actions/` — one file per verb: `create-workboard.ts`, `claim-task.ts`,
  `start-task.ts`, `update-task.ts`, `needs-verify-task.ts`, `done-task.ts`,
  `read-board.ts`. Each is a distinct `Action` with `name`, `contexts`,
  `contextGate`, `roleGate` (README §4.1 table), `validate`, `handler`. **No
  `moveCard(to)` polymorphism** (Clean-Architecture rule 5). Write ops use
  `requireConfirmation` from `@elizaos/core` where the table says so.
- `src/providers/workboard-state.ts` — `WORKBOARD_STATE` provider, three-state
  render (loading / empty / error). Never render empty-from-error.
- `src/routes/webhook.ts` — `POST /api/taskboard/webhook` raw `http` handler
  (pattern: `plugins/plugin-github/src/index.ts:65`), signature-verified.
- `src/index.ts` — the `Plugin` barrel: wiring only (services, actions,
  providers, routes, `init`, `dispose`). No business logic in the barrel.

Phase 2 (loop + mirror):
- Register the structural goal-loop `ScheduledTask` via
  `@elizaos/plugin-scheduling`'s `registerDefaultTaskPack` (README §5). Register
  its `shouldFire` gate + `completionCheck` in the spine's `TaskGateRegistry` /
  `CompletionCheckRegistry`. **Do NOT** pattern-match `promptInstructions` text
  and **do NOT** stand up a second scheduler.
- The batched tracking-issue mirror + the evidence gate (README §3.2/§4.1).

Phase 3/4: MCP port + Codex/Claude skill, then the `packages/app` Workboards
view (README §6/§7). Views set `viewKind: "release"`.

## 3. Architecture rules (binding — from root `AGENTS.md`)

- Logger only (`logger` from `@elizaos/core`, prefix `[TaskboardService]` /
  `[ClassName]`), never `console.*`.
- No fabricated defaults. A failed GitHub read **throws** / surfaces
  `{ success: false, error }` / calls `runtime.reportError`; it never returns an
  empty board via `?? []`. "Not loaded" ≠ "empty".
- Kept `try/catch` carries a `// error-policy:J<N> <reason>` annotation
  (root `CLAUDE.md` Error-Handling doctrine). The webhook boundary is J1; a
  telemetry write in the loop is J7.
- Strong types only: no `any`, no `unknown` without a validating boundary, no
  `as` escapes, no `?? defaultValue` for missing required data.
- One canonical codepath per behavior: board→room via webhook OR poll is **one**
  reconcile implementation with two triggers, not two.

## 4. Tests (real, not larp — `PR_EVIDENCE.md`)

- Live GitHub App round-trip against a sandbox org/repo: `CREATE_WORKBOARD` →
  real Projects v2 board + tracking issue; `CLAIM/START/NEEDS_VERIFY/DONE`
  moving a real card through the Status field; the tracking-issue comment
  mirror. Assert the **outcome** on GitHub, not just that an action was routed.
- A **live-LLM** scenario trajectory of an agent reading `WORKBOARD_STATE`,
  claiming a card, working it, and requesting verify —
  `packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`.
- Error/edge/permission paths: no-evidence `NEEDS_VERIFY`/`DONE` rejection,
  double-claim rejection, rate-limit surfacing, a non-owner denied `DONE_TASK`
  by `roleGate`, GitHub-down `reportError`.
- Keep at least one passing test per real action. A test asserting against a
  mocked Octokit standing in for the thing under test does **not** count for the
  round-trip claim (a narrow structural mock for unit-level branch coverage is
  fine, but the E2E must hit real GitHub).

## 5. Verify before signaling done

From `plugins/plugin-taskboard`:
```bash
bun run typecheck
bun run lint
bun run test
```
All three exit zero. Do not silence with `any`, `@ts-ignore`, broad `try/catch`,
or `?? default`. For any `packages/app` view, also run the app visual-review loop
(`bun run --cwd packages/app audit:app`) until every touched page is `good`.

## 6. Rules recap

- Actions/providers/services in their own files; the barrel is wiring only.
- No business logic in the barrel.
- Logger over `console.*`.
- Strong types only; one canonical codepath; no fabricated defaults.
- One scheduler (the spine), one GitHub client (composed), one board source of
  truth.
