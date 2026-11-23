// spec/workflow/lifecycle.md, "Story: Remove a workflow only when its runs are settled and restore it safely"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__lifecycle.conformance.ts";
import type { Event } from "../../gen/workflow__lifecycle.ts";
import { openDriverService, outcome, type OpenedService } from "../support/service.ts";

let opened: Promise<OpenedService> | undefined;
let generation = 0;
const open = () => (opened ??= openDriverService());
const id = (key: string) => `lifecycle-${generation}-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset() {
    generation += 1;
  },
  async dispatch(key: string, event: Event, by?: unknown) {
    const { service } = await open();
    return outcome(service.lifecycleStep(id(key), event, String(by as string | undefined ?? "")));
  },
  async observe(key: string) {
    const { service } = await open();
    return Effect.runPromise(service.lifecycleOf(id(key)));
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done !== undefined) await (await done).close();
  },
};

export const options = { keys: ["a", "b"] };
