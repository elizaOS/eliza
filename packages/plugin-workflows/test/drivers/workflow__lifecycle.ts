// spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"
import type { Driver } from "../../gen/workflow__lifecycle.conformance.ts";
import { workflowDriver } from "../support/service.ts";

export const { driver, options } = workflowDriver({
  namespace: "lifecycle",
  bind: (service, id) => service.lifecycleFor(id),
}) satisfies { readonly driver: Driver & AsyncDisposable };
