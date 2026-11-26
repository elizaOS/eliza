// spec/workflow/budget.md, "Story: Bound workflow tokens, model calls and cost across multi-step runs"
import type { Driver } from "../../gen/workflow__budget.conformance.ts";
import type { Event } from "../../gen/workflow__budget.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("budget", {
  step: (service, id, event: Event) => service.budgetStep(id, event),
  observe: (service, id) => service.budgetState(id),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
