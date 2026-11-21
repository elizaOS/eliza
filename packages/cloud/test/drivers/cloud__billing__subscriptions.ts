// spec/cloud/billing/subscriptions.md, "Story: Keep my plan as the provider says it is"; spec/cloud/billing/subscriptions.md, "Story: Change my plan one command at a time"
import type { Driver, Options } from "../../gen/cloud__billing__subscriptions.conformance.ts";
import type { Subscription } from "../../gen/cloud__billing__subscriptions.ts";
import { readSubscription, sendSubscription } from "../../src/billing/subscriptions.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const organization = (key: string) => `org-${key}`;

export const driver: Driver & AsyncDisposable = {
  reset: () => cloud.reset(options.keys?.map(organization) ?? []),
  async dispatch(key, event) {
    const done = await cloud.run(within((tx) => sendSubscription(tx, organization(key), event, "now" in event ? event.now : 0)));
    if (done.kind === "done") return "accepted";
    if (done.tag === "Rejected") return "refused";
    throw new Error(`the subscription store failed with ${done.tag}`, { cause: done.error });
  },
  async observe(key): Promise<Subscription> {
    const done = await cloud.run(within((tx) => readSubscription(tx, organization(key))));
    if (done.kind === "failed") throw new Error(`reading the subscription failed with ${done.tag}`, { cause: done.error });
    return done.value;
  },
  [Symbol.asyncDispose]: () => cloud.dispose(),
};

export const options: Options = { keys: ["a"] };
