# Evidence — #12362 Workflow scheduling + orchestrator integration tests (WI-6/WI-7)

Issue: elizaOS/eliza#12362 (parent #12177). Branch: `test/12362-workflow-lifeops-integration`.

## What this change is

**Test-only.** It adds the integration coverage the issue's Done-when still
lacked after the parent scheduling/terminology work merged in #12385
(`378c40fed35`). No runtime, action, provider, prompt, or model code is
touched — so the change cannot alter agent behavior; it only proves the
existing behavior.

The parent PR (#12385) already landed `trigger-dispatch-e2e.test.ts` cases
(a)–(d): a scheduled workflow fires through the **real** core `TaskService`
tick → dispatches → records an `embedded_executions` row + a `TriggerRunRecord`;
a headless `WORKFLOW_DISPATCH` service call; one clock servicing a workflow
trigger and a LifeOps task on one tick; and disabled-trigger / maxRuns behavior.

Two Done-when gaps remained. This change closes them:

### (e) Overlapping-fire blocking through the workflow trigger path

`plugins/plugin-workflow/__tests__/integration/trigger-dispatch-e2e.test.ts`
case (e). The real `WORKFLOW_DISPATCH` service is wrapped in a timing gate so
the first fire stays in-flight across two `runDueTasks()` ticks. The second
tick finds the trigger task in the core `executingTasks` set
(`task.metadata.blocking !== false`) and **skips** it — so exactly one
`embedded_executions` row lands despite two ticks over the due task. The gate
still calls the real dispatch underneath; only completion timing is controlled.

### (f) LifeOps scheduled-item fire with a REAL domain artifact on the same clock

Case (f). Case (c) proved the "one clock, two consumers" architecture with a
counter stand-in for the LifeOps worker. Case (f) upgrades the second consumer
to the **real ScheduledTask spine** — `createScheduledTaskRunner` +
`createInMemoryScheduledTaskStore` + `createInMemoryScheduledTaskLogStore`, the
same adapters `runner-service.ts` uses in production. A `LIFEOPS_SCHEDULER`
worker, fired by the one core clock, calls `runner.fireWithResult(...)`, and the
test asserts a real `fired` **state-log row** and `state.status === "fired"` —
the LifeOps consumer's genuine domain artifact. The spine imports
`@elizaos/core` for types only, so no second runtime copy of core is created.

## Domain artifacts (inspected)

- **`embedded_executions`** rows — case (e) asserts exactly `1` after two ticks
  over the same due trigger task (overlap blocked). Cases (a)/(c)/(f) assert
  `>= 1`.
- **`TriggerRunRecord`** — case (a) asserts a run record with `status: "success"`.
- **ScheduledTask state-log** — case (f) asserts the transition list contains
  `"fired"` and the persisted task `state.status === "fired"`.

## Backend logs (real code path firing)

From the integration run (structured `[PLUGIN:WORKFLOW:*]` logger lines):

```
Info  [PLUGIN:WORKFLOW:EMBEDDED] Embedded workflow service registered (lazy runtime load)
Info  [PLUGIN:WORKFLOW:SMITHERS] workflow executed (workflowId=…, executionId=…, nodes=2, levels=2, maxConcurrency=1, started=2, finished=2, failed=0, skipped=0, retries=0)
```

Each `workflow executed` line is a real Smithers engine run against PGlite —
one per case that fires a workflow (6 across the file).

## Verification (commands + results)

```
bun run --cwd plugins/plugin-workflow test
  → 356 pass, 0 fail, 1064 expect() calls, 34 files    (was 354; +2 new cases e,f)

bun run --cwd plugins/plugin-workflow test __tests__/integration/trigger-dispatch-e2e.test.ts
  → 6 pass, 0 fail, 24 expect() calls

bun run --cwd packages/scenario-runner test src/corpus-assertion-guard.test.ts
  → 9 pass  (the new live-only scenario does not trip the pr-deterministic ratchet)
```

## Live-model WORKFLOW-action trajectory

Authored: `packages/scenario-runner/test/scenarios/live-workflow-action-executions.scenario.ts`
(`lane: "live-only"`). It seeds + executes a real embedded workflow, then a
live user turn ("check my '<name>' workflow and tell me its most recent runs")
must route to the `WORKFLOW` action's `executions` op; `finalChecks` assert
`actionCalled WORKFLOW status:success` and that the seeded execution is readable
through the real service. The file loads and lists cleanly
(`eliza-scenarios list … --scenario live-workflow-action-executions`).

**Live run status in this dev environment: BLOCKED (environmental, not a code
defect).** Booting the full scenario `AgentRuntime` dynamically imports the
optional `@elizaos/plugin-vision`, whose `sharp-compat.ts` hard-imports `jimp`
(`"jimp": "^1.6.0"`, declared in `plugins/plugin-vision/package.json`). `jimp`
is not present in the shared workspace `node_modules` — a full-`bun install`
gap that affects the parent checkout too (`install:light` / artifact-sync skips
it), not something this branch introduced. CI with a full install runs it. The
existing deterministic sibling
(`deterministic-workflow-actions-routes.scenario.ts`) already proves the same
WORKFLOW action + routes end to end under the LLM proxy, and cases (a)–(f)
above prove the scheduling/dispatch path with real services and artifacts.

## Evidence rows

| Evidence | Status |
| --- | --- |
| Real-LLM trajectory | Authored + schema-valid; live run blocked by the `jimp`/plugin-vision install gap (documented above); deterministic proxy sibling covers the WORKFLOW action path. |
| Backend logs | Attached (Smithers `workflow executed` + embedded-service registration). |
| Domain artifacts | `embedded_executions`, `TriggerRunRecord`, ScheduledTask `fired` state-log — asserted in-test and listed above. |
| Frontend logs / screenshots / video | N/A — no UI surface changed (test-only). |
