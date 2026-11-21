// spec/cloud/billing/grantCodes.md, "Story: Redeem a membership code once"; spec/cloud/billing/grantCodes.md, "Story: Stop a code or a grant"
import { ConfigProvider, Effect, Layer } from "effect";
import type { Driver, Options } from "../../gen/cloud__billing__grantCodes.conformance.ts";
import type { Code, Event, Grant, RedeemAnswer } from "../../gen/cloud__billing__grantCodes.ts";
import { initial as noSubscription, type Subscription } from "../../gen/cloud__billing__subscriptions.ts";
import { codeRows, disableGrantCodes, mintGrantCodes, redeemIn, revokeGrants } from "../../src/billing/grant-codes.vibe";
import { normalizeSubscriptionCode } from "../../src/billing/grant-code.ts";
import { Refused } from "../../src/http/refusal.vibe";
import { Deployment, deploymentLayer, parseProfile } from "../../src/profile/profile.vibe";
import { keyedDigest } from "../../src/shared/sealing.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import type { Store, Tx } from "../../src/store/connection.vibe";
import { ledger, within, type Settled } from "../support/ledger.ts";
import { secrets, testProfile } from "../support/profile.ts";

const cloud = ledger();
const organizations = ["org1", "org2"];
const unknownCode = "0000000000000000";
let deployment: Promise<Layer.Layer<Deployment>> | undefined;

interface Minted {
  readonly text: string;
  readonly rowKey: string;
}

const minted = new Map<string, Minted>();
const specIds = new Map<string, Map<string, string>>();
const answers = new Map<string, RedeemAnswer>();

async function run<A, E>(program: Effect.Effect<A, E, Store | Deployment>): Promise<Settled<A>> {
  deployment ??= Effect.runPromise(Effect.map(parseProfile(testProfile("http://127.0.0.1:9")), (profile) =>
    deploymentLayer(profile, "staging").pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets }))))));
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

const idsOf = (key: string) => {
  const known = specIds.get(key) ?? new Map<string, string>();
  specIds.set(key, known);
  return known;
};

const rowKeyOf = (key: string) => minted.get(key)?.rowKey ?? `unminted/${key}`;

async function observe(key: string): Promise<Code> {
  const loaded = must("reading the code", await cloud.run(within((tx) => loadRow(tx, codeRows, rowKeyOf(key), false))));
  const ids = idsOf(key);
  const grants: Grant[] = loaded.state.grants.map((grant) => ({ ...grant, grantId: ids.get(grant.grantId) ?? grant.grantId }));
  return { ...loaded.state, grants, last: answers.get(key) ?? { tag: "NoAnswer" } };
}

async function observeRedeem(key: string, event: Extract<Event, { type: "redeem" }>) {
  const { organizationId } = event;
  const code = await observe(key);
  const holds = code.grants.some((grant) => grant.organizationId === organizationId);
  await cloud.sql("UPDATE accounts SET status = $2 WHERE organization_id = $1", [organizationId, event.accountActive ? "active" : "deleting"]);
  await cloud.sql("DELETE FROM grants WHERE organization_id = $1 AND code_key IS NULL", [organizationId]);
  await cloud.sql("DELETE FROM subscriptions WHERE key = $1", [organizationId]);
  if (event.keyUsedForAnotherCode && !holds) {
    await cloud.sql("INSERT INTO grants (id, organization_id, family, plan_key, effective_from, effective_until, created_at, idempotency_key) VALUES ($1, $2, 'another-family', 'plus_monthly', 0, 1, 0, $3)", [`keyed-${organizationId}`, organizationId, event.idempotencyKey]);
  }
  if (event.familyHeld && !holds && code.family !== "" && code.family !== "another-family") {
    await cloud.sql("INSERT INTO grants (id, organization_id, family, plan_key, effective_from, effective_until, created_at) VALUES ($1, $2, $3, 'plus_monthly', 0, 1, 0)", [`family-${organizationId}`, organizationId, code.family]);
  }
  if (event.paidPlanOpen) {
    const state: Subscription = { ...noSubscription, status: "Active", subscriptionId: `sub_${organizationId}`, customer: { tag: "PinnedCustomer", customerId: `cus_${organizationId}` }, planKey: "PlusMonthly", periodStart: 0, periodEnd: 30 * 86_400_000, revision: 1 };
    await cloud.sql("INSERT INTO subscriptions (key, state, revision, status, plan_key, customer_id, provider_subscription_id, period_end, updated_at) VALUES ($1, $2, 1, 'active', 'plus_monthly', $3, $4, $5, 0)", [organizationId, JSON.stringify(state), `cus_${organizationId}`, state.subscriptionId, state.periodEnd]);
  }
}

async function redeem(key: string, event: Extract<Event, { type: "redeem" }>): Promise<"accepted" | "refused"> {
  const ids = idsOf(key);
  if ([...ids.values()].includes(event.grantId)) return "refused";
  await observeRedeem(key, event);
  cloud.at(event.now);
  const done = await cloud.run(within((tx) => redeemIn(tx, { userId: `user-${event.organizationId}`, organizationId: event.organizationId }, rowKeyOf(key), event.idempotencyKey)));
  if (done.kind === "failed") {
    if (!(done.error instanceof Refused)) throw new Error(`redeeming failed with ${done.tag}`, { cause: done.error });
    answers.set(key, { tag: "RedeemRefused", refusal: done.error.refusal });
    return "accepted";
  }
  if (!done.value.replayed) ids.set(done.value.grant.id, event.grantId);
  answers.set(key, { tag: "Answered", organizationId: event.organizationId, grantId: ids.get(done.value.grant.id) ?? done.value.grant.id, replayed: done.value.replayed });
  return "accepted";
}

async function dispatch(key: string, event: Event): Promise<"accepted" | "refused"> {
  switch (event.type) {
    case "mint": {
      if (minted.has(key)) return "refused";
      cloud.at(0);
      const done = await run(deployed((tx) => mintGrantCodes(tx, {
        family: event.family,
        planKey: event.planKey,
        term: event.term,
        requiresNoPaidPlan: event.requiresNoPaidPlan,
        maxRedemptions: event.maxRedemptions,
        expiresAt: event.expiry.tag === "ExpiresAt" ? event.expiry.at : undefined,
        count: 1
      }, 0)));
      if (done.kind === "failed" && done.tag === "Rejected") return "refused";
      const text = must("minting", done)[0] ?? "";
      const rowKey = must("digesting", await run(keyedDigest(normalizeSubscriptionCode(text))));
      minted.set(key, { text, rowKey });
      return "accepted";
    }
    case "redeem":
      return redeem(key, event);
    case "disable": {
      const text = minted.get(key)?.text ?? unknownCode;
      const disabled = must("disabling", await run(deployed((tx) => disableGrantCodes(tx, { kind: "codes", codes: [text] }))));
      return disabled > 0 ? "accepted" : "refused";
    }
    case "revokeGrant": {
      cloud.at(event.now);
      const held = await cloud.sql("SELECT id FROM grants WHERE code_key = $1 AND organization_id = $2", [rowKeyOf(key), event.organizationId]);
      const grantId = typeof held[0]?.id === "string" ? held[0].id : "no-grant";
      const revoked = must("revoking", await run(deployed((tx) => revokeGrants(tx, { kind: "grants", grantIds: [grantId] }, "conformance"))));
      return revoked > 0 ? "accepted" : "refused";
    }
    default: {
      const unknown: never = event;
      throw new Error(`not a grant code event: ${JSON.stringify(unknown)}`);
    }
  }
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    minted.clear();
    specIds.clear();
    answers.clear();
    await cloud.reset(organizations);
    await cloud.sql("TRUNCATE grant_codes CASCADE");
    for (const organizationId of organizations) {
      await cloud.sql("INSERT INTO accounts (key, state, revision, organization_id, status, created_at, updated_at) VALUES ($1, '{}'::jsonb, 1, $2, 'active', 0, 0)", [`user-${organizationId}`, organizationId]);
    }
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
