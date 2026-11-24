// spec/cloud/identity/sessions.md, "Story: Stay signed in"; spec/cloud/identity/sessions.md, "Story: Sign out here, or end my other sessions"; spec/cloud/identity/sessions.md, "Story: Confirm it is me before a sensitive change"
import type { Driver, Options } from "../../gen/cloud__identity__sessions.conformance.ts";
import type { Event, Family } from "../../gen/cloud__identity__sessions.ts";
import { familyRows, stepFamily } from "../../src/identity/sessions.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];
const family = (key: string) => `family-${key}`;

async function dispatch(key: string, event: Event) {
  return cloud.dispatch(key, within((tx) => stepFamily(tx, family(key), event, 0, () => ({ user_id: cloud.person(key), access_digest: `${key}-access`, refresh_digest: `${key}-refresh` }))), (value) => value.out);
}

async function observe(key: string): Promise<Family> {
  const done = await cloud.run(within((tx) => loadRow(tx, familyRows, family(key), false)));
  if (done.kind === "failed") throw new Error(`reading the family failed with ${done.tag}`, { cause: done.error });
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
