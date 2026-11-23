// spec/workflow/execution.md, "Story: Recover a parked workflow without creating a second execution"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__execution.conformance.ts";
import type { Event } from "../../gen/workflow__execution.ts";
import { openDriverService, outcome, type OpenedService } from "../support/service.ts";

let opened: Promise<OpenedService> | undefined;
let generation = 0;
const open = () => (opened ??= openDriverService());
const id = (key: string) => `execution-${generation}-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset() {
    generation += 1;
  },
  async dispatch(key: string, event: Event) {
    const { service } = await open();
    return outcome(service.executionStep(id(key), event));
  },
  async observe(key: string) {
    const { service } = await open();
    return Effect.runPromise(service.executionState(id(key)));
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done !== undefined) await (await done).close();
  },
};

export const options = { keys: ["a", "b"] };
