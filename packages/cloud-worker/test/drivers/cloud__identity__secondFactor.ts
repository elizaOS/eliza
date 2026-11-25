// spec/cloud/identity/secondFactor.md, "Story: Set up and change my second factor"; spec/cloud/identity/secondFactor.md, "Story: Finish sign-in with my second factor"; spec/cloud/identity/secondFactor.md, "Story: Confirm it is me before a sensitive change"
import type { Driver, Options } from "../../gen/cloud__identity__secondFactor.conformance.ts";
import type { Event, SecondFactor } from "../../gen/cloud__identity__secondFactor.ts";
import { storedFactorRows } from "../../src/identity/second-factor.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];

async function dispatch(key: string, event: Event) {
  return cloud.dispatch(key, within((tx) => stepRow(tx, storedFactorRows, cloud.person(key), event, () => ({}))), (value) => value.out.out);
}

async function observe(key: string): Promise<SecondFactor> {
  const done = await cloud.run(within((tx) => loadRow(tx, storedFactorRows, cloud.person(key), false)));
  if (done.kind === "failed") throw new Error(`reading the factors failed with ${done.tag}`, { cause: done.error });
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
