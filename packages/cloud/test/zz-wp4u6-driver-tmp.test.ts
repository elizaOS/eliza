import { describe, expect, it } from "vitest";
import * as oracle from "../gen/cloud__billing__subscriptionCommands.ts";
import { initial as noSub } from "../gen/cloud__billing__subscriptions.ts";
import type { Subscription } from "../gen/cloud__billing__subscriptions.ts";
import { driver, options } from "./drivers/cloud__billing__subscriptionCommands.ts";

const base = { ...noSub, status: "Active", subscriptionId: "sub1", customer: { tag: "PinnedCustomer", customerId: "cus1" }, periodStart: 0, periodEnd: 2592000000 } as Subscription;
const subs: Subscription[] = [{ ...base, planKey: "PlusMonthly", revision: 1 }, { ...base, planKey: "ProMonthly", revision: 2 }, { ...base, planKey: "PlusMonthly", cancelAtPeriodEnd: true, revision: 3 }];
const kinds = ["CancelCommand", "UndoCommand", "UpgradeCommand", "DowngradeCommand"] as const;
const plans = ["Free", "PlusMonthly", "ProMonthly"] as const;
const bys = [{ agentId: "org1", actorId: "user1", connector: "subscription_update" }, { agentId: "org1", actorId: "user1", connector: "subscription_schedule" }];
const events: oracle.Event[] = [];
for (const sub of subs) for (const kind of kinds) {
  for (const targetPlanKey of plans) for (const quoteId of ["", "q1"]) for (const dueNowCents of [0, 4667]) events.push({ type: "review", sub, kind, targetPlanKey, quoteId, dueNowCents, freshOwner: true });
  for (const quoteId of ["", "q1"]) for (const expectedRevision of [1, 2, 3]) events.push({ type: "confirm", sub, kind, commandId: "cmd1", quoteId, expectedRevision, digest: "d1", freshOwner: true });
}
for (const claimToken of [0, 1, 2]) events.push({ type: "send", claimToken });
for (const reply of [{ tag: "ShowsEffect" }, { tag: "DefiniteRefusal", cause: "NotFoundAtProvider" }, { tag: "DefiniteRefusal", cause: "AuthorizationLost" }, { tag: "Unclear" }] as const) events.push({ type: "receiveReply", reply });
events.push({ type: "loseExecutor" });
for (const lookup of [{ tag: "EffectSeen" }, { tag: "RefusalSeen", cause: "AuthorizationLost" }, { tag: "NothingSeen" }] as const) events.push({ type: "resolve", lookup });
for (const elapsed of [1000, 60000, 300000, 600000]) events.push({ type: "elapse", elapsed });
for (const invoice of ["NoUpgradeInvoice", "UpgradeInvoicePaid", "UpgradeInvoiceOpen", "UpgradeInvoiceVoided"] as const) for (const resultRevision of [0, 1, 2, 3, 4]) events.push({ type: "finish", invoice, resultRevision });

let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

describe("subscription commands driver", () => {
  it("matches the oracle on random walks", async () => {
    const key = options.keys![0];
    let accepted = 0;
    const phases = new Set<string>();
    for (let walk = 0; walk < 40; walk++) {
      await driver.reset();
      let state = oracle.initial;
      for (let step = 0; step < 30; step++) {
        const by = bys[Math.floor(random() * bys.length)];
        const allowed = events.filter((e) => oracle.enabled(state, e, by));
        const pool = allowed.length && random() < 0.85 ? allowed : events;
        const event = pool[Math.floor(random() * pool.length)];
        const expected = oracle.enabled(state, event, by);
        const outcome = await driver.dispatch(key, event, by);
        expect([walk, step, event.type, outcome]).toEqual([walk, step, event.type, expected ? "accepted" : "refused"]);
        if (expected) { state = oracle.step(state, event, by).state; accepted++; phases.add(`${state.kind}/${state.phase}/${state.receipt.settlement}`); }
        expect(await driver.observe(key)).toEqual(state);
      }
    }
    console.log(accepted, [...phases].sort().join(" "));
  }, 600_000);
});
