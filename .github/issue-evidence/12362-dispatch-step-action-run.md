# Evidence — #12362 residual: dispatch_workflow step e2e + keyless WORKFLOW action run (WI-6/WI-7 close-out)

Issue: elizaOS/eliza#12362 (parent #12177; decomposed follow-ups #12898/#12899/#12900).
Branch: `test/12362-dispatch-step-action-run`. Prior evidence for this issue:
`12362-workflow-lifeops-integration.md` (PR #12913) and PR #12385.

## What this change is

**Test-only.** No runtime, action, provider, prompt, or model code is touched —
the change proves existing behavior. It closes the last two coverage gaps a
fresh audit of #12362's Done-when found after #12385 and #12913 merged:

### 1. `dispatch_workflow` LifeOps workflow step → real embedded execution

`plugins/plugin-workflow/__tests__/integration/dispatch-workflow-step-e2e.test.ts`

The LifeOps owner-workflow step `kind: "dispatch_workflow"`
(`plugins/plugin-personal-assistant/src/lifeops/registries/workflow-step-default-pack.ts`)
had no test driving it to a real workflow execution. The new suite registers
the REAL default WorkflowStepRegistry pack on the runtime (the same wiring
plugin-personal-assistant's init performs) and invokes the step exactly the
way the LifeOps dispatcher (`WorkflowsDomain.executeWorkflowDefinition`) does —
runtime-bound registry lookup → `paramSchema.parse` → `contribution.execute` —
never by calling the WORKFLOW_DISPATCH service directly. Underneath is the
REAL dispatch service over a REAL PGlite-backed `EmbeddedWorkflowService`.

Cases: (a) real `workflow.embedded_executions` row + parent `request` and
accumulated `outputs` threaded into the nested run's `customData.triggerData`;
(b) two step fires sharing an `__idempotencyKey` collapse onto ONE execution
row (`dedup: true`); (c) missing WORKFLOW_DISPATCH → structured
`{ ok: false, error: "WORKFLOW_DISPATCH service not registered" }`, no row;
(d) unknown workflowId → structured not-found failure from the real dispatch,
no row; (e) a step without `workflowId` is rejected by the contribution's zod
schema before any dispatch.

Placement note: the full `WorkflowsDomain` class is not importable from this
package (its repository value-imports built dists of
plugin-browser/finances/inbox), so the suite drives the registry seam the
dispatcher consults; the dispatcher's loop mechanics around that seam are
covered by `plugins/plugin-personal-assistant/test/workflow-step-registry.test.ts`.

### 2. Keyless WORKFLOW action `run` op against the real service stack

`plugins/plugin-workflow/__tests__/integration/workflow-action-run-e2e.test.ts`

The action's `run` op (`workflow.ts` → `handleRunWorkflow` →
`WorkflowService.runWorkflow`) previously had only mocked-unit coverage plus
the live-only scenario. The new suite starts a REAL `WorkflowService` via
`WorkflowService.start()` (keyless — no model, no API key) over the real
embedded engine and invokes the real action handler. No workflow-service mocks.

Cases: (a) run → `success: true`, callback metadata reports the real
execution, and a finished manual-mode row is read back through the same real
service layer the `executions` op uses; (b) a workflow whose code node throws
→ `success: false` AND a persisted error-status execution row whose
diagnostics name the failing node (`Node "Work" failed`, the
throwOnError:false contract); (c) missing workflowId → structured failure,
zero executions; (d) unknown workflowId → the real store's not-found failure;
(e) `validate()` flips with real service registration.

Shared harness: `__tests__/integration/embedded-harness.ts` (the
trigger-dispatch-e2e makeHarness pattern extracted for the two new suites —
real PGlite DB, real services map; the only double is the in-memory task
store, same as workflow-task-worker.test.ts).

## Domain artifacts (inspected in-test)

- `workflow.embedded_executions` rows — exactly 1 per successful dispatch/run;
  exactly 1 after an idempotent double-fire; 0 on every failure path except
  the failing-node run, which persists exactly 1 `status: "error"` row.
- `customData.triggerData` on the nested execution — carries the step payload
  plus the parent run's `request` and `outputs` (the contribution's contract).
- Error-run diagnostics — `data.resultData.error.message` names the failing
  node.

## Backend logs (real code path firing)

```
Info  [PLUGIN:WORKFLOW:EMBEDDED] Embedded workflow service registered (lazy runtime load)
Info  [PLUGIN:WORKFLOW:SMITHERS] workflow executed (workflowId=9242111b-87ef-4a44-995a-94afa218bca1, executionId=f95c996b-2aa1-4728-b598-dee61373b1ef, nodes=2, levels=2, maxConcurrency=1, started=2, finished=2, failed=0, skipped=0, retries=0)
Warn  [PLUGIN:WORKFLOW:DISPATCH] Workflow execution failed for no-such-workflow: Workflow not found: no-such-workflow
Info  [PLUGIN:WORKFLOW:SERVICE:MAIN] Workflow Service started - connected to in-process
Warn  [PLUGIN:WORKFLOW:ACTION:RUN] Workflow not found: no-such-workflow
```

Each `workflow executed` line is a real Smithers engine run against PGlite.

## Verification (commands + results)

```
bun test __tests__/integration/dispatch-workflow-step-e2e.test.ts
  → 5 pass, 0 fail, 20 expect() calls

bun test __tests__/integration/workflow-action-run-e2e.test.ts
  → 5 pass, 0 fail, 24 expect() calls

bun run --cwd plugins/plugin-workflow test
  → 366 pass, 0 fail, 1108 expect() calls, 36 files   (was 356 across 34 files)

bun run --cwd plugins/plugin-agent-orchestrator test
  → 156 files passed | 3 skipped; 1629 tests passed | 6 skipped (pre-existing skips)
```

## Evidence rows

| Evidence | Status |
| --- | --- |
| Real-LLM trajectory | N/A — test-only change, no agent/action/prompt/model behavior altered; the live WORKFLOW-action trajectory for this issue was captured + reviewed in PR #12913 (`12362-lifeops-live/live-workflow-action-executions.report.json`). |
| Backend logs | Attached above (Smithers `workflow executed`, dispatch/action warn paths, service lifecycle). |
| Domain artifacts | `embedded_executions` rows (success, error, dedup), `customData.triggerData` threading, failing-node diagnostics — asserted in-test and listed above. |
| Frontend logs / screenshots / video | N/A — no UI surface changed (test-only). |
