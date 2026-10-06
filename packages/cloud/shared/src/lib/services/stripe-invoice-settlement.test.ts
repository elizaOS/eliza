/** Complete customer ledger traversal must not mistake missing pages or a new reversal for settlement. */
import { expect, test } from "bun:test";
import { retrieveInvoiceBalanceHistory as retrieve } from "./stripe-invoice-settlement";

const row = (id: string) => ({
  id,
  object: "customer_balance_transaction",
  customer: "cus_owner",
  invoice: "in_owner",
  livemode: false,
  currency: "usd",
  amount: 500,
  ending_balance: 0,
  created: 1700000000,
  type: "applied_to_invoice",
  credit_note: null,
});
const page = (data: ReturnType<typeof row>[], has_more = false) => ({
  object: "list",
  data,
  has_more,
});
test("reads every page under the same customer and verifies the immutable head", async () => {
  const calls: unknown[] = [],
    pages = [
      page([row("cbtxn_latest")], true),
      page([row("cbtxn_oldest")]),
      page([row("cbtxn_latest")]),
    ];
  const result = await retrieve("cus_owner", false, async (...args) => {
    calls.push(args);
    return pages.shift();
  });
  expect(result.data.map((r) => r.id)).toEqual(["cbtxn_latest", "cbtxn_oldest"]);
  expect(calls).toEqual([
    ["cus_owner", { limit: 100 }],
    ["cus_owner", { limit: 100, starting_after: "cbtxn_latest" }],
    ["cus_owner", { limit: 1 }],
  ]);
});
for (const [name, pages] of [
  ["empty nonterminal page", [page([], true)]],
  ["duplicate cursor", [page([row("cbtxn_one")], true), page([row("cbtxn_one")])]],
  ["foreign customer", [page([{ ...row("cbtxn_one"), customer: "cus_other" }])]],
  ["foreign mode", [page([{ ...row("cbtxn_one"), livemode: true }])]],
  ["changed head", [page([row("cbtxn_one")]), page([row("cbtxn_new")])]],
  ["changed evidence", [page([row("cbtxn_one")]), page([{ ...row("cbtxn_one"), amount: 400 }])]],
  ["malformed page", [{ object: "list", data: [], has_more: "false" }]],
] as const)
  test(`rejects ${name}`, async () => {
    let index = 0;
    await expect(retrieve("cus_owner", false, async () => pages[index++])).rejects.toThrow();
  });
test("scan limit rejects explicitly instead of returning incomplete history", async () => {
  let index = 0;
  await expect(
    retrieve("cus_owner", false, async () => page([row(`cbtxn_${++index}`)], true)),
  ).rejects.toThrow();
  expect(index).toBe(100);
});
