// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"
import type { Driver } from "../../gen/workflow__admission.conformance.ts";
import type { Event } from "../../gen/workflow__admission.ts";
import { serviceDriver } from "../support/service.ts";

export const driver: Driver & AsyncDisposable = serviceDriver("admission", (service, id, event: Event, by) => service.admissionStep(id, event, by), (service, id) => service.admissionState(id));

export const options = { keys: ["a", "b"] };
