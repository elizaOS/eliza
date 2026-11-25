// spec/cloud/shared/dispatchOnce.md, "Story: Send a change once and recover its outcome without sending it again"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/cloud__shared__dispatchOnce.conformance.ts";
import type { Receipt } from "../../gen/cloud__shared__dispatchOnce.ts";
import type { SessionOwner } from "../../gen/core__sessions.ts";
import { loadReceipt, receiptOwner, receiptStep, receiptTable } from "../../src/shared/dispatch-once.vibe";
import { ledger, within } from "../support/ledger.ts";

const cloud = ledger();
const rows = receiptTable("conformance_receipts");
const fallback = receiptOwner("org-conformance", "user-conformance", "CheckoutSession");

const read = (key: string) => within((tx) => Effect.map(loadReceipt(tx, rows, key, false), (loaded): Receipt => loaded.state));

export const driver: Driver = {
  async reset() {
    await cloud.sql("CREATE TABLE IF NOT EXISTS conformance_receipts (key text PRIMARY KEY, state jsonb NOT NULL, revision integer NOT NULL)");
    await cloud.sql("DELETE FROM conformance_receipts");
  },
  async dispatch(key, event, by) {
    const owner = (by ?? fallback) as SessionOwner;
    const done = await cloud.run(within((tx) => Effect.flatMap(loadReceipt(tx, rows, key), (loaded) => receiptStep(tx, rows, key, { event, by: owner, now: loaded.state.session.now }))));
    if (done.kind === "done") return "accepted";
    if (done.tag === "Rejected") return "refused";
    throw new Error(`the receipt store failed with ${done.tag}`, { cause: done.error });
  },
  async observe(key) {
    const done = await cloud.run(read(key));
    if (done.kind === "failed") throw new Error(`reading the receipt failed with ${done.tag}`, { cause: done.error });
    return done.value;
  },
};

export const options: Options = { keys: ["checkout-1", "checkout-2"], walks: 20, steps: 25 };
