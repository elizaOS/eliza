# Automation glossary & integration model

elizaOS has several overlapping scheduling / automation abstractions. They are
*not* interchangeable, and using the wrong word for one of them is how a new
engineer ends up looking for a "task" in the wrong table or adding a second
scheduler. This document is the single source of truth for the vocabulary and
for how the pieces fit together. Every term below is **the** word for its
concept in code identifiers, API paths, DB names, UI copy, and docs.

## Glossary — one word per concept

| Term | Meaning | Where it lives |
| --- | --- | --- |
| **workflow** | A stored, versioned definition of multi-step work — the plugin-workflow node graph. Never a run, never a schedule. | `plugins/plugin-workflow` · `workflow.embedded_workflows` |
| **run** | One execution of a workflow (or of a trigger). The concrete storage/API name is `execution` / `embedded_executions` / `/executions` and is kept as-is; UI copy and new code say "run". | `workflow.embedded_executions` |
| **trigger** | The attachable condition that starts a runnable: a **schedule** (`cron` \| `interval` \| `once`) or an **event**. One `TriggerConfig` references exactly one target — `kind: "workflow"` (a `workflowId`) or `kind: "prompt"` (a prompt automation). "Heartbeat" is **not** a synonym for trigger. | `packages/core/src/types/trigger.ts` (`TriggerConfig`) stored in a core `Task`'s `metadata.trigger` |
| **schedule** | The time spec *inside* a trigger (`cronExpression` / `intervalMs` / `scheduledAtIso`). Not an independent object. | fields on `TriggerConfig` |
| **task** (unqualified) | ONLY the core runtime infra unit (`packages/core/src/types/task.ts`): a persisted unit of deferred/recurring work run by `TaskService` via a registered `TaskWorker`. Infrastructure vocabulary — never user-facing. | `tasks` table (`plugins/plugin-sql/src/schema/tasks.ts`) |
| **scheduled item** | A LifeOps `ScheduledTask` record (reminder / check-in / follow-up / approval / recap / watcher / output). The code type stays `ScheduledTask` (frozen contract); prose and UI say "scheduled item". | `app_lifeops.life_scheduled_tasks` |
| **coding task** | An orchestrator work item (`OrchestratorTaskRecord`) — a coding delegation to a sub-agent. Code keeps its `Orchestrator*` prefix; UI/docs always qualify as "coding task", never bare "task". | `orchestrator_tasks` table |
| **automation** | The UI umbrella read-model only (`/api/automations` + merged scheduled items): "anything that runs without you asking in the moment". Never a storage concept or a backend type outside the read-model builders. | `plugins/plugin-workflow/src/routes/automations.ts` |
| **heartbeat** | A connector keep-alive repeat `Task` (tag `heartbeat`), and nothing else. Correct English for what those are; the misuse was applying it to user triggers. | core `Task` tagged `["queue","repeat","heartbeat"]` |
| **prompt automation** | A workbench task expressed as a **prompt trigger**: a prompt + a trigger, no node graph (`TriggerConfig.kind === "prompt"`). | core `Task` with `metadata.trigger.kind === "prompt"` |

### "task" disambiguation table

The word "task" is overloaded across the codebase. These are the distinct
concepts; only concept A is the unqualified word "task".

| # | "task" means | Store | Owner |
| --- | --- | --- | --- |
| A | Core recurring/deferred runtime Task (infra) — **the** unqualified "task" | `tasks` | `packages/core/src/types/task.ts`; `plugins/plugin-sql/src/schema/tasks.ts` |
| B | Workbench task — a core Task surfaced as a "prompt automation" (prompt + trigger) | reuses `tasks` (schedule in `metadata.trigger`) | `plugins/plugin-workflow` (automations builder) |
| C | LifeOps scheduled item (reminder / check-in / …) → say **scheduled item** | `app_lifeops.life_scheduled_tasks` | `plugins/plugin-scheduling` |
| D | Orchestrator coding task (goal + sub-agent sessions) → say **coding task** | `orchestrator_tasks` | `plugins/plugin-agent-orchestrator` |
| E | Todo — user to-do item | `todos.todos` | `plugins/plugin-todos` |
| F | iOS background task (BGTaskScheduler bridge) | none (OS) | `plugins/plugin-native-eliza-tasks` |

## One clock, two consumers

There is exactly **one** timer for user-facing scheduled work: the core
`TaskService`, which ticks every second (`packages/core/src/services/task.ts`),
polls `Task` rows tagged `queue`, runs each due one, and reschedules `repeat`
tasks via `metadata.updateInterval`. Recurrence rides **tags**
(`queue` = scheduler-owned, `repeat` = recurring), not columns.

Two subsystems are *consumers* of that one clock, wired in at exactly two points.
Nothing else schedules user work; do not add a second scheduler
(`plugins/plugin-personal-assistant/README.md` mandates one runner).

```
                         core TaskService  (1s tick, packages/core/src/services/task.ts)
                          polls Task rows tagged "queue"
                                    │
              ┌─────────────────────┴──────────────────────────┐
              │                                                  │
   TRIGGER_DISPATCH task                               LIFEOPS_SCHEDULER task
   tags [queue, repeat, trigger]                       tags [queue, repeat, lifeops]  (60s)
   metadata.trigger : TriggerConfig                    packages/plugin-personal-assistant
   packages/agent/src/triggers/runtime.ts                     /lifeops/scheduler-task.ts
              │                                                  │
     reads TriggerConfig.kind                          processDueScheduledTasks
        ├── "workflow" → WORKFLOW_DISPATCH service      (due-fire / recurrence / timeout)
        │               (plugin-workflow)                        │
        └── "prompt"   → prompt-runner path             ScheduledTask runner (state machine)
                        (agent runtime)                 plugins/plugin-scheduling/src/
                                                          scheduled-task/runner.ts
```

- **Trigger consumer** — a `TRIGGER_DISPATCH` core Task carries a `TriggerConfig`
  in `metadata.trigger`. When it fires, `executeTriggerTask`
  (`packages/agent/src/triggers/runtime.ts`) reads `TriggerConfig.kind` and
  dispatches: `"workflow"` → the `WORKFLOW_DISPATCH` service (plugin-workflow),
  `"prompt"` → the prompt-runner path. Each fire appends a `TriggerRunRecord`.
- **LifeOps consumer** — a single `LIFEOPS_SCHEDULER` repeat Task (60 s) runs
  `processDueScheduledTasks`, which drives the `ScheduledTask` runner state
  machine (`plugins/plugin-scheduling/src/scheduled-task/runner.ts`). The runner
  owns no timer of its own — the one core clock ticks it.

A scheduled workflow is therefore already "a workflow schedulable via the
task/cron layer": plugin-workflow's `armSchedules()` materializes each
schedule-trigger node as a `TRIGGER_DISPATCH` core Task
(`plugins/plugin-workflow/src/services/embedded-workflow-service.ts`).

## Who fires what — route map

| Concept | HTTP surface | Handler |
| --- | --- | --- |
| workflow (definition CRUD, run) | `/api/workflow/*` (rawPath) | `plugins/plugin-workflow/src/plugin-routes.ts` → `routes/workflow-routes.ts` |
| trigger (schedule/event start condition) | `/api/triggers` (+ `/health`, `/:id/runs`, `/:id/execute`, `/events/:eventKind`, `/:id`) | `plugins/plugin-workflow/src/trigger-routes.ts` |
| automation (umbrella read-model) | `GET /api/automations` | `plugins/plugin-workflow/src/routes/automations.ts` |
| scheduled item (LifeOps) | `/api/lifeops/scheduled-tasks/*` | `plugins/plugin-scheduling/src/routes/scheduled-tasks.ts` |
| coding task (orchestrator) | `/api/orchestrator/tasks*` | `plugins/plugin-agent-orchestrator/src/setup-routes.ts` |

There is no `/api/heartbeats` route — it was an alias for `/api/triggers` and has
been removed. Connector keep-alive heartbeats still surface read-only in the
trigger list (synthesized in `packages/agent/src/triggers/runtime.ts`).

## Two "workflow" models — distinctly named

Two unrelated things are called "workflow"; always qualify the LifeOps one.

- **workflow** (engine) — plugin-workflow's n8n-shaped node graph, executed
  in-process by the Smithers engine.
- **LifeOps workflow** (`LifeWorkflow*` / `life_workflow_*`) — schedule +
  action-plan records bound to the LifeOps runner's frozen contract. A different
  shape entirely; merging it into the node-graph engine is out of scope
  (see issue #12177 non-goals). Say "LifeOps workflow" when you mean this one.

## One runtime cron engine

`packages/core/src/services/triggerScheduling.ts` is the only server-side cron
implementation (`parseCronExpression`, `computeNextCronRunAtMs`). Both the
trigger layer and the LifeOps runner import it. The UI's `cron-parser` npm dep is
for **client-side validation/preview only**. Do not add a third parser.

## Schedule encodings (there are exactly two)

1. **`TriggerConfig`** (jsonb in a core Task's `metadata.trigger`) — engine
   triggers and prompt automations.
2. **LifeOps `trigger` union** (typed row) — scheduled items.

The former `schedule:<cron>` **tag** encoding on workbench tasks has been
deleted; those schedules now live in `metadata.trigger` like every other
trigger.
