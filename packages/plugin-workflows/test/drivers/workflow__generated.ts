// spec/workflow/generated.md, "Story: Resume generated code after a wait without repeating what it already did"
import type { Driver } from "../../gen/workflow__generated.conformance.ts";
import type { Event } from "../../gen/workflow__generated.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("generated", {
  step: (service, id, event: Event) => service.generatedStep(id, event),
  observe: (service, id) => service.generatedState(id),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
