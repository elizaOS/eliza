import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseControlledBillMessage } from "../test/fixtures/bill-host/policy.mjs";
import { BillSourceDiscovery } from "./bill-source-discovery.mjs";
import { createBillSourceStore } from "./bill-source-store.mjs";

const body =
  "Controlled test bill\nInvoice: SEP-1\nCompany: Water Test\nWebsite: https://water.example\nAccount: Ending 1234\nAmount: USD 23.45\nDue date: 2026-09-30\n";
const context = {
  accountId: "google-a",
  actorId: "owner",
  agentId: "senior-care",
  taskId: "task",
  epoch: 1,
  billingAccountRef: "utility-account",
  company: "Water Test",
  accountLabel: "Ending 1234",
  recipient: "person@example.org",
  senders: ["bill@example.org"],
  searchQuery: "from:bill@example.org",
  providerOrigin: "https://water.example",
  after: Date.parse("2026-09-01"),
  before: Date.parse("2026-10-01"),
};
function fixture() {
  const bytes = Buffer.from(body);
  const attachment = {
    partId: "1",
    attachmentId: "a1",
    filename: "bill.txt",
    mimeType: "text/plain",
    size: bytes.length,
  };
  const message = {
    externalId: "m1",
    fromEmail: "bill@example.org",
    to: ["person@example.org"],
    receivedAt: "2026-09-10T00:00:00Z",
  };
  let reads = 0,
    allowed = true;
  const google = {
    searchGmailMessagesPage: async () => ({ messages: [message] }),
    getGmailMessageDetail: async () => ({
      message,
      bodyText: "Your bill is attached.",
      attachments: [attachment],
    }),
    getGmailAttachment: async (input) => {
      reads++;
      assert.equal(input.accountId, "google-a");
      return {
        ...attachment,
        messageId: "m1",
        data: bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  };
  const options = {
    google,
    authorize: async () => allowed,
    parse: parseControlledBillMessage,
    attachmentPolicy: () => "read",
    parseAttachment: (value) =>
      parseControlledBillMessage({
        bodyText: Buffer.from(value.data).toString("utf8"),
      }),
  };
  return {
    google,
    attachment,
    options,
    reads: () => reads,
    revoke: () => (allowed = false),
  };
}
const discover = (f) =>
  new BillSourceDiscovery(f.options).discover(
    context,
    new AbortController().signal,
  );
test("attachment-only bills retain document hash and exact bill facts", async () => {
  const f = fixture(),
    result = await discover(f);
  assert.equal(result.status, "candidate");
  assert.equal(result.candidates[0].facts.amountMinor, 2345);
  const source = result.candidates[0].sources[0];
  assert.equal(source.kind, "gmail-attachment");
  assert.equal(source.partId, "1");
  assert.equal(source.filename, "bill.txt");
  assert.equal(f.reads(), 1);
  assert.equal(JSON.stringify(result).includes(body), false);
  const db = new DatabaseSync(":memory:");
  try {
    const owner = {
      actorId: "owner",
      agentId: "senior-care",
      connector: { source: "app", accountId: "owner" },
    };
    const task = {
      id: "task",
      revision: 0,
      epoch: 1,
      status: "active",
      authorization: { state: "active" },
      observation: null,
      operations: [],
      allowedOrigins: [context.providerOrigin],
    };
    const store = createBillSourceStore(db, { get: () => task }).forTask(
      { owner },
      "task",
    );
    const offer = store.offer(result, 0),
      selected = store.select(
        {
          offerId: offer.offerId,
          candidateId: result.candidates[0].candidateId,
          expectedRevision: 0,
        },
        result,
      );
    assert.equal(
      selected.candidate.sources[0].contentSha256,
      source.contentSha256,
    );
    assert.equal(store.load().candidate.sources[0].kind, "gmail-attachment");
  } finally {
    db.close();
  }
});
test("unsupported attachments make the search incomplete rather than selecting a partial body result", async () => {
  const f = fixture();
  f.options.attachmentPolicy = () => "unsupported";
  assert.deepEqual(await discover(f), { status: "incomplete", candidates: [] });
  assert.equal(f.reads(), 0);
  f.options.attachmentPolicy = () => "ignore";
  assert.equal((await discover(f)).status, "missing");
});
test("changed descriptors, bytes and authorization cannot reach the document parser", async () => {
  for (const mutation of [
    (v) => ({ ...v, filename: "other.txt" }),
    (v) => ({ ...v, sha256: "0".repeat(64) }),
    (v) => ({ ...v, data: Buffer.from("short") }),
  ]) {
    const f = fixture(),
      read = f.google.getGmailAttachment;
    let parsed = false;
    f.options.parseAttachment = () => {
      parsed = true;
      return null;
    };
    f.google.getGmailAttachment = async (input) => mutation(await read(input));
    await assert.rejects(discover(f), { code: "BILL_SOURCES_UNAVAILABLE" });
    assert.equal(parsed, false);
  }
  const f = fixture(),
    read = f.google.getGmailAttachment;
  f.google.getGmailAttachment = async (input) => {
    const value = await read(input);
    f.revoke();
    return value;
  };
  await assert.rejects(discover(f), { code: "BILL_SOURCES_UNAVAILABLE" });
});
test("one discovery reads every authorized attachment", async () => {
  const f = fixture(),
    read = f.google.getGmailAttachment;
  f.google.getGmailMessageDetail = async () => ({
    message: {
      externalId: "m1",
      fromEmail: "bill@example.org",
      to: ["person@example.org"],
      receivedAt: "2026-09-10",
    },
    bodyText: "",
    attachments: Array.from({ length: 26 }, (_, i) => ({
      ...f.attachment,
      partId: String(i),
    })),
  });
  f.google.getGmailAttachment = async (input) => ({
    ...(await read(input)),
    partId: input.partId,
  });
  const result = await discover(f);
  assert.equal(result.status, "candidate");
  assert.equal(result.candidates[0].sources.length, 26);
  assert.equal(f.reads(), 26);
});
