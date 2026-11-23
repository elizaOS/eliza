// spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"
import type { Driver } from "../../gen/workflow__execution.conformance.ts";
import type { Event } from "../../gen/workflow__execution.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("execution", {
  step: (service, id, event: Event) => service.executionStep(id, event),
  observe: (service, id) => service.executionState(id),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
