// spec/workflow/generated.md, "Story: Resume generated code after a wait without repeating what it already did"
import type { Driver } from "../../gen/workflow__generated.conformance.ts";
import type { Event } from "../../gen/workflow__generated.ts";
import { workflowDriver } from "../support/service.ts";

export const { driver, options } = workflowDriver({
  namespace: "generated",
  bind: (service, id) => ({
    step: (event: Event) => service.generatedStep(id, event),
    observe: () => service.generatedState(id),
  }),
}) satisfies { readonly driver: Driver & AsyncDisposable };
