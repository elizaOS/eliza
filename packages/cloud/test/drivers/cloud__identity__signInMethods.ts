// spec/cloud/identity/signInMethods.md, "Story: Review, link and remove my sign-in methods"
import type { Driver, Options } from "../../gen/cloud__identity__signInMethods.conformance.ts";
import type { Event, Methods } from "../../gen/cloud__identity__signInMethods.ts";
import { reviewRows } from "../../src/identity/methods.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const person = (key: string) => `person-${key}`;
const emitted = new Map<string, unknown>();

async function dispatch(key: string, event: Event) {
  const done = await cloud.run(within((tx) => stepRow(tx, reviewRows, person(key), event, () => ({ updated_at: event.now }))));
  emitted.set(key, done.kind === "done" ? done.value.out.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Methods> {
  const done = await cloud.run(within((tx) => loadRow(tx, reviewRows, person(key), false)));
  if (done.kind === "failed") throw new Error(`reading the review failed with ${done.tag}`, { cause: done.error });
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
