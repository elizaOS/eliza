// spec/workflow/generated.md, "Story: Resume generated code after a wait without repeating what it already did"
import type { Driver } from "../../gen/workflow__generated.conformance.ts";
import type { Event } from "../../gen/workflow__generated.ts";
import { serviceDriver } from "../support/service.ts";

export const driver: Driver & AsyncDisposable = serviceDriver("generated", (service, id, event: Event) => service.generatedStep(id, event), (service, id) => service.generatedState(id));

export const options = { keys: ["a", "b"] };
