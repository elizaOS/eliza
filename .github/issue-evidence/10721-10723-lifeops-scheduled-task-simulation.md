# #10721/#10723 LifeOps Scheduled-Task Simulation Harness

## What Changed

- Added `plugins/plugin-personal-assistant/test/helpers/lifeops-scheduled-task-simulation.ts`.
- The helper composes the real `@elizaos/plugin-scheduling` runner with built-in gates, completion checks, escalation ladders, in-memory scheduled-task/log stores, a controllable clock, and a typed `DispatchResult` ledger.
- The helper can opt into the PA production scheduled-task dispatcher with an in-memory runtime, channel registry, connector registry, default channel pack, and a simulated connector contribution.
- Added `plugins/plugin-personal-assistant/test/lifeops-scheduled-task-simulation.test.ts`.

## Coverage

- Schedules and fires the concrete primitives requested by #10721/#10723:
  `goal`, `todo`, `message_triage`, `reminder`, `checkin`, `followup`, `recap`, `approval`.
- Proves dispatch reaches the real runner dispatcher path and records a per-task domain artifact:
  `metadata.lastDispatchResult`.
- Proves structural completion via `completionCheck.kind = "user_acknowledged"` and `evaluateCompletion`.
- Proves typed connector failure data is preserved, not collapsed to a boolean:
  `{ ok:false, reason:"auth_expired", message:"owner grant expired", userActionable:true }`.
- Proves a task can fire through the real PA production dispatcher into a simulated Discord connector, and inspects the connector payload/result artifact.

## Verification

Command:

```bash
bun run --cwd plugins/plugin-personal-assistant test -- lifeops-scheduled-task-simulation.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

Manual review:

- Confirmed the first test asserts all eight primitive dispatch rows in `h.dispatches`.
- Confirmed the completion test inspects state-log transitions:
  `scheduled -> fire_attempt -> fired -> completed`.
- Confirmed the failure test compares the typed `DispatchResult` in both the ledger and persisted task metadata.
- Confirmed the production-dispatcher test uses `target=discord:owner-room`, observes the normalized connector payload target `owner-room`, and compares the simulated connector `DispatchResult` against persisted task metadata.

## Evidence Boundary

This is credential-free simulation against the production scheduling spine and PA production dispatcher. It does not claim live OAuth/device validation for #8833, and it does not replace live connector/device evidence.
