// spec/cloud/billing/subscriptionCommands.md, "Story: Change or cancel my plan without paying twice"; spec/cloud/billing/subscriptionCommands.md, "Story: Get the plan I paid for"
import type { Driver, Options } from "../../gen/cloud__billing__subscriptionCommands.conformance.ts";
import type { Command, Event } from "../../gen/cloud__billing__subscriptionCommands.ts";
import type { Subscription, SubscriptionStatus } from "../../gen/cloud__billing__subscriptions.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import { commandRows, stepCommand } from "../../src/billing/commands.vibe";
import { wirePlanKey } from "../../src/billing/plans.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const keys = ["command-1"];
const fallback: SessionOwner = { agentId: "org1", actorId: "user1", connector: "subscription_update" };
const organization = (key: string) => `org-${key}`;
const wireStatus: Readonly<Record<SubscriptionStatus, string>> = {
  NoSubscription: "none", Pending: "pending", Incomplete: "incomplete", Active: "active", Dunning: "dunning",
  PastDue: "past_due", Unpaid: "unpaid", Canceled: "canceled", IncompleteExpired: "incomplete_expired",
};

async function observe(key: string): Promise<Command> {
  const done = await cloud.run(within((tx) => loadRow(tx, commandRows, key, false)));
  if (done.kind === "failed") throw new Error(`reading the command failed with ${done.tag}`, { cause: done.error });
  return done.value.state;
}

async function holdSubscription(key: string, sub: Subscription) {
  await cloud.sql(
    `INSERT INTO subscriptions (key, state, revision, status, plan_key, customer_id, provider_subscription_id, updated_at) VALUES ($1, $2::jsonb, 1, $3, $4, $5, $6, 0)
     ON CONFLICT (key) DO UPDATE SET state = excluded.state, revision = subscriptions.revision + 1, status = excluded.status, plan_key = excluded.plan_key,
       customer_id = excluded.customer_id, provider_subscription_id = excluded.provider_subscription_id`,
    [organization(key), JSON.stringify(sub), wireStatus[sub.status], wirePlanKey(sub.planKey), sub.customer.tag === "PinnedCustomer" ? sub.customer.customerId : null, sub.subscriptionId || null],
  );
}

const isCommandRefusal = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "state" in error && typeof error.state === "object" && error.state !== null && "receipt" in error.state;

export const driver: Driver = {
  async reset() {
    await cloud.reset(keys.map(organization));
  },
  async dispatch(key, event: Event, by) {
    const owner = (by ?? fallback) as SessionOwner;
    const current = await observe(key);
    if (event.type === "confirm" && (current.phase === "NoCommand" || current.phase === "Quoted")) await holdSubscription(key, event.sub);
    const done = await cloud.run(within((tx) => stepCommand(tx, key, organization(key), { event, by: owner, now: current.receipt.session.now })));
    if (done.kind === "done") return "accepted";
    if (done.tag === "Rejected" && isCommandRefusal(done.error)) return "refused";
    throw new Error(`the command store failed with ${done.tag}`, { cause: done.error });
  },
  observe,
};

export const options: Options = { keys, walks: 20, steps: 25 };
