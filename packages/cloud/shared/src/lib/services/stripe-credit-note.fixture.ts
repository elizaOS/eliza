/** Controlled provider fixtures shared by note and disposition observation tests. */
import Stripe from "stripe";
import { retrieveInvoiceCreditNotes } from "./stripe-credit-note-observation";

export const scope = {
  providerAccountId: "acct_owner",
  invoiceId: "in_original",
  customerId: "cus_owner",
  livemode: false,
  currency: "usd",
  invoiceLineIds: ["il_original"],
};
export function line(id: string, amount: number) {
  return {
    id,
    object: "credit_note_line_item",
    type: "invoice_line_item",
    invoice_line_item: "il_original",
    livemode: false,
    amount,
    amount_excluding_tax: amount,
    discount_amount: 0,
    discount_amounts: [],
    quantity: 1,
    tax_amounts: [],
    tax_rates: [],
    unit_amount: amount,
    unit_amount_decimal: String(amount),
    unit_amount_excluding_tax: String(amount),
    description: "private line description",
  };
}
export function note(id: string, lines: ReturnType<typeof line>[]) {
  const total = lines.reduce((sum, item) => sum + item.amount, 0);
  return {
    id,
    object: "credit_note",
    invoice: "in_original",
    customer: "cus_owner",
    livemode: false,
    currency: "usd",
    type: "pre_payment",
    status: "issued",
    reason: null,
    created: 1700000000,
    effective_at: null as number | null,
    voided_at: null as number | null,
    amount: total,
    amount_shipping: 0,
    shipping_cost: null,
    discount_amount: 0,
    discount_amounts: [],
    subtotal: total,
    subtotal_excluding_tax: total,
    tax_amounts: [],
    total,
    total_excluding_tax: total,
    out_of_band_amount: null as number | null,
    customer_balance_transaction: null as string | null,
    refund: null as string | null,
    memo: "private note memo",
    metadata: { secret: "private metadata" },
    pdf: "https://example.test/private-pdf",
    lines,
  };
}
export type Request = { url: URL; headers: Headers; method: string };
export function fixture() {
  const state = {
    accountId: "acct_owner",
    invoice: {
      id: "in_original",
      object: "invoice",
      customer: "cus_owner",
      livemode: false,
      currency: "usd",
      status: "paid",
      total: 1000,
      amount_due: 600,
      amount_paid: 600,
      amount_remaining: 0,
      starting_balance: 0,
      ending_balance: 0,
      pre_payment_credit_notes_amount: 400,
      post_payment_credit_notes_amount: 0,
      customer_email: "private@example.test",
    },
    notes: [
      note("cn_latest", [line("cnli_one", 100), line("cnli_two", 200)]),
      note("cn_older", [line("cnli_three", 100)]),
    ],
    pageSize: 1,
    rounds: 0,
  };
  const requests: Request[] = [];
  let route: ((request: Request) => unknown) | undefined;
  let onRequest: ((request: Request) => void) | undefined;
  let responseOverride: ((request: Request, body: unknown) => unknown) | undefined;
  function page<T extends { id: string }>(rows: T[], url: URL) {
    const cursor = url.searchParams.get("starting_after");
    const start = cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
    const end = start + state.pageSize;
    return { object: "list", data: rows.slice(start, end), has_more: end < rows.length };
  }
  const stripe = new Stripe("sk_test_credit_note_fixture", {
    // Deliberately nonzero to prove each observer request overrides retries.
    maxNetworkRetries: 2,
    httpClient: Stripe.createFetchHttpClient(async (input, init) => {
      const request = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      };
      requests.push(request);
      const { url } = request;
      if (url.pathname === "/v1/credit_notes" && !url.searchParams.has("starting_after"))
        state.rounds++;
      onRequest?.(request);
      let body: unknown = route?.(request);
      if (body !== undefined) {
        /* Explicit additional controlled provider endpoint. */
      } else if (url.pathname === "/v1/account") body = { id: state.accountId, object: "account" };
      else if (url.pathname === "/v1/invoices/in_original") body = state.invoice;
      else if (url.pathname === "/v1/credit_notes") {
        body = page(
          state.notes.map(({ lines, ...value }) => ({
            ...value,
            lines: { object: "list", data: lines.slice(0, 1), has_more: lines.length > 1 },
          })),
          url,
        );
      } else {
        const match = /^\/v1\/credit_notes\/(cn_[A-Za-z0-9_]+)\/lines$/.exec(url.pathname);
        const selected = state.notes.find((value) => value.id === match?.[1]);
        if (!selected) throw new Error("Unexpected controlled credit-note request");
        body = page(selected.lines, url);
      }
      return Response.json(responseOverride ? responseOverride(request, body) : body, {
        headers: { "request-id": "req_credit_note_fixture" },
      });
    }),
  });
  return {
    state,
    requests,
    observe: () => retrieveInvoiceCreditNotes(scope, stripe),
    stripe,
    route: (handler: typeof route) => {
      route = handler;
    },
    before: (hook: typeof onRequest) => {
      onRequest = hook;
    },
    respond: (hook: typeof responseOverride) => {
      responseOverride = hook;
    },
  };
}
