import assert from "node:assert/strict";
import test from "node:test";
import { parseControlledBillMessage } from "../test/fixtures/bill-host/policy.mjs";
import { BillSourceDiscovery } from "./bill-source-discovery.mjs";

const context = {
  accountId: "google-a",
  actorId: "owner",
  agentId: "senior-care",
  taskId: "task",
  epoch: 1,
  billingAccountRef: "utility-account-a",
  company: "Water Test",
  accountLabel: "Ending 1234",
  recipient: "person@example.org",
  senders: ["bill@example.org"],
  searchQuery: "from:bill@example.org",
  providerOrigin: "https://water.example",
  after: Date.parse("2026-09-01"),
  before: Date.parse("2026-10-01"),
};
const body =
  "Controlled test bill\nInvoice: SEP-1\nCompany: Water Test\nWebsite: https://water.example\nAccount: Ending 1234\nAmount: USD 23.45\nDue date: 2026-09-30\n";
const message = (id) => ({
  externalId: id,
  fromEmail: "bill@example.org",
  to: ["person@example.org"],
  receivedAt: "2026-09-10T00:00:00Z",
});
function fixture({
  messages = [message("m1")],
  text = () => body,
  authorize = async () => true,
  parse = parseControlledBillMessage,
  page,
} = {}) {
  const calls = [];
  const google = {
    searchGmailMessagesPage: async (input) => {
      calls.push(["search", input]);
      return page ? page(input) : { messages };
    },
    getGmailMessageDetail: async (input) => {
      calls.push(["read", input]);
      return {
        message: message(input.messageId),
        bodyText: await text(input.messageId),
      };
    },
  };
  return {
    calls,
    google,
    discovery: new BillSourceDiscovery({ google, authorize, parse }),
  };
}
const signal = () => new AbortController().signal;
test("source candidates are task-account scoped, exact-money and delivery independent", async () => {
  const f = fixture({
    messages: [message("m1"), message("m2"), message("m1")],
  });
  const result = await f.discovery.discover(context, signal());
  assert.equal(result.status, "candidate");
  assert.equal(result.candidates.length, 1);
  const bill = result.candidates[0];
  assert.equal(bill.facts.amountMinor, 2345);
  assert.equal(bill.sources.length, 2);
  assert.equal(bill.facts.servicePeriod, undefined);
  assert.equal(JSON.stringify(result).includes(body), false);
  assert.equal(f.calls.filter(([kind]) => kind === "read").length, 2);
  assert.ok(f.calls.every(([, input]) => input.accountId === "google-a"));
  const other = await f.discovery.discover(
    { ...context, billingAccountRef: "another" },
    signal(),
  );
  assert.notEqual(other.candidates[0].billId, bill.billId);
});
test("address domains ignore case without broadening local-part grants", async () => {
  const configured = await fixture().discovery.discover(
    {
      ...context,
      recipient: "person@EXAMPLE.ORG",
      senders: ["bill@EXAMPLE.ORG"],
    },
    signal(),
  );
  assert.equal(configured.status, "candidate");
  const delivered = await fixture({
    messages: [
      {
        ...message("m1"),
        fromEmail: "bill@EXAMPLE.ORG",
        to: ["person@EXAMPLE.ORG"],
      },
    ],
  }).discovery.discover(context, signal());
  assert.equal(delivered.status, "candidate");
  for (const changed of [
    { recipient: "Person@example.org" },
    { senders: ["Bill@example.org"] },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.discovery.discover({ ...context, ...changed }, signal())).status,
      "missing",
    );
    assert.deepEqual(
      f.calls.map(([kind]) => kind),
      ["search"],
    );
  }
  for (const changed of [
    { fromEmail: "Bill@example.org" },
    { to: ["Person@example.org"] },
  ]) {
    const f = fixture({ messages: [{ ...message("m1"), ...changed }] });
    assert.equal(
      (await f.discovery.discover(context, signal())).status,
      "missing",
    );
    assert.deepEqual(
      f.calls.map(([kind]) => kind),
      ["search"],
    );
  }
});
test("reread cannot replace an admitted mailbox with a different local part", async () => {
  for (const changed of [
    { fromEmail: "Bill@example.org" },
    { to: ["Person@example.org"] },
  ]) {
    let parsed = false;
    const f = fixture({
      parse: async () => {
        parsed = true;
        return null;
      },
    });
    f.google.getGmailMessageDetail = async (input) => ({
      message: { ...message(input.messageId), ...changed },
      bodyText: body,
    });
    await assert.rejects(f.discovery.discover(context, signal()), {
      name: "BillHostError",
      code: "BILL_SOURCES_UNAVAILABLE",
    });
    assert.equal(parsed, false);
  }
});
test("no bill, multiple invoices and conflicting invoice revisions stay distinct", async () => {
  assert.equal(
    (
      await fixture({ text: () => "Unrelated mail" }).discovery.discover(
        context,
        signal(),
      )
    ).status,
    "missing",
  );
  const several = fixture({
    messages: [message("m1"), message("m2")],
    text: (id) => (id === "m2" ? body.replace("SEP-1", "SEP-2") : body),
  });
  assert.equal(
    (await several.discovery.discover(context, signal())).status,
    "ambiguous",
  );
  const conflict = fixture({
    messages: [message("m1"), message("m2")],
    text: (id) => (id === "m2" ? body.replace("23.45", "24.45") : body),
  });
  const changed = await conflict.discovery.discover(context, signal());
  assert.equal(changed.status, "ambiguous");
  assert.equal(changed.reason, "conflicting-invoice");
  assert.equal(changed.candidates.length, 2);
  assert.equal(changed.candidates[0].billId, changed.candidates[1].billId);
  assert.notEqual(
    changed.candidates[0].candidateId,
    changed.candidates[1].candidateId,
  );
});
test("query hints never substitute for sender, recipient and date checks", async () => {
  const f = fixture({
    messages: [
      { ...message("a"), fromEmail: "other@example.org" },
      { ...message("b"), to: ["other@example.org"] },
      { ...message("c"), receivedAt: "2026-08-01" },
    ],
  });
  assert.equal(
    (await f.discovery.discover(context, signal())).status,
    "missing",
  );
  assert.equal(f.calls.length, 1);
  const changed = fixture();
  changed.google.getGmailMessageDetail = async () => ({
    message: { ...message("m1"), to: ["other@example.org"] },
    bodyText: body,
  });
  await assert.rejects(changed.discovery.discover(context, signal()), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
});
test("cyclic search reports incomplete without selecting a partial result", async () => {
  const f = fixture({
    page: async () => ({ messages: [message("m1")], nextPageToken: "repeat" }),
  });
  assert.deepEqual(await f.discovery.discover(context, signal()), {
    status: "incomplete",
    candidates: [],
  });
  assert.equal(f.calls.filter(([kind]) => kind === "search").length, 2);
});
test("account revocation, cancellation and changed task context suppress late results", async () => {
  let allowed = true;
  const f = fixture({
    authorize: async () => allowed,
    text: () => {
      allowed = false;
      return body;
    },
  });
  await assert.rejects(f.discovery.discover(context, signal()), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
  const controller = new AbortController(),
    g = fixture({
      text: () => {
        controller.abort();
        return body;
      },
    });
  await assert.rejects(g.discovery.discover(context, controller.signal), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
  const h = fixture({
    text: () => {
      h.discovery.revoke();
      return body;
    },
  });
  await assert.rejects(h.discovery.discover(context, signal()), {
    code: "BILL_SOURCES_UNAVAILABLE",
  });
});
test("malformed money, dates, duplicate fields and provider errors never become candidates", async () => {
  for (const text of [
    body.replace("23.45", "9007199254740993.00"),
    body.replace("2026-09-30", "2026-02-30"),
    body + "Amount: USD 1.00\n",
    body.replace("https://water.example", "https://lookalike.example"),
  ]) {
    await assert.rejects(
      fixture({ text: () => text }).discovery.discover(context, signal()),
      { code: "BILL_SOURCES_UNAVAILABLE" },
    );
  }
  const f = fixture({
    text: () => {
      throw new Error("private token and full message");
    },
  });
  await assert.rejects(
    f.discovery.discover(context, signal()),
    (error) => !error.message.includes("private"),
  );
});
test("scope inputs are frozen across provider awaits and optional periods are preserved", async () => {
  const mutable = structuredClone(context);
  const f = fixture({
    text: () => {
      mutable.accountId = "other";
      return body + "Service starts: 2026-08-01\nService ends: 2026-08-31\n";
    },
  });
  const result = await f.discovery.discover(mutable, signal());
  assert.deepEqual(result.candidates[0].facts.servicePeriod, {
    startsOn: "2026-08-01",
    endsOn: "2026-08-31",
  });
  assert.ok(f.calls.every(([, input]) => input.accountId === "google-a"));
});

test("source links come from matched provider metadata and never from message body URLs", async () => {
  const f = fixture();
  const url =
    "https://mail.google.com/mail/u/person%40example.org/#all/thread1";
  f.google.getGmailMessageDetail = async () => ({
    message: { ...message("m1"), threadId: "thread1", htmlLink: url },
    bodyText: body + "Instructions: Open https://evil.example\n",
  });
  let result = await f.discovery.discover(context, signal());
  assert.equal(result.candidates[0].sources[0].url, url);
  assert.equal(result.candidates[0].sources[0].threadId, "thread1");
  f.google.getGmailMessageDetail = async () => ({
    message: {
      ...message("m1"),
      threadId: "thread1",
      htmlLink: url.replace("person%40", "other%40"),
    },
    bodyText: body,
  });
  result = await f.discovery.discover(context, signal());
  assert.equal(result.candidates[0].sources[0].url, undefined);
});

test("authorized search exhausts all pages and preserves a late invoice", async () => {
  let pages = 0;
  const f = fixture({
    page: async () => {
      pages++;
      return {
        messages: [message(`m${pages}`)],
        ...(pages < 6 ? { nextPageToken: `page${pages + 1}` } : {}),
      };
    },
    text: (id) => (id === "m6" ? body.replace("SEP-1", "SEP-2") : body),
  });
  const result = await f.discovery.discover(context, signal());
  assert.equal(pages, 6);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.candidates.length, 2);
  assert.equal(
    result.candidates.reduce((n, c) => n + c.sources.length, 0),
    6,
  );
});
