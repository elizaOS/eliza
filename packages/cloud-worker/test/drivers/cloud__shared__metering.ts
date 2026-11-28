// spec/cloud/shared/metering.md, "Story: Never overdraw an account"; spec/cloud/shared/metering.md, "Story: Settle every call once"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/cloud__shared__metering.conformance.ts";
import type { Event, FundingLane, Hold } from "../../gen/cloud__shared__metering.ts";
import type { HoldKey } from "../../gen/cloud__shared__types.ts";
import { addCredits, readFunds, stepFunds } from "../../src/billing/funds.vibe";
import { holdRows, markDispatched, periodRows, reserve, settle, sweepHolds, type Settlement } from "../../src/shared/metering.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";

const cloud = ledger();
const periodEnd = 10 ** 13;
const organizations = new Map<string, string>();
const holds = new Map<string, { readonly key: HoldKey; readonly rendered: string }>();
let requests = 0;

const owner = (key: string) => ({ organizationId: organizations.get(key) ?? `org-${key}`, userId: `user-${key}` });
const rendered = (key: string) => holds.get(key)?.rendered ?? `${owner(key).organizationId}/no-hold`;

const must = <A>(what: string, done: Settled<A>): A => {
  if (done.kind === "failed") throw new Error(`${what} failed with ${done.tag}`, { cause: done.error });
  return done.value;
};

const refusedWhen = (done: Settled<unknown>, tags: ReadonlyArray<string>): "refused" => {
  if (done.kind === "failed" && tags.includes(done.tag)) return "refused";
  throw new Error(`the cloud failed with ${done.kind === "failed" ? done.tag : "nothing"}`, { cause: done.kind === "failed" ? done.error : undefined });
};

async function fundOrganization(key: string, lane: FundingLane, allowanceAvailable: number, creditAvailable: number) {
  const organizationId = owner(key).organizationId;
  await cloud.sql("DELETE FROM grants WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM allowance_periods WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM credit_entries WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM funds WHERE key = $1", [organizationId]);
  await cloud.sql("UPDATE organizations SET credit_balance = 0 WHERE id = $1", [organizationId]);
  if (creditAvailable > 0) must("adding credits", await cloud.run(addCredits({ organizationId, amount: creditAvailable, requestKey: `setup-${++requests}` })));
  if (lane === "CreditsOnly") return;
  await cloud.sql(
    "INSERT INTO grants (id, organization_id, family, plan_key, effective_from, effective_until, created_at) VALUES ($1, $2, 'conformance', $3, 0, $4, 0)",
    [`grant-${organizationId}`, organizationId, lane === "Refused" ? "unknown_plan" : "pro_monthly", periodEnd]
  );
  if (lane === "Refused") return;
  const period = `period-${organizationId}`;
  const columns = (status: string) => () => ({ organization_id: organizationId, status, period_start: 0, period_end: periodEnd, updated_at: 0 });
  const opened = must("opening the allowance period", await cloud.run(within((tx) => stepRow(tx, periodRows, period, { type: "openRenewal", invoiceId: "conformance", planKey: "ProMonthly", startsAt: 0, endsAt: periodEnd }, columns("open")))));
  if (opened.state.available < allowanceAvailable) throw new Error(`no plan includes an allowance of ${allowanceAvailable}`);
  const spent = opened.state.available - allowanceAvailable;
  if (spent > 0) {
    must("spending the allowance", await cloud.run(within((tx) => Effect.flatMap(
      stepRow(tx, periodRows, period, { type: "reserveHold", amount: spent, now: 0 }, columns("open")),
      () => stepRow(tx, periodRows, period, { type: "settleHold", held: spent, used: spent, now: 0 }, columns("open"))
    ))));
  }
}

async function freeCredits(key: string, creditFree: number) {
  const organizationId = owner(key).organizationId;
  const funds = must("reading funds", await cloud.run(within((tx) => readFunds(tx, organizationId, false))));
  const free = funds.creditBalance - funds.creditHeld;
  if (creditFree > free) must("adding credits", await cloud.run(addCredits({ organizationId, amount: creditFree - free, requestKey: `free-${++requests}` })));
  if (creditFree < free) must("holding credits for another call", await cloud.run(within((tx) => stepFunds(tx, organizationId, { type: "holdCredits", fromCredits: free - creditFree }, 0, `other-${++requests}`))));
}

const observeHold = async (key: string): Promise<Hold> =>
  holds.has(key) ? must("reading the hold", await cloud.run(within((tx) => loadRow(tx, holdRows, rendered(key), false)))).state : holdRows.initial;

async function settleOnce(key: string, settlement: Settlement) {
  const before = JSON.stringify(await observeHold(key));
  const done = await cloud.run(settle(rendered(key), settlement));
  if (done.kind === "failed") return refusedWhen(done, ["Rejected", "HoldUnknown"]);
  return JSON.stringify(done.value) === before ? "refused" : "accepted";
}

async function dispatch(key: string, event: Event) {
  switch (event.type) {
    case "reserve": {
      const known = holds.get(key);
      if (known === undefined) {
        const organizationId = event.key.caller || `org-${key}`;
        organizations.set(key, organizationId);
        await cloud.sql("INSERT INTO organizations (id, name, created_at) VALUES ($1, $1, 0) ON CONFLICT (id) DO NOTHING", [organizationId]);
        await fundOrganization(key, event.lane, event.allowanceAvailable, event.creditAvailable);
      }
      cloud.at(event.now);
      const done = await cloud.run(reserve(owner(key), known?.key ?? event.key, event.quote));
      if (done.kind === "failed") return refusedWhen(done, ["Refused", "Rejected"]);
      holds.set(key, { key: known?.key ?? event.key, rendered: done.value.key });
      return done.value.replayed ? "refused" : "accepted";
    }
    case "markDispatched": {
      cloud.at(event.now);
      const done = await cloud.run(markDispatched(rendered(key)));
      return done.kind === "done" ? "accepted" : refusedWhen(done, ["Rejected", "HoldUnknown"]);
    }
    case "settleKnown": {
      if (holds.has(key)) await freeCredits(key, event.creditFree);
      return settleOnce(key, { kind: "known", actual: event.actual });
    }
    case "settleUnknown":
      return settleOnce(key, { kind: "unknown" });
    case "release":
      return settleOnce(key, { kind: "release" });
    case "sweep": {
      const before = JSON.stringify(await observeHold(key));
      cloud.at(event.now);
      must("sweeping", await cloud.run(sweepHolds()));
      return JSON.stringify(await observeHold(key)) === before ? "refused" : "accepted";
    }
    default: {
      const unknown: never = event;
      throw new Error(`not a metering event: ${JSON.stringify(unknown)}`);
    }
  }
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    organizations.clear();
    holds.clear();
    await cloud.reset(options.keys?.map((key) => `org-${key}`) ?? []);
  },
  dispatch,
  observe: observeHold,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
