// spec/cloud/services/google/connection.md, "Story: Connect my Google account with the access I chose"; spec/cloud/services/google/connection.md, "Story: See my Google connection as the cloud holds it"; spec/cloud/services/google/connection.md, "Story: Disconnect it"
import type { Driver, Options } from "../../gen/cloud__services__google__connection.conformance.ts";
import type { Connection, Event } from "../../gen/cloud__services__google__connection.ts";
import { connectionColumns, connectionRows } from "../../src/services/google/grant-access.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["a", "b"];
const row = (key: string) => `connection-${key}`;
const organization = (key: string) => `org-connection-${key}`;
const person = (key: string) => `user-connection-${key}`;

async function dispatch(key: string, event: Event) {
  const columns = connectionColumns({ organization_id: organization(key), user_id: person(key) });
  const done = await cloud.run(within((tx) => stepRow(tx, connectionRows, row(key), { at: 0, event }, (state: Connection) => ({ ...columns(state), subject: state.subject }))));
  if (done.kind === "done") return "accepted" as const;
  if (done.tag === "Rejected") return "refused" as const;
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Connection> {
  const done = await cloud.run(within((tx) => loadRow(tx, connectionRows, row(key), false)));
  if (done.kind === "failed") throw new Error(`reading the connection failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await cloud.reset(keys.map(organization));
    for (const key of keys) {
      await cloud.sql("INSERT INTO accounts (key, state, revision, organization_id, status, created_at, updated_at) VALUES ($1, '{}'::jsonb, 1, $2, 'active', 0, 0)", [person(key), organization(key)]);
    }
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
