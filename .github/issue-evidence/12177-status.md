# Issue #12177 — automation nomenclature: implementation status & evidence

Branch: `fix/12177-automation-nomenclature` (off `develop` @ `03dbd8c501e`).

## What was implemented (per work item)

### WI-1 — glossary + stale-doc fix
- New `docs/automation-glossary.md`: Decision-1 canonical glossary, the
  one-clock/two-consumers ASCII diagram, the "every meaning of task" table, and
  the who-fires-what route map. Added a `docs/*` gitignore negation so it tracks.
- Fixed the stale LifeOps runner path in root `CLAUDE.md` + `AGENTS.md` (kept
  byte-identical per repo rule) → `plugins/plugin-scheduling/src/scheduled-task/runner.ts`,
  with a glossary cross-link.
- Cross-linked the glossary from `plugin-workflow`, `plugin-scheduling`, and
  `plugin-agent-orchestrator` READMEs (added the "coding task" qualifier note).
- **DoD:** `grep -rn "plugin-personal-assistant/src/lifeops/scheduled-task/runner" --include='*.md' .` → empty (exit 1). Route-map claims spot-verified against real handlers.

### WI-2 — retire the `/api/heartbeats` alias + "Heartbeat" UI vocabulary
- Removed `normalizeTriggerPath` + the dual `{triggers,heartbeats}` response keys
  in `plugins/plugin-workflow/src/trigger-routes.ts`; dropped the `/api/heartbeats`
  mount in `packages/agent/src/api/server.ts` (now 404s). Fixed the ELIZA overview
  knowledge text that called triggers "heartbeats".
- Renamed UI: `HeartbeatForm→TriggerForm`, `HeartbeatsView→TriggersView`
  (+ Desktop shell), `heartbeat-utils→trigger-form-utils`, and every
  trigger-meaning symbol / element-id / testid / label / i18n key
  (`heartbeatform.*→triggerform.*`, `heartbeatsview.*→triggersview.*`,
  `nav.heartbeats→nav.triggers`, `common.heartbeat→common.trigger`) across all 8
  locales. **Connector keep-alive `heartbeat` task tags left untouched** (correct).
- **Test:** `plugins/plugin-workflow/__tests__/unit/routes/trigger-routes.test.ts`
  asserts `/api/heartbeats` 404s (handler returns false) and `/api/triggers`
  works with only the `triggers` key.

### WI-3 — `TriggerKind = "workflow" | "prompt"` + workbench schedule migration
- Core `TriggerConfig` is now a strict discriminated union
  (`WorkflowTriggerConfig | PromptTriggerConfig`): `workflowId` exists only for
  kind `"workflow"`. Verified with isolated tsc (positive compile + negative
  "reading workflowId unguarded errors").
- Trigger runtime dispatches kind `"prompt"` by injecting the trigger's
  `instructions` as an agent turn via `runtime.messageService.handleMessage`
  (prompt automation), keeping `WORKFLOW_DISPATCH` for kind `"workflow"`.
- `parseTriggerKind(Strict)` + `POST/PUT /api/triggers` accept `"prompt"`.
  Both `POST` and `PUT` require `instructions` when the resulting kind is
  `"prompt"` and forbid `workflowId` for prompt kind. (Review fix #1: the `PUT`
  handler now guards `instructions` when switching a non-prompt trigger to
  `"prompt"`, so it no longer silently reuses the old workflow trigger's
  synthesized "Run workflow …" text; a same-kind prompt→prompt update may fall
  back to its own current instructions.)
- One-time boot migration (`packages/agent/src/triggers/workbench-migration.ts`,
  wired in `eliza-plugin` init) folds legacy `schedule:<cron>` / `event:<name>`
  tag-encoded workbench tasks into a prompt-kind `TriggerConfig` on
  `metadata.trigger`, retagged as `TRIGGER_DISPATCH`. Idempotent.
- UI: deleted `task-schedule.ts` (the third schedule encoding); `TaskEditor`
  creates prompt triggers via `client.createTrigger`; `AutomationsFeed` reads
  schedule from `metadata.trigger`, not tags. Local `TriggerKind` extended.
- **Tests:** prompt dispatch + invalid-kind skip (runtime.test.ts, 19 pass);
  migration decode/rewrite/idempotency (workbench-migration.test.ts, 6 pass);
  kind parsing on POST /api/triggers (trigger-routes.test.ts, 7 pass).

### WI-4 — deduplicate plugin-workflow CRUD routes
- Removed the parallel plugin-relative `/workflows*` CRUD (`routes/workflows.ts`)
  + its direct unit test; the canonical rawPath `/api/workflow/*`
  (`routes/workflow-routes.ts`) is unchanged (the UI + cloud-proxy contract).
  Trimmed the duplicate `/workflows` cases from the route e2e, repointing the
  auth-gate/404 cases at a surviving relative route.
- **DoD:** one CRUD implementation; `bun test .../integration/routes-e2e.test.ts`
  → 5 pass; `.../unit/routes/` → 36 pass.

### WI-5 — one UI vocabulary
- Renamed `components/chat/widgets/workflows.tsx → automations.tsx` exporting
  `AutomationsWidget` (label "Tasks"→"Automations", testid
  `chat-widget-workflows→chat-widget-automations`); updated `widgets/registry.ts`
  + the widget test.
- Nav description "Scheduled tasks and recurring workflows" → "Workflows,
  triggers, and scheduled items".
- `AutomationsFeed` + `automation-feed-filter.ts`: filter `tasks` → `prompts`
  (label "Tasks"→"Prompts"); updated the filter unit test.
- i18n copy aligned to the glossary across 8 locales (`filterTasks→filterPrompts`,
  "Create task or workflow"→"Create automation", "New Task"/"New Text Task"→"New
  prompt automation", coordinator filter→"Prompts").

### WI-6 — integration proof of both DoD paths (no live model)
- `plugins/plugin-workflow/__tests__/integration/trigger-dispatch-e2e.test.ts`
  drives the real path with real persistence (PGlite) and the real Smithers
  engine:
  - **(a)** scheduled workflow → real `TaskService.runDueTasks()` tick →
    real trigger worker → `WORKFLOW_DISPATCH` → row in
    `workflow.embedded_executions` + a `TriggerRunRecord`.
  - **(b)** `WORKFLOW_DISPATCH` service runs a workflow by id headlessly.
  - **(c)** one core `TaskService` clock drives a trigger task AND a
    `LIFEOPS_SCHEDULER`-tagged task on the same tick (one clock, two consumers).
  - **(d)** disabled trigger skips; enabled fires; `maxRuns` deletes the task.
  - 4 tests green.

## Test results (real output, this environment)

```
packages/agent/src/triggers/ (runtime + migration) ......... 25 pass  0 fail
plugins/plugin-workflow/__tests__/unit (full) .............. 322 pass 0 fail
plugins/plugin-workflow/__tests__/integration .............. 25 pass  0 fail (routes-e2e)
plugins/plugin-workflow/.../trigger-dispatch-e2e.test.ts ... 4 pass   0 fail
plugins/plugin-workflow/.../unit/routes/trigger-routes ..... 7 pass   0 fail
packages/core/src/services/triggerScheduling + __tests__ ... 33 pass  0 fail
packages/ui automation-feed-filter + automations widget .... 13 pass  0 fail (vitest lane)
```

## Verification note (worktree topology)

Whole-repo `tsgo` typecheck cannot pass **in this worktree**: it shares the
parent repo's `node_modules/@elizaos/core` symlink, whose built
`dist/types/trigger.d.ts` still declares the old `TriggerKind = "workflow"`.
Consumers (e.g. `plugin-workflow` typecheck) therefore see stale types and
report false-positive errors on the new `"prompt"` kind. The union itself is
verified correct via **isolated `tsc`** (positive compile + a negative test
proving unguarded `workflowId` access errors) and all consuming code guards
`workflowId` behind `kind === "workflow"`. **CI must rebuild `@elizaos/core`
dist, then run the full typecheck** — defer whole-graph `bun run verify` to CI.

## Evidence still required (evidence-gated — N/A in this environment)

This environment has **no live-model key and no device/browser**, so per
`PR_EVIDENCE.md` the following are `N/A - no live model / no browser in the
implementation environment` and MUST be produced by a human/CI before the PR is
"done":

- **Real-LLM trajectory (WI-6b):** the `WORKFLOW` action invoked from an
  orchestrator/`tasks` context against a **live** model, with asserted outcome.
  Command to run:
  ```
  packages/scenario-runner/bin/eliza-scenarios run <workflow-from-orchestrator-scenario> \
    --report .github/issue-evidence/12177-workflow-orchestrator.json
  ```
  (or, with a Cerebras key: `OPENAI_BASE_URL=https://api.cerebras.ai/v1 OPENAI_MODEL=gpt-oss-120b …`).
  Then read the report by hand. The headless service-call path (b) IS proven
  above; only the live-model action trajectory is gated.

- **UI screenshots + walkthrough (WI-2 / WI-5):** before/after full-page
  desktop+mobile of `/automations`, the trigger form (ex-Heartbeat), and all
  three editors; plus a video of create-prompt-automation → fires → appears in
  the feed; console+network logs showing `/api/triggers` (and `/api/heartbeats`
  → 404). Command to run:
  ```
  bun run --cwd packages/app audit:app        # per-view verdicts, desktop+mobile
  bun run test:e2e:record                      # walkthrough video
  ```
  Fill each `manual-review/<slug>.md` verdict to `good`.

- **Whole-repo typecheck + lint (all WIs):** `bun run verify` after a fresh
  `@elizaos/core` dist rebuild (see the worktree note above).
```
```
