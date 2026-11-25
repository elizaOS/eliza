// spec/cloud/billing/allowance.md, "Story: Spend my plan's allowance before my credits, and never carry it over"; spec/cloud/billing/allowance.md, "Story: Get more allowance when I upgrade mid-period"; spec/cloud/billing/allowance.md, "Story: Lose the allowance of a refunded invoice, and get it back if I win the dispute"
import { ConfigProvider, Effect, Layer } from "effect";
import type { Driver, Options } from "../../gen/cloud__billing__allowance.conformance.ts";
import type { Event, Period } from "../../gen/cloud__billing__allowance.ts";
import { adjustForUpgrade, changeInvoiceAllowance, closePeriods, grantMonthKey, openGrantMonth, openRenewal, sweepAllowance, type Closing, type PeriodStep } from "../../src/billing/allowance.vibe";
import { InvalidAllowancePeriod, renewalKey } from "../../src/billing/stripe-ledger.vibe";
import { Deployment, deploymentLayer, parseProfile } from "@elizaos/cloud";
import { periodRows, stepPeriod } from "../../src/shared/metering.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import type { Store, Tx } from "../../src/store/connection.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";
import { secrets, testProfile } from "../support/profile.ts";

const cloud = ledger();
const environment = "staging";
const periods = new Map<string, string>();
let deployment: Promise<Layer.Layer<Deployment>> | undefined;

const organization = (key: string) => `org-${key}`;

async function run<A, E>(program: Effect.Effect<A, E, Store | Deployment>): Promise<Settled<A>> {
  deployment ??= Effect.runPromise(Effect.map(parseProfile(testProfile("http://127.0.0.1:9")), (profile) =>
    deploymentLayer(profile, environment).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets }))))));
  return cloud.run(Effect.provide(program, await deployment));
}

const deployed = <A, E>(body: (tx: Tx) => Effect.Effect<A, E, Deployment>) => Effect.gen(function* () {
  const settings = yield* Deployment;
  return yield* within((tx) => Effect.provideService(body(tx), Deployment, settings));
});

const must = <A>(what: string, done: Settled<A>): A => {
  if (done.kind === "failed") throw new Error(`${what} failed with ${done.tag}`, { cause: done.error });
  return done.value;
};

const moved = (what: string, done: Settled<PeriodStep | ReadonlyArray<PeriodStep>>): "accepted" | "refused" => {
  const value = must(what, done);
  return ("moved" in value ? value.moved : value.length > 0) ? "accepted" : "refused";
};

async function observe(key: string): Promise<Period> {
  const period = periods.get(key);
  if (period === undefined) return periodRows.initial;
  return must("reading the period", await cloud.run(within((tx) => loadRow(tx, periodRows, period, false)))).state;
}

async function opened(key: string, period: string, open: () => Promise<"accepted" | "refused">) {
  const known = periods.get(key);
  if (known !== undefined && known !== period) return "refused";
  const outcome = await open();
  if (outcome === "accepted") periods.set(key, period);
  return outcome;
}

const invoiceOf = (period: Period) => period.source.tag === "RenewalInvoice" ? period.source.invoiceId : "no-invoice";

function closingOf(period: Period, reason: Extract<Event, { type: "close" }>): Closing {
  switch (reason.closeReason) {
    case "SubscriptionEnded": return { kind: "SubscriptionEnded" };
    case "SupersededByPaid": return { kind: "SupersededByPaid" };
    case "GrantRevoked": return { kind: "GrantRevoked", grantId: period.source.tag === "GrantMonth" ? period.source.grantId : "no-grant" };
    default: {
      const unknown: never = reason.closeReason;
      throw new Error(`not a close reason: ${String(unknown)}`);
    }
  }
}

async function dispatch(key: string, event: Event): Promise<"accepted" | "refused"> {
  const organizationId = organization(key);
  const period = await observe(key);
  switch (event.type) {
    case "openRenewal": {
      const row = renewalKey(environment, event.invoiceId);
      return opened(key, row, async () => {
        const result = await run(deployed((tx) => openRenewal(tx, organizationId, event, 0)));
        if (result.kind === "failed" && result.error instanceof InvalidAllowancePeriod && result.error.key === row &&
            period.source.tag === "RenewalInvoice" && period.source.invoiceId === event.invoiceId &&
            (period.startsAt !== event.startsAt || period.endsAt !== event.endsAt)) return "refused";
        return moved("opening a period", result);
      });
    }
    case "openGrantMonth":
      return opened(key, grantMonthKey(event.grantId, event.month), async () => moved("opening a period", await run(
        within((tx) => openGrantMonth(tx, organizationId, { id: event.grantId, planKey: event.planKey }, event, 0)),
      )));
    case "reserveHold":
    case "settleHold": {
      const done = await cloud.run(within((tx) => stepPeriod(tx, periods.get(key) ?? `none/${key}`, event, event.now)));
      if (done.kind === "failed" && done.tag === "Rejected") return "refused";
      must(event.type, done);
      return "accepted";
    }
    case "expire": {
      cloud.at(event.now);
      must("sweeping", await run(sweepAllowance()));
      return JSON.stringify(await observe(key)) === JSON.stringify(period) ? "refused" : "accepted";
    }
    case "close":
      return moved("closing", await run(within((tx) => closePeriods(tx, organizationId, closingOf(period, event), 0))));
    case "adjustForUpgrade":
      return moved("adjusting for an upgrade", await run(within((tx) => adjustForUpgrade(tx, organizationId, event.target, event.effectiveAt, event.reviewed, event.now))));
    case "clawBack":
    case "restore":
      return moved(event.type, await run(deployed((tx) => changeInvoiceAllowance(tx, { organizationId, invoiceId: invoiceOf(period) }, event,
        event.type === "restore" ? event.now : 0))));
    default: {
      const unknown: never = event;
      throw new Error(`not an allowance event: ${JSON.stringify(unknown)}`);
    }
  }
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    periods.clear();
    await cloud.reset(options.keys?.map(organization) ?? []);
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
