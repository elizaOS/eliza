// spec/cloud/billing/funds.md, "Story: Spend only money the account has"
import type { Driver, Options } from "../../gen/cloud__billing__funds.conformance.ts";
import type { Event, Funds } from "../../gen/cloud__billing__funds.ts";
import { addCredits, readFunds, stepFunds } from "../../src/billing/funds.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";

const cloud = ledger();
let requests = 0;

const organization = (key: string) => `org-${key}`;

const outcome = (done: Settled<unknown>, refusals: ReadonlyArray<string>): "accepted" | "refused" => {
  if (done.kind === "done") return "accepted";
  if (refusals.includes(done.tag)) return "refused";
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
};

async function dispatch(key: string, event: Event) {
  const organizationId = organization(key);
  switch (event.type) {
    case "addCredits": {
      const done = await cloud.run(addCredits({ organizationId, amount: event.amount, requestKey: `add-${++requests}` }));
      return outcome(done, ["InvalidCreditRequest", "Rejected"]);
    }
    case "holdCredits":
    case "settleCredits":
      return outcome(await cloud.run(within((tx) => stepFunds(tx, organizationId, event, 0, `${event.type}-${++requests}`))), ["Rejected"]);
    default: {
      const unknown: never = event;
      throw new Error(`not a funds event: ${JSON.stringify(unknown)}`);
    }
  }
}

async function observe(key: string): Promise<Funds> {
  const done = await cloud.run(within((tx) => readFunds(tx, organization(key), false)));
  if (done.kind === "failed") throw new Error(`reading funds failed with ${done.tag}`, { cause: done.error });
  const balance = await cloud.sql("SELECT credit_balance FROM organizations WHERE id = $1", [organization(key)]);
  if (Number(balance[0]?.credit_balance) !== done.value.creditBalance - done.value.creditHeld) throw new Error(`organizations.credit_balance ${String(balance[0]?.credit_balance)} is not the available credits of ${JSON.stringify(done.value)}`);
  return done.value;
}

export const driver: Driver & AsyncDisposable = {
  reset: () => cloud.reset(options.keys?.map(organization) ?? []),
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a", "b"] };
