import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mailAddress, mailAddresses } from "./mail-fields.mjs";
import { createMailboxReadPort } from "./mailbox-read-port.mjs";
import { createManagedGoogleReadPort } from "./managed-google-read-port.mjs";

const accountId = "grant_a";
const message = {
  externalId: "mail1",
  threadId: "thread1",
  fromEmail: "reader@example.test",
  to: ["owner@example.test", "Undisclosed recipients"],
  cc: ["family@example.test"],
  replyTo: "billing@example.test",
  isUnread: true,
  subject: '<img src="https://tracker.test">',
  snippet: "<script>unsafe()</script>",
  receivedAt: "2026-10-12",
};
const pdf = Buffer.from("controlled bytes");
const descriptor = {
  partId: "1",
  filename: "document.pdf",
  mimeType: "application/pdf",
  size: pdf.length,
  attachmentId: "private-provider-id",
};
const detail = {
  message,
  bodyText: '<img src="https://tracker.test">',
  bodyHtml: "<script>secret()</script>",
  refreshToken: "SECRET",
  attachments: [descriptor],
};
const input = { accountId, messageId: "mail1" };
test("bounded list forwards explicit grant and pagination, projects only display text", async () => {
  let path;
  const port = createMailboxReadPort({
    accountId,
    request: async (p) => {
      path = new URL(p, "https://cloud.test");
      return {
        messages: [message],
        nextPageToken: "opaque",
        accessToken: "SECRET",
      };
    },
  });
  const result = await port.list({
    accountId,
    query: "in:inbox",
    pageSize: 10,
  });
  assert.equal(path.searchParams.get("grantId"), accountId);
  assert.notEqual(result.nextPageToken, "opaque");
  await port.list({
    accountId,
    query: "in:inbox",
    pageSize: 10,
    pageToken: result.nextPageToken,
  });
  assert.equal(path.searchParams.get("pageToken"), "opaque");
  await assert.rejects(
    port.list({
      accountId,
      query: "different",
      pageSize: 10,
      pageToken: result.nextPageToken,
    }),
  );
  const other = createMailboxReadPort({
    accountId,
    request: async () => assert.fail("foreign cursor must not reach provider"),
  });
  await assert.rejects(
    other.list({
      accountId,
      query: "in:inbox",
      pageSize: 10,
      pageToken: result.nextPageToken,
    }),
  );
  assert.equal(result.messages[0].subject, message.subject);
  assert.deepEqual(result.messages[0].to, message.to);
  assert.deepEqual(result.messages[0].cc, message.cc);
  assert.equal(result.messages[0].replyTo, message.replyTo);
  assert.equal(result.messages[0].unread, true);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
  await assert.rejects(
    port.list({ accountId: "other", query: "in:inbox", pageSize: 10 }),
    { status: 409 },
  );
  await assert.rejects(
    port.list({ accountId, query: "in:inbox", pageSize: 51 }),
    { status: 400 },
  );
});
test("message body is an explicit text projection, with no HTML, image URLs or secrets fields", async () => {
  const port = createMailboxReadPort({
    accountId,
    request: async () => detail,
  });
  const result = await port.read(input);
  assert.equal(result.format, "text");
  assert.equal(result.remoteImages, false);
  assert.equal(result.bodyText, detail.bodyText);
  for (const field of ["bodyHtml", "refreshToken", "attachmentId"])
    assert.ok(!JSON.stringify(result).includes(field));
  assert.equal(result.attachments[0].downloadable, true);
  // Without labels or a historyId, the state says so rather than guessing.
  assert.deepEqual(result.state, {
    historyId: null,
    unread: false,
    inInbox: false,
    inTrash: false,
  });
  const labelled = createMailboxReadPort({
    accountId,
    request: async () => ({
      ...detail,
      message: {
        ...message,
        labels: ["INBOX", "UNREAD", "Label_private"],
        metadata: { historyId: "4242", dateHeader: "private" },
      },
    }),
  });
  const state = (await labelled.read(input)).state;
  assert.deepEqual(state, {
    historyId: "4242",
    unread: true,
    inInbox: true,
    inTrash: false,
  });
  const labelledResult = JSON.stringify(await labelled.read(input));
  assert.ok(!labelledResult.includes("Label_private"));
  assert.ok(!labelledResult.includes("dateHeader"));
  const bad = createMailboxReadPort({
    accountId,
    request: async () => ({
      ...detail,
      message: { ...message, externalId: "other" },
    }),
  });
  await assert.rejects(bad.read(input), { status: 502 });
});
test("read keeps links and authentication results, topmost first and unparsed", async () => {
  const link = { href: "https://biller.example.test/pay", text: "Pay now" };
  const authenticationResults = [
    "z.example; dkim=pass header.d=forged.test",
    "mx.google.com; dkim=fail",
  ];
  const port = createMailboxReadPort({
    accountId,
    request: async () => ({
      ...detail,
      links: [{ ...link, tracking: "private" }],
      authenticationResults,
    }),
  });
  const result = await port.read(input);
  assert.deepEqual(result.links, [link]);
  assert.deepEqual(result.authenticationResults, authenticationResults);
  // A Cloud deployment without the connector change reads as not checked.
  const old = createMailboxReadPort({ accountId, request: async () => detail });
  const before = await old.read(input);
  assert.deepEqual(before.links, []);
  assert.deepEqual(before.authenticationResults, []);
  for (const changed of [
    { authenticationResults: "mx.google.com; dkim=pass" },
    { authenticationResults: [null] },
    { links: [{ href: "https://biller.example.test/pay" }] },
    { message: { ...message, cc: undefined } },
    { message: { ...message, replyTo: undefined } },
    { message: { ...message, isUnread: "true" } },
  ]) {
    const bad = createMailboxReadPort({
      accountId,
      request: async () => ({ ...detail, ...changed }),
    });
    await assert.rejects(bad.read(input), { status: 502 });
  }
});
test("managed task read returns the fields a bill check needs", async () => {
  const port = createManagedGoogleReadPort({
    accountId,
    request: async () => ({
      ...detail,
      links: [{ href: "https://biller.example.test/pay", text: "Pay now" }],
      authenticationResults: ["b.example; none", "a.example; none"],
    }),
  });
  const result = await port.getGmailMessageDetail(input);
  assert.equal(result.message.subject, message.subject);
  assert.deepEqual(result.message.to, message.to);
  assert.deepEqual(result.message.cc, message.cc);
  assert.equal(result.message.replyTo, message.replyTo);
  assert.equal(result.message.unread, true);
  assert.deepEqual(result.links, [
    { href: "https://biller.example.test/pay", text: "Pay now" },
  ]);
  assert.deepEqual(result.authenticationResults, [
    "b.example; none",
    "a.example; none",
  ]);
  const old = createManagedGoogleReadPort({
    accountId,
    request: async () => detail,
  });
  assert.deepEqual(
    (await old.getGmailMessageDetail(input)).authenticationResults,
    [],
  );
  const bad = createManagedGoogleReadPort({
    accountId,
    request: async () => ({
      ...detail,
      message: { ...message, subject: undefined },
    }),
  });
  await assert.rejects(bad.getGmailMessageDetail(input));
});
test("attachment requires current allowlisted metadata, byte limit, canonical bytes and digest", async () => {
  const request = async (path) =>
    new URL(path, "https://cloud.test").searchParams.has("partId")
      ? {
          ...descriptor,
          grantId: accountId,
          messageId: "mail1",
          encoding: "base64url",
          data: pdf.toString("base64url"),
          sha256: createHash("sha256").update(pdf).digest("hex"),
        }
      : detail;
  // Gmail uses the empty part ID for an attachment on the root MIME part.
  const rootPort = createMailboxReadPort({
    accountId,
    request: async (path) => {
      const value = await request(path);
      return new URL(path, "https://cloud.test").searchParams.has("partId")
        ? { ...value, partId: "" }
        : { ...value, attachments: [{ ...descriptor, partId: "" }] };
    },
  });
  assert.deepEqual(
    (await rootPort.attachment({ ...input, partId: "" })).data,
    pdf,
    "a listed root MIME attachment keeps its valid empty part ID",
  );
  const { attachment } = createMailboxReadPort({ accountId, request });
  assert.deepEqual(
    (await attachment({ ...input, partId: "1" })).data,
    pdf,
    "destructured method works",
  );
  for (const changed of [
    { mimeType: "text/html" },
    { size: 6 * 1024 * 1024 },
    { partId: "" },
  ]) {
    const port = createMailboxReadPort({
      accountId,
      request: async () => ({
        ...detail,
        attachments: [{ ...descriptor, ...changed }],
      }),
    });
    await assert.rejects(port.attachment({ ...input, partId: "1" }));
  }
  const corrupt = createMailboxReadPort({
    accountId,
    request: async (path) => ({
      ...(await request(path)),
      sha256: "0".repeat(64),
    }),
  });
  await assert.rejects(corrupt.attachment({ ...input, partId: "1" }));
});
test("malformed provider values and oversized content reject rather than silently truncating", async () => {
  for (const changed of [
    { bodyText: "x".repeat(1024 * 1024 + 1) },
    { attachments: null },
  ]) {
    const port = createMailboxReadPort({
      accountId,
      request: async () => ({ ...detail, ...changed }),
    });
    await assert.rejects(port.read(input), { status: 502 });
  }
  assert.throws(() => createMailboxReadPort({ request: async () => detail }));
});

test("list rejects missing pagination state rather than claiming search is complete", async () => {
  for (const value of [
    { messages: [] },
    { messages: [], nextPageToken: undefined },
  ]) {
    const port = createMailboxReadPort({
      accountId,
      request: async () => value,
    });
    await assert.rejects(
      port.list({ accountId, query: "in:inbox", pageSize: 10 }),
      { status: 502 },
    );
  }
});

test("server-valid null sender addresses retain display text in list and detail", async () => {
  for (const from of [
    "Unknown sender",
    "",
    '<img src="https://tracker.test">',
  ]) {
    const source = { ...message, fromEmail: null, from };
    const port = createMailboxReadPort({
      accountId,
      request: async (path) =>
        path.includes("/search?")
          ? { messages: [source], nextPageToken: null }
          : { ...detail, message: source },
    });
    const listed = await port.list({
      accountId,
      query: "in:inbox",
      pageSize: 10,
    });
    assert.equal(listed.messages[0].sender, from);
    const opened = await port.read(input);
    assert.equal(opened.message.sender, from);
    assert.equal(opened.remoteImages, false);
    assert.equal(opened.format, "text");
  }
});

test("mail addresses follow the rule of Cloud's inbox review", async () => {
  const source = await readFile(
    new URL(
      "../../shared/src/lib/services/agent-google-connector/inbox-provider.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const mailbox = source.match(/function mailbox\(value[\s\S]*?\n\}/)?.[0];
  const addresses = source.match(/function addresses\(value[\s\S]*?\n\}/)?.[0];
  assert.match(mailbox, /text\(value, 254, true\)/);
  assert.match(mailbox, /address\.includes\("\.\."\)/);
  assert.match(
    addresses,
    /value\.length > 50 \|\| \(required && !value\.length\)/,
  );
  // Cloud's own pattern, read from its source.
  const pattern = new RegExp(mailbox.match(/\/(\^.*\$)\/\.test/)[1]);
  for (const value of [
    "ann@example.test",
    "a.b+c@mail.example.co",
    "Ann <ann@example.test>",
    "ann..b@example.test",
    "ann@example",
    "ann@-example.test",
    "ann@example.test\n",
    "ann @example.test",
    `${"a".repeat(244)}@example.test`,
    `${"a".repeat(245)}@example.test`,
  ])
    assert.equal(
      mailAddress(value),
      value.length <= 254 && !value.includes("..") && pattern.test(value),
      value,
    );
  const fifty = Array.from({ length: 50 }, (_, i) => `p${i}@example.test`);
  assert.equal(mailAddresses(fifty, true), fifty);
  assert.equal(mailAddresses([...fifty, "q@example.test"]), null);
  assert.deepEqual(mailAddresses(undefined), []);
  assert.equal(mailAddresses(undefined, true), null);
  assert.equal(mailAddresses([], true), null);
  assert.equal(mailAddresses(["Ann <ann@example.test>"]), null);
});
