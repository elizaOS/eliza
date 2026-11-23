// spec/workflow/approvals.md, "Story: Decide one reviewed approval once and run its device step only as reviewed"
import type { Driver } from "../../gen/workflow__approvals.conformance.ts";
import type { Event } from "../../gen/workflow__approvals.ts";
import { serviceDriver } from "../support/service.ts";

export const driver: Driver & AsyncDisposable = serviceDriver("approvals", (service, id, event: Event) => service.approvalStep(id, "step", event), (service, id) => service.approvalState(id, "step"));

export const options = { keys: ["a", "b"] };
