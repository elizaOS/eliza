// spec/workflow/admission.md, "Story: Run the version I reviewed and recover an ambiguous response"
import { Effect } from "effect";
import type { Driver } from "../../gen/workflow__admission.conformance.ts";
import type { Event } from "../../gen/workflow__admission.ts";
import { openDriverService, outcome, type OpenedService } from "../support/service.ts";

let opened: Promise<OpenedService> | undefined;
let generation = 0;
const open = () => (opened ??= openDriverService());
const id = (key: string) => `admission-${generation}-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset() {
    generation += 1;
  },
  async dispatch(key: string, event: Event, by?: unknown) {
    const { service } = await open();
    return outcome(service.admissionStep(id(key), event, String(by as string | undefined ?? "")));
  },
  async observe(key: string) {
    const { service } = await open();
    return Effect.runPromise(service.admissionState(id(key)));
  },
  async [Symbol.asyncDispose]() {
    const done = opened;
    opened = undefined;
    if (done !== undefined) await (await done).close();
  },
};

export const options = { keys: ["a", "b"] };
