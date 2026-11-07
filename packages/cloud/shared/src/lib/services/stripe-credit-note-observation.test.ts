/** Actual SDK requests, controlled Acacia responses; no provider mutation or grant authority. */
import { expect, test } from "bun:test";
import { fixture, line, note, scope } from "./stripe-credit-note.fixture";
import { retrieveInvoiceCreditNotes } from "./stripe-credit-note-observation";

test("reads every note and line twice through pinned read-only SDK requests", async () => {
  const f = fixture();
  const result = await f.observe();
  expect(result.kind).toBe("invoice_credit_note_observation");
  expect(result.providerAccountId).toBe(scope.providerAccountId);
  expect(result.notes.map((value) => [value.id, value.lines.length])).toEqual([
    ["cn_latest", 2],
    ["cn_older", 1],
  ]);
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.state.rounds).toBe(2);
  expect(f.requests.filter((request) => request.url.pathname === "/v1/credit_notes")).toHaveLength(
    4,
  );
  expect(f.requests.filter((request) => request.url.pathname.endsWith("/lines"))).toHaveLength(6);
  for (const request of f.requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("stripe-version")).toBe("2024-11-20.acacia");
    expect(request.headers.has("idempotency-key")).toBe(false);
    expect(request.headers.has("stripe-account")).toBe(false);
    if (request.url.pathname === "/v1/credit_notes") {
      expect(request.url.searchParams.get("invoice")).toBe("in_original");
      expect(request.url.searchParams.get("limit")).toBe("100");
    }
  }
  const text = JSON.stringify(result);
  for (const privateValue of [
    "private",
    "memo",
    "metadata",
    "description",
    "pdf",
    "customer_email",
  ])
    expect(text).not.toContain(privateValue);
});

test("retains issued post-payment and voided notes without treating them as grants", async () => {
  const f = fixture();
  f.state.notes[0]!.type = "post_payment";
  f.state.notes[0]!.refund = "re_original";
  f.state.notes[1]!.status = "void";
  f.state.notes[1]!.voided_at = 1700000100;
  f.state.invoice.pre_payment_credit_notes_amount = 0;
  f.state.invoice.post_payment_credit_notes_amount = 300;
  const result = await f.observe();
  expect(result.notes[0]!.refund).toBe("re_original");
  expect(result.notes[1]!.status).toBe("void");
  expect(result).not.toHaveProperty("settled");
  expect(result).not.toHaveProperty("allowance");
});

test("empty complete history is allowed only with matching zero invoice counters", async () => {
  const f = fixture();
  f.state.notes = [];
  f.state.invoice.pre_payment_credit_notes_amount = 0;
  expect((await f.observe()).notes).toEqual([]);
  f.state.invoice.post_payment_credit_notes_amount = 1;
  await expect(f.observe()).rejects.toThrow();
});

const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "wrong merchant",
    (f) => {
      f.state.accountId = "acct_other";
    },
  ],
  [
    "wrong invoice customer",
    (f) => {
      f.state.invoice.customer = "cus_other";
    },
  ],
  [
    "foreign note invoice",
    (f) => {
      f.state.notes[1]!.invoice = "in_other";
    },
  ],
  [
    "foreign note customer",
    (f) => {
      f.state.notes[1]!.customer = "cus_other";
    },
  ],
  [
    "foreign mode",
    (f) => {
      f.state.notes[1]!.livemode = true;
    },
  ],
  [
    "foreign currency",
    (f) => {
      f.state.notes[1]!.currency = "eur";
    },
  ],
  [
    "foreign line",
    (f) => {
      f.state.notes[0]!.lines[1]!.invoice_line_item = "il_other";
    },
  ],
  [
    "foreign line mode",
    (f) => {
      f.state.notes[0]!.lines[1]!.livemode = true;
    },
  ],
  [
    "custom allocation",
    (f) => {
      f.state.notes[0]!.lines[1]!.type = "custom_line_item";
    },
  ],
  [
    "unsafe money",
    (f) => {
      f.state.notes[1]!.total = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "missing lines",
    (f) => {
      f.state.notes[1]!.lines = [];
    },
  ],
  [
    "duplicate note cursor",
    (f) => {
      f.state.notes[1]!.id = f.state.notes[0]!.id;
    },
  ],
  [
    "duplicate line cursor",
    (f) => {
      f.state.notes[0]!.lines[1]!.id = "cnli_one";
    },
  ],
  [
    "line repeated across notes",
    (f) => {
      f.state.notes[1]!.lines[0]!.id = "cnli_one";
    },
  ],
  [
    "issued with void timestamp",
    (f) => {
      f.state.notes[1]!.voided_at = 1700000100;
    },
  ],
  [
    "void without timestamp",
    (f) => {
      f.state.notes[1]!.status = "void";
    },
  ],
  [
    "invoice counter mismatch",
    (f) => {
      f.state.invoice.pre_payment_credit_notes_amount--;
    },
  ],
  [
    "shipping allocation",
    (f) => {
      f.state.notes[1]!.amount_shipping = 100;
    },
  ],
];
for (const [name, change] of changes)
  test(`rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await expect(f.observe()).rejects.toThrow();
  });

test("detects voiding an older note even when list head is unchanged", async () => {
  const f = fixture();
  f.before(() => {
    if (f.state.rounds === 2) {
      f.state.notes[1]!.status = "void";
      f.state.notes[1]!.voided_at = 1700000100;
    }
  });
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_observation_changed" },
  });
});

test("detects changes beyond embedded line preview and changes to the invoice", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.notes[0]!.lines[1]!.amount = 201;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.invoice.amount_remaining = 1;
    },
  ]) {
    const f = fixture();
    f.before(() => {
      if (f.state.rounds === 2) change(f);
    });
    await expect(f.observe()).rejects.toMatchObject({
      context: { reason: "credit_note_observation_changed" },
    });
  }
});

test("rechecks merchant after note traversal", async () => {
  const f = fixture();
  f.before(() => {
    if (f.state.rounds === 2) f.state.accountId = "acct_other";
  });
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_merchant_mismatch" },
  });
});

test("does not leak private provider errors or retry a failed read", async () => {
  const f = fixture();
  f.before(() => {
    throw new Error("private customer token");
  });
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_provider_read_failed" },
  });
  expect(f.requests).toHaveLength(1);
});

test("rejects an empty nonterminal page and incomplete line preview", async () => {
  const f = fixture();
  f.respond((request, body) =>
    request.url.pathname === "/v1/credit_notes"
      ? { object: "list", data: [], has_more: true }
      : body,
  );
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "empty_nonterminal_credit_note_page" },
  });
  const g = fixture();
  g.respond((request, body) => {
    if (request.url.pathname !== "/v1/credit_notes") return body;
    const copy = structuredClone(body) as { data: Array<{ lines: { has_more: boolean } }> };
    for (const value of copy.data) value.lines.has_more = false;
    return copy;
  });
  await expect(g.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_embedded_lines_changed" },
  });
});

test("fails explicitly at the page bound instead of returning partial history", async () => {
  const f = fixture();
  f.state.notes = Array.from({ length: 101 }, (_, i) => note(`cn_${i}`, [line(`cnli_${i}`, 1)]));
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_page_limit" },
  });
  expect(f.requests.filter((request) => request.url.pathname === "/v1/credit_notes")).toHaveLength(
    100,
  );
});

test("invalid retained scope fails before any provider access", async () => {
  const f = fixture();
  await expect(
    retrieveInvoiceCreditNotes(
      { ...scope, invoiceLineIds: ["il_original", "il_original"] },
      f.stripe,
    ),
  ).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

test("preserves SDK decimal precision and recognized pretax references", async () => {
  const f = fixture();
  f.respond((_request, body) => {
    const copy = structuredClone(body);
    function decorate(value: unknown) {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.object === "credit_note_line_item") {
        record.unit_amount = null;
        record.unit_amount_decimal = "9007199254740993.000000000001";
        record.pretax_credit_amounts = [
          {
            type: "credit_balance_transaction",
            amount: 10,
            credit_balance_transaction: { id: "cbtxn_test_original" },
          },
        ];
      }
      for (const child of Object.values(record)) decorate(child);
    }
    decorate(copy);
    return copy;
  });
  const result = await f.observe();
  expect(result.notes[0]!.lines[0]!.unit_amount_decimal).toBe("9007199254740993.000000000001");
  expect(result.notes[0]!.lines[0]!.pretax_credit_amounts).toEqual([
    {
      type: "credit_balance_transaction",
      amount: 10,
      credit_balance_transaction: "cbtxn_test_original",
    },
  ]);
});

test("stable list reordering does not change normalized observations", async () => {
  const f = fixture();
  const first = await f.observe();
  f.state.notes.reverse();
  f.state.notes[1]!.lines.reverse();
  expect((await f.observe()).digest).toBe(first.digest);
});

test("new notes between scans cannot hide behind an unchanged invoice counter", async () => {
  const f = fixture();
  f.before((request) => {
    if (
      f.state.rounds === 2 &&
      request.url.pathname === "/v1/credit_notes" &&
      !request.url.searchParams.has("starting_after")
    )
      f.state.notes.push(note("cn_new", [line("cnli_new", 10)]));
  });
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_observation_changed" },
  });
});

test("unsafe aggregate totals cannot round into matching invoice counters", async () => {
  const f = fixture();
  f.state.notes[0]!.total = Number.MAX_SAFE_INTEGER;
  f.state.notes[1]!.total = 1;
  f.state.invoice.pre_payment_credit_notes_amount = Number.MAX_SAFE_INTEGER;
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_invoice_totals_mismatch" },
  });
});

test("limits total nested requests explicitly without accepting a partial result", async () => {
  const f = fixture();
  f.state.pageSize = 100;
  f.state.notes = Array.from({ length: 1001 }, (_, i) => note(`cn_${i}`, [line(`cnli_${i}`, 1)]));
  await expect(f.observe()).rejects.toMatchObject({
    context: { reason: "credit_note_request_limit" },
  });
  expect(f.requests).toHaveLength(2000);
}, 30_000);
