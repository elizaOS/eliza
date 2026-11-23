// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"
import type { Driver } from "../../gen/workflow__admission.conformance.ts";
import type { Event } from "../../gen/workflow__admission.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("admission", {
  step: (service, id, event: Event, actor) => service.admissionStep(id, event, actor),
  observe: (service, id) => service.admissionState(id),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
