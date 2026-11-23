// spec/workflow/generated.md, "Story: Resume generated code after a wait without repeating what it already did"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__generated.conformance.ts";
import type { Event } from "../../gen/workflow__generated.ts";
import { openDriverService, outcome, type OpenedService } from "../support/service.ts";

let opened: Promise<OpenedService> | undefined;
let generation = 0;
const open = () => (opened ??= openDriverService());
const id = (key: string) => `generated-${generation}-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset() {
    generation += 1;
  },
  async dispatch(key: string, event: Event) {
    const { service } = await open();
    return outcome(service.generatedStep(id(key), event));
  },
  async observe(key: string) {
    const { service } = await open();
    return Effect.runPromise(service.generatedState(id(key)));
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done !== undefined) await (await done).close();
  },
};

export const options = { keys: ["a", "b"] };
