// spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"
import type { Driver } from "../../gen/workflow__execution.conformance.ts";
import type { Event } from "../../gen/workflow__execution.ts";
import { serviceDriver } from "../support/service.ts";

export const driver: Driver & AsyncDisposable = serviceDriver("execution", (service, id, event: Event) => service.executionStep(id, event), (service, id) => service.executionState(id));

export const options = { keys: ["a", "b"] };
