// spec/cloud/identity/sessions.md, "Story: Stay signed in"; spec/cloud/identity/sessions.md, "Story: Sign out here, or end my other sessions"; spec/cloud/identity/sessions.md, "Story: Confirm it is me before a sensitive change"
import type { Driver, Options } from "../../gen/cloud__identity__sessions.conformance.ts";
import type { Event, Family } from "../../gen/cloud__identity__sessions.ts";
import { familyRows, stepFamily } from "../../src/identity/sessions.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const family = (key: string) => `family-${key}`;
const person = (key: string) => `person-${key}`;
const emitted = new Map<string, unknown>();

async function dispatch(key: string, event: Event) {
  const done = await cloud.run(within((tx) => stepFamily(tx, family(key), event, 0, () => ({ user_id: person(key), access_digest: `${key}-access`, refresh_digest: `${key}-refresh` }))));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Family> {
  const done = await cloud.run(within((tx) => loadRow(tx, familyRows, family(key), false)));
  if (done.kind === "failed") throw new Error(`reading the family failed with ${done.tag}`, { cause: done.error });
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
