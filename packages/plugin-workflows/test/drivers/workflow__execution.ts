// spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"
import type { Driver } from "../../gen/workflow__execution.conformance.ts";
import type { Event } from "../../gen/workflow__execution.ts";
import { workflowDriver } from "../support/service.ts";

export const { driver, options } = workflowDriver({
  namespace: "execution",
  bind: (service, id) => ({
    step: (event: Event) => service.executionStep(id, event),
    observe: () => service.executionState(id),
  }),
}) satisfies { readonly driver: Driver & AsyncDisposable };
