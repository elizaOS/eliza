import { expect, test } from "bun:test";
import { findNextRenewalInvoice as find } from "./subscription-next-invoice";

function invoice(id = "in_next", start = 200, end = 300, status = "paid") {
  return {
    id,
    object: "invoice",
    subscription: "sub_owner",
    customer: "cus_owner",
    livemode: false,
    created: 200,
    status,
    billing_reason: "subscription_cycle",
    lines: {
      has_more: false,
      data: [
        {
          type: "subscription",
          subscription: "sub_owner",
          proration: false,
          period: { start, end },
        },
      ],
    },
  };
}
function fixture(pages = [{ object: "list", has_more: false, data: [invoice()] }]) {
  const requests: unknown[] = [];
  let index = 0;
  return {
    requests,
    pages,
    input: {
      reader: {
        list: async (request: unknown, options: unknown) => {
          requests.push({ request, options });
          return pages[index++];
        },
      },
      subscriptionId: "sub_owner",
      customerId: "cus_owner",
      livemode: false,
      paidPeriodEnd: new Date(200000),
      observedAt: new Date(400000),
    },
  };
}
test("completes all pages and selects the adjacent invoice instead of the latest", async () => {
  const f = fixture([
    { object: "list", has_more: true, data: [invoice("in_new", 300, 400)] },
    { object: "list", has_more: false, data: [invoice()] },
  ]);
  expect((await find(f.input)).invoiceId).toBe("in_next");
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]).toEqual({
    request: {
      subscription: "sub_owner",
      limit: 100,
      created: { lte: 400 },
      starting_after: "in_new",
    },
    options: { apiVersion: "2024-11-20.acacia" },
  });
});
test("an early match cannot hide a conflicting later page", async () => {
  const f = fixture([
    { object: "list", has_more: true, data: [invoice()] },
    { object: "list", has_more: false, data: [invoice("in_conflict")] },
  ]);
  await expect(find(f.input)).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
});
for (const status of ["draft", "void"])
  test(`does not skip a ${status} adjacent invoice`, async () => {
    const f = fixture([
      {
        object: "list",
        has_more: false,
        data: [invoice("in_new", 300, 400), invoice("in_next", 200, 300, status)],
      },
    ]);
    await expect(find(f.input)).rejects.toThrow();
  });
const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "missing interval",
    (f) => {
      f.pages[0]!.data = [invoice("in_new", 300, 400)];
    },
  ],
  [
    "foreign customer",
    (f) => {
      f.pages[0]!.data[0]!.customer = "cus_other";
    },
  ],
  [
    "foreign subscription",
    (f) => {
      f.pages[0]!.data[0]!.subscription = "sub_other";
    },
  ],
  [
    "mode drift",
    (f) => {
      f.pages[0]!.data[0]!.livemode = true;
    },
  ],
  [
    "future creation",
    (f) => {
      f.pages[0]!.data[0]!.created = 401;
    },
  ],
  [
    "incomplete lines",
    (f) => {
      f.pages[0]!.data[0]!.lines.has_more = true;
    },
  ],
  [
    "empty continuing page",
    (f) => {
      f.pages[0]!.data = [];
      f.pages[0]!.has_more = true;
    },
  ],
  [
    "duplicate cursor",
    (f) => {
      f.pages[0]!.data.push(invoice());
    },
  ],
  [
    "overlap",
    (f) => {
      f.pages[0]!.data[0]!.lines.data[0]!.period.start = 199;
    },
  ],
  [
    "unrepresentable period",
    (f) => {
      f.pages[0]!.data[0]!.lines.data[0]!.period.end = Number.MAX_SAFE_INTEGER;
    },
  ],
  [
    "foreign recurring line",
    (f) => {
      f.pages[0]!.data[0]!.lines.data[0]!.subscription = "sub_other";
    },
  ],
  [
    "invalid clock",
    (f) => {
      f.input.observedAt = new Date(NaN);
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await expect(find(f.input)).rejects.toThrow();
  });

test("a provider failure after an early match never releases partial authority", async () => {
  let calls = 0;
  const f = fixture();
  f.input.reader.list = async () => {
    calls++;
    if (calls === 2) throw new Error("provider read deadline");
    return { object: "list", has_more: true, data: [invoice()] };
  };
  await expect(find(f.input)).rejects.toThrow("provider read deadline");
  expect(calls).toBe(2);
});

for (const status of ["open", "uncollectible"])
  test(`returns ${status} as lifecycle-only authority without skipping it`, async () => {
    const f = fixture([
      {
        object: "list",
        has_more: false,
        data: [invoice("in_new", 300, 400), invoice("in_next", 200, 300, status)],
      },
    ]);
    const next = await find(f.input);
    expect(next.invoiceId).toBe("in_next");
    expect(next.paid).toBeFalse();
  });
