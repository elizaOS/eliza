// spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"
import type { Driver } from "../../gen/workflow__lifecycle.conformance.ts";
import type { Event } from "../../gen/workflow__lifecycle.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("lifecycle", {
  step: (service, id, event: Event, actor) => service.lifecycleStep(id, event, actor),
  observe: (service, id) => service.lifecycleOf(id),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
