// spec/cloud/billing/subscriptionCommands.md, "Story: Review a plan change before I confirm it"; spec/cloud/billing/subscriptionCommands.md, "Story: Change or cancel my plan without paying twice"; spec/cloud/billing/subscriptionCommands.md, "Story: Get the plan I paid for"
import type { Driver, Options } from "../../gen/cloud__billing__subscriptionCommands.conformance.ts";
import type { Command, Event } from "../../gen/cloud__billing__subscriptionCommands.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import { readPlanCommandState, stepPlanCommandRow } from "../../src/billing/plan-command-state.vibe";
import { receiptOwner } from "../../src/shared/dispatch-once.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const emitted = new Map<string, unknown>();
const fallback = receiptOwner("org1", "user1", "SubscriptionUpdate");
const organization = (key: string) => `org-${key}`;
const commandKey = (key: string) => `subcmd-${key}`;

async function observe(key: string): Promise<Command> {
  const done = await cloud.run(within((tx) => readPlanCommandState(tx, commandKey(key))));
  if (done.kind === "failed") throw new Error(`reading the subscription command failed with ${done.tag}`, { cause: done.error });
  return done.value;
}

async function dispatch(key: string, event: Event, by?: unknown): Promise<"accepted" | "refused"> {
  const current = await observe(key);
  const sender = (by ?? fallback) as SessionOwner;
  const done = await cloud.run(within((tx) => stepPlanCommandRow(tx, commandKey(key), organization(key), {
    event,
    by: sender,
    now: current.receipt.session.now,
  })));
  emitted.set(key, done.kind === "done" ? done.value.out : []);
  if (done.kind === "done") return "accepted";
  if (done.tag === "Rejected") return "refused";
  throw new Error(`the cloud failed with ${done.tag}`, { cause: done.error });
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

export const options: Options = { keys: ["a", "b"] };
