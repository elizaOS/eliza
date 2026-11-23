// spec/workflow/approvals.md, "Story: Decide one reviewed approval once and run its device step only as reviewed"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__approvals.conformance.ts";
import type { Event } from "../../gen/workflow__approvals.ts";
import { openDriverService, outcome, type OpenedService } from "../support/service.ts";

let opened: Promise<OpenedService> | undefined;
let generation = 0;
const open = () => (opened ??= openDriverService());
const id = (key: string) => `approvals-${generation}-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset() {
    generation += 1;
  },
  async dispatch(key: string, event: Event) {
    const { service } = await open();
    return outcome(service.approvalStep(id(key), "step", event));
  },
  async observe(key: string) {
    const { service } = await open();
    return Effect.runPromise(service.approvalState(id(key), "step"));
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done !== undefined) await (await done).close();
  },
};

export const options = { keys: ["a", "b"] };
