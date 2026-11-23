// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"
import type { Driver } from "../../gen/workflow__admission.conformance.ts";
import { workflowDriver } from "../support/service.ts";

export const { driver, options } = workflowDriver({
  namespace: "admission",
  bind: (service, id) => service.admissionFor(id),
}) satisfies { readonly driver: Driver & AsyncDisposable };
