// spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"
import type { Driver } from "../../gen/workflow__lifecycle.conformance.ts";
import type { Event } from "../../gen/workflow__lifecycle.ts";
import { serviceDriver } from "../support/service.ts";

export const driver: Driver & AsyncDisposable = serviceDriver("lifecycle", (service, id, event: Event, by) => service.lifecycleStep(id, event, by), (service, id) => service.lifecycleOf(id));

export const options = { keys: ["a", "b"] };
