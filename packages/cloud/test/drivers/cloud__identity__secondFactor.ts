// spec/cloud/identity/secondFactor.md, "Story: Set up and change my second factor"; spec/cloud/identity/secondFactor.md, "Story: Finish sign-in with my second factor"; spec/cloud/identity/secondFactor.md, "Story: Confirm it is me before a sensitive change"
import type { Driver, Options } from "../../gen/cloud__identity__secondFactor.conformance.ts";
import type { Event, SecondFactor } from "../../gen/cloud__identity__secondFactor.ts";
import { storedFactorRows } from "../../src/identity/second-factor.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const person = (key: string) => `person-${key}`;
const emitted = new Map<string, unknown>();

async function dispatch(key: string, event: Event) {
  const done = await cloud.run(within((tx) => stepRow(tx, storedFactorRows, person(key), event, () => ({}))));
  emitted.set(key, done.kind === "done" ? done.value.out.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<SecondFactor> {
  const done = await cloud.run(within((tx) => loadRow(tx, storedFactorRows, person(key), false)));
  if (done.kind === "failed") throw new Error(`reading the factors failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset(keys.map((key) => `org-${key}`));
    for (const key of keys) {
      await cloud.sql("INSERT INTO accounts (key, state, revision, organization_id, status, created_at, updated_at) VALUES ($1, '{}'::jsonb, 1, $2, 'active', 0, 0)", [person(key), `org-${key}`]);
    }
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
