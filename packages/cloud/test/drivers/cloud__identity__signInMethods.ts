// spec/cloud/identity/signInMethods.md, "Story: Review, link and remove my sign-in methods"
import type { Driver, Options } from "../../gen/cloud__identity__signInMethods.conformance.ts";
import type { Event, Methods } from "../../gen/cloud__identity__signInMethods.ts";
import { reviewRows } from "../../src/identity/methods.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];

async function dispatch(key: string, event: Event) {
  return cloud.dispatch(key, within((tx) => stepRow(tx, reviewRows, cloud.person(key), event, () => ({ updated_at: event.now }))), (value) => value.out.out);
}

async function observe(key: string): Promise<Methods> {
  const done = await cloud.run(within((tx) => loadRow(tx, reviewRows, cloud.person(key), false)));
  if (done.kind === "failed") throw new Error(`reading the review failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: () => cloud.resetPeople(keys),
  dispatch,
  observe,
  observeOutput: cloud.observeOutput,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
