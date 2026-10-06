import assert from "node:assert/strict";
import test from "node:test";
import {
  createLabelledBillExtractor,
  validateBillExtractionProfile,
} from "./bill-extraction-profile.mjs";
import { createPdfBillParser } from "./bill-pdf-parser.mjs";
import { BillSourceDiscovery } from "./bill-source-discovery.mjs";

const profile = {
  schemaVersion: 1,
  kind: "labelled-invoice-v1",
  currency: "USD",
  currencyDigits: 2,
  dateFormat: "us",
  fields: {
    invoiceId: "Invoice number:",
    company: "Billed by:",
    origin: "Website:",
    accountLabel: "Customer account:",
    amount: "Total due: $",
    dueDate: "Pay by:",
    serviceAddress: "Service location:",
    serviceStarts: "Period begins:",
    serviceEnds: "Period ends:",
  },
};
const first =
  "Monthly statement\nInvoice number: SEP-19\nBilled by: Water Test\nWebsite: https://water.example\nCustomer account: Ending 1234\nTotal due: $1,234.56\nPay by: 09/30/2026";
const second =
  "Service location: 12 Example Lane\nPeriod begins: 09/01/2026\nPeriod ends: 09/30/2026";
const document = {
  complete: true,
  pageCount: 2,
  pages: [first, second].map((visionText, index) => ({
    pageNumber: index + 1,
    method: "vision",
    nativeText: "",
    visionText,
  })),
};
test("reviewed profile interprets complete labelled invoices without fixture sentinel", async () => {
  const extraction = createLabelledBillExtractor(profile);
  const bill = extraction.parseDocument(document);
  assert.equal(bill.amountMinor, 123456);
  assert.equal(bill.invoiceId, "SEP-19");
  assert.equal(bill.dueDate, "2026-09-30");
  assert.deepEqual(bill.servicePeriod, {
    startsOn: "2026-09-01",
    endsOn: "2026-09-30",
  });
  assert.deepEqual(
    extraction.parseMessage({ bodyText: first + "\n" + second }),
    bill,
  );
  let checks = 0;
  const parse = createPdfBillParser({
    pdfService: { extractCompleteDocument: async () => document },
    mapDocument: extraction.parseDocument,
  });
  assert.deepEqual(
    await parse(
      { mimeType: "application/pdf", data: new Uint8Array([1]) },
      {},
      { assertActive: async () => checks++ },
    ),
    bill,
  );
  assert.ok(checks >= 3);
});
test("profile and source ambiguity cannot silently alter money, identity or dates", () => {
  for (const bad of [
    { ...profile, unexpected: true },
    { ...profile, currencyDigits: 5 },
    { ...profile, dateFormat: "guess" },
    { ...profile, fields: { ...profile.fields, amount: "Pay by:" } },
    { ...profile, fields: { ...profile.fields, serviceEnds: undefined } },
  ]) {
    assert.throws(() => validateBillExtractionProfile(bad));
  }
  assert.throws(() =>
    validateBillExtractionProfile({
      ...profile,
      fields: { ...profile.fields, amount: "Pay" },
    }),
  );
  const extraction = createLabelledBillExtractor(profile);
  for (const body of [
    first + "\nTotal due: $9.99",
    first.replace("1,234.56", "12,34.56"),
    first.replace("1,234.56", "1.23456"),
    first.replace("1,234.56", "-1.00"),
    first.replace("09/30/2026", "02/30/2026"),
    first.replace(
      "Website: https://water.example",
      "Website: https://other.example/path",
    ),
    first.replace("Invoice number: SEP-19\n", ""),
  ])
    assert.throws(
      () => extraction.parseMessage({ bodyText: body }),
      /unavailable/,
    );
  assert.equal(extraction.parseMessage({ bodyText: "Newsletter only" }), null);
  assert.throws(() =>
    extraction.parseDocument({
      ...document,
      pages: document.pages.slice(0, 1),
    }),
  );
  assert.throws(() =>
    extraction.parseDocument({
      complete: true,
      pageCount: 1,
      pages: [{ pageNumber: 1, visionText: "Unknown layout" }],
    }),
  );
  assert.equal(
    extraction.parseMessage({ bodyText: first + "\nTotal due: $1,234.56" })
      .amountMinor,
    123456,
  );
});
test("extracted identities remain checked against the authorized discovery scope", async () => {
  const extraction = createLabelledBillExtractor(profile);
  const message = {
    externalId: "m1",
    fromEmail: "bill@water.example",
    to: ["person@example.org"],
    receivedAt: "2026-09-10",
  };
  let body = first;
  const google = {
    searchGmailMessagesPage: async () => ({ messages: [message] }),
    getGmailMessageDetail: async () => ({
      message,
      bodyText: body,
      attachments: [],
    }),
  };
  const discovery = new BillSourceDiscovery({
    google,
    authorize: async () => true,
    parse: extraction.parseMessage,
  });
  const context = {
    accountId: "grant",
    actorId: "owner",
    agentId: "agent",
    taskId: "task",
    epoch: 1,
    billingAccountRef: "water",
    company: "Water Test",
    accountLabel: "Ending 1234",
    recipient: "person@example.org",
    senders: ["bill@water.example"],
    searchQuery: "water",
    providerOrigin: "https://water.example",
    after: Date.parse("2026-09-01"),
    before: Date.parse("2026-10-01"),
  };
  assert.equal(
    (await discovery.discover(context, new AbortController().signal))
      .candidates[0].facts.amountMinor,
    123456,
  );
  body = first.replace("Ending 1234", "Ending 9876");
  await assert.rejects(
    discovery.discover(context, new AbortController().signal),
    /unavailable/,
  );
  body = first.replace("https://water.example", "https://attacker.example");
  await assert.rejects(
    discovery.discover(context, new AbortController().signal),
    /unavailable/,
  );
});
test("partial PDF cover emails defer to the attachment without dropping identity conflicts", () => {
  const extraction = createLabelledBillExtractor(profile);
  const context = {
    company: "Water Test",
    accountLabel: "Ending 1234",
    providerOrigin: "https://water.example",
  };
  const detail = {
    bodyText: "Customer account: Ending 1234",
    attachments: [{ mimeType: "application/pdf" }],
  };
  assert.equal(extraction.parseMessage(detail, context), null);
  assert.throws(() =>
    extraction.parseMessage(
      { ...detail, bodyText: detail.bodyText + "\nTotal due: $1.00" },
      context,
    ),
  );
  assert.throws(() =>
    extraction.parseMessage(
      { ...detail, bodyText: "Customer account: Ending 9999" },
      context,
    ),
  );
  assert.throws(() =>
    extraction.parseMessage({ ...detail, attachments: [] }, context),
  );
  assert.throws(() =>
    extraction.parseMessage(
      {
        ...detail,
        bodyText:
          "Customer account: Ending 1234\nCustomer account: Ending 9999",
      },
      context,
    ),
  );
});
