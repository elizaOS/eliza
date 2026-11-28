// spec/cloud/billing/subscriptions.md, "Story: Keep my plan as the provider says it is"; spec/cloud/billing/subscriptions.md, "Story: Change my plan one command at a time"
import type { Driver, Options } from "../../gen/cloud__billing__subscriptions.conformance.ts";
import type { Event, Subscription } from "../../gen/cloud__billing__subscriptions.ts";
import { readSubscription, stepSubscription } from "../../src/billing/subscriptions.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const emitted = new Map<string, unknown>();
const organization = (key: string) => `org-${key}`;

async function dispatch(key: string, event: Event): Promise<"accepted" | "refused"> {
  const now = event.type === "reconcile" || event.type === "expireDunning" ? event.now : 0;
  const done = await cloud.run(within((tx) => stepSubscription(tx, organization(key), event, now)));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") return "accepted";
  if (done.tag === "Rejected") return "refused";
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
}

async function observe(key: string): Promise<Subscription> {
  const done = await cloud.run(within((tx) => readSubscription(tx, organization(key))));
  if (done.kind === "failed") throw new Error(`reading the subscription failed with ${done.tag}`, { cause: done.error });
  return done.value;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    emitted.clear();
    await cloud.reset(options.keys?.map(organization) ?? []);
  },
  dispatch,
  observe,
  observeOutput: (key) => emitted.get(key) ?? [],
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
