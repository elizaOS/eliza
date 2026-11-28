// spec/cloud/billing/checkout.md, "Story: Subscribe once, whichever screen or payer finishes it"
import type { Driver, Options } from "../../gen/cloud__billing__checkout.conformance.ts";
import type { Checkout, Event } from "../../gen/cloud__billing__checkout.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import { checkoutAt, emptyCheckout, loadCheckout, stepCheckoutRow } from "../../src/billing/checkout.vibe";
import { receiptOwner } from "../../src/shared/dispatch-once.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const beforeStart = new Map<string, number>();
const emitted = new Map<string, unknown>();
const fallback = receiptOwner("org1", "user1", "CheckoutSession");
const organization = (key: string) => `org-${key}`;
const commandKey = (key: string) => `checkout-${key}`;

async function observe(key: string): Promise<Checkout> {
  const done = await cloud.run(within((tx) => loadCheckout(tx, commandKey(key), false)));
  if (done.kind === "failed") throw new Error(`reading the checkout failed with ${done.tag}`, { cause: done.error });
  return done.value === undefined ? checkoutAt(emptyCheckout, beforeStart.get(key) ?? 0) : done.value.state;
}

async function dispatch(key: string, event: Event, by?: unknown): Promise<"accepted" | "refused"> {
  const current = await observe(key);
  const now = current.receipt.session.now;
  const sender = (by ?? fallback) as SessionOwner;
  const fixed = event.type === "start"
    ? {
        organization_id: organization(key),
        user_id: sender.actorId,
        idempotency_key: `idem-${key}`,
        digest: event.digest,
        created_at: now,
      }
    : undefined;
  const done = await cloud.run(within((tx) => stepCheckoutRow(tx, commandKey(key), { event, by: sender, now }, fixed)));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") {
    if (done.value.state.phase === "NotStarted") beforeStart.set(key, done.value.state.receipt.session.now);
    return "accepted";
  }
  if (done.tag === "Rejected") return "refused";
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    beforeStart.clear();
    emitted.clear();
    await cloud.reset(options.keys?.map(organization) ?? []);
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
