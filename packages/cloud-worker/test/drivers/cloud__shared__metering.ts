// spec/cloud/shared/metering.md, "Story: Never overdraw an account"; spec/cloud/shared/metering.md, "Story: Settle every call once"
import { deploymentLayer, parseProfile } from "@elizaos/cloud";
import { ConfigProvider, Effect, Layer } from "effect";
import type { Driver, Options } from "../../gen/cloud__shared__metering.conformance.ts";
import type { Event, FundingLane, Hold } from "../../gen/cloud__shared__metering.ts";
import type { HoldKey } from "../../gen/cloud__shared__types.ts";
import { addCredits, fundsRows, readFunds, stepFunds } from "../../src/billing/funds.vibe";
import { assignSponsoredGrant } from "../../src/billing/grant-codes.vibe";
import { laneFor } from "../../src/billing/policy.vibe";
import { stepAccount } from "../../src/identity/accounts.vibe";
import { holdRows, markDispatched, periodRows, reserve, settle, sweepHolds, type Settlement } from "../../src/shared/metering.vibe";
import { loadRow, stepRow } from "../../src/store/rows.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";
import { secrets, testProfile } from "../support/profile.ts";

const cloud = ledger();
const periodEnd = 10 ** 13;
const holds = new Map<string, { readonly key: HoldKey; readonly physicalKey: string }>();
const sponsorshipDeployment = Layer.unwrap(Effect.map(parseProfile(testProfile("https://providers.example.com")), (profile) =>
  deploymentLayer(profile, "staging")
)).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(secrets))));
let requests = 0;

const owner = (key: string) => ({ organizationId: `org-${key}`, userId: `user-${key}` });
const storedKey = (key: string) => holds.get(key)?.physicalKey ?? `org-${key}/no-hold`;

const must = <A>(what: string, done: Settled<A>): A => {
  if (done.kind === "failed") throw new Error(`${what} failed with ${done.tag}`, { cause: done.error });
  return done.value;
};

const refusedWhen = (done: Settled<unknown>, tags: ReadonlyArray<string>): "refused" => {
  if (done.kind === "failed" && tags.includes(done.tag)) return "refused";
  throw new Error(`the cloud failed with ${done.kind === "failed" ? done.tag : "nothing"}`, { cause: done.kind === "failed" ? done.error : undefined });
};

async function sponsorInference(key: string) {
  const { organizationId, userId } = owner(key);
  const email = `conformance-${key}@gmail.com`;
  const issued = must("assigning sponsored inference", await cloud.run(within((tx) => Effect.gen(function* () {
    const existing = yield* tx.query("SELECT 1 FROM accounts WHERE key = $1", [userId]);
    if (existing.length === 0) {
      const unowned = { tag: "Unowned" } as const;
      const referralCode = key.toUpperCase().padStart(10, "0");
      yield* stepAccount(tx, userId, {
        type: "openAccount", userId, organizationId, identity: { method: "EmailSignIn", subject: email },
        verifiedEmail: true, subjectOwner: unowned, emailOwner: unowned, referralCode
      }, 0, { email, name: userId });
      yield* tx.query("INSERT INTO cloud_sign_in_identities (provider, provider_subject, account_id) VALUES ('email', $1, $2)", [email, userId]);
      yield* tx.query("INSERT INTO referral_codes (code, user_id) VALUES ($1, $2)", [referralCode, userId]);
    }
    yield* tx.query("INSERT INTO funds (key, state, revision, updated_at) VALUES ($1, $2::jsonb, 1, 0) ON CONFLICT DO NOTHING", [organizationId, JSON.stringify(fundsRows.initial)]);
    return yield* Effect.provide(assignSponsoredGrant(tx, email, `conformance-sponsor-${++requests}`, 0), sponsorshipDeployment);
  }))));
  if (issued.kind !== "active") throw new Error(`the conformance assignment was ${issued.kind}`);
}

async function fundOrganization(key: string, lane: FundingLane, allowanceAvailable: number, creditAvailable: number) {
  const organizationId = owner(key).organizationId;
  await cloud.sql("DELETE FROM grants WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM allowance_periods WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM credit_entries WHERE organization_id = $1", [organizationId]);
  await cloud.sql("DELETE FROM funds WHERE key = $1", [organizationId]);
  await cloud.sql("UPDATE organizations SET credit_balance = 0 WHERE id = $1", [organizationId]);
  if (creditAvailable > 0) must("adding credits", await cloud.run(addCredits({ organizationId, amount: creditAvailable, requestKey: `setup-${++requests}` })));
  if (lane === "CreditsOnly") return;
  if (lane === "SponsoredInference") return sponsorInference(key);
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

function logicalHold(key: string, hold: Hold): Hold {
  const traceKey = holds.get(key)?.key;
  if (traceKey === undefined) return hold;
  const expectedCaller = traceKey.service === "MeteredMaps" ? traceKey.caller : owner(key).organizationId;
  if (hold.key.caller !== expectedCaller) throw new Error(`the hold belongs to ${hold.key.caller}, expected ${expectedCaller}`);
  return { ...hold, key: { ...hold.key, caller: traceKey.caller } };
}

async function observeHold(key: string): Promise<Hold> {
  if (!holds.has(key)) return holdRows.initial;
  const row = must("reading the hold", await cloud.run(within((tx) => loadRow(tx, holdRows, storedKey(key), false))));
  if (!row.found) throw new Error("the recorded hold key no longer names a stored row");
  return logicalHold(key, row.state);
}

async function settleOnce(key: string, settlement: Settlement) {
  const before = JSON.stringify(await observeHold(key));
  const done = await cloud.run(settle(storedKey(key), settlement));
  if (done.kind === "failed") return refusedWhen(done, ["Rejected", "HoldUnknown"]);
  return JSON.stringify(logicalHold(key, done.value)) === before ? "refused" : "accepted";
}

async function dispatch(key: string, event: Event) {
  switch (event.type) {
    case "reserve": {
      const known = holds.get(key);
      if (known === undefined) await fundOrganization(key, event.lane, event.allowanceAvailable, event.creditAvailable);
      cloud.at(event.now);
      const caller = owner(key);
      if (known === undefined && event.lane === "SponsoredInference") {
        const assembled = must("reading the sponsored lane", await cloud.run(within((tx) => laneFor(tx, caller.organizationId, event.key.service, event.now))));
        if (assembled !== event.lane) return "refused";
      }
      const traceKey = known?.key ?? event.key;
      const done = await cloud.run(reserve(caller, traceKey, event.quote));
      if (done.kind === "failed") return refusedWhen(done, ["Refused", "Rejected"]);
      if (known !== undefined && done.value.key !== known.physicalKey) throw new Error("the same call returned a different hold key");
      holds.set(key, { key: traceKey, physicalKey: done.value.key });
      return done.value.replayed ? "refused" : "accepted";
    }
    case "markDispatched": {
      cloud.at(event.now);
      const done = await cloud.run(markDispatched(storedKey(key)));
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
    holds.clear();
    await cloud.reset(options.keys?.map((key) => owner(key).organizationId) ?? []);
    await cloud.sql("TRUNCATE grant_codes CASCADE");
  },
  dispatch,
  observe: observeHold,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
