// spec/cloud/services/google/connection.md, "Story: Connect my Google account with the access I chose"; spec/cloud/services/google/connection.md, "Story: Disconnect it"
import type { Driver, Options } from "../../gen/cloud__services__google__connection.conformance.ts";
import type { Connection, Event } from "../../gen/cloud__services__google__connection.ts";
import { connectionColumns, connectionRows } from "../../src/services/google/grant-access.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { identityDriverLedger, within } from "../support/ledger.ts";

const cloud = identityDriverLedger();
const keys = ["a", "b"];
const organization = (key: string) => `org-${key}`;
const connectionKey = (key: string) => `google-${key}`;

async function dispatch(key: string, event: Event): Promise<"accepted" | "refused"> {
  const done = await cloud.run(within((tx) => stepRow(tx, connectionRows, connectionKey(key), { at: 0, event }, (state: Connection) => ({
    ...connectionColumns({
      organization_id: organization(key),
      user_id: cloud.person(key),
      subject: state.subject,
    })(state),
  }))));
  if (done.kind === "done") return "accepted";
  if (done.tag === "Rejected") return "refused";
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Connection> {
  const done = await cloud.run(within((tx) => loadRow(tx, connectionRows, connectionKey(key), false)));
  if (done.kind === "failed") throw new Error(`reading the Google connection failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

export const driver: Driver & AsyncDisposable = {
  reset: () => cloud.resetPeople(keys),
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys };
