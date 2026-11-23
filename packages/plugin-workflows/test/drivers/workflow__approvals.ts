// spec/workflow/approvals.md, "Story: Decide one reviewed approval once and run its device step only as reviewed"
import type { Driver } from "../../gen/workflow__approvals.conformance.ts";
import type { Event } from "../../gen/workflow__approvals.ts";
import { workflowDriver } from "../support/service.ts";

export const driver = workflowDriver("approvals", {
  step: (service, id, event: Event) => service.approvalStep(id, "step", event),
  observe: (service, id) => service.approvalState(id, "step"),
}) satisfies Driver & AsyncDisposable;

export const options = { keys: ["a", "b"] };
