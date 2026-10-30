import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createMailboxReadPort } from "./mailbox-read-port.mjs";

const accountId = "grant_a";
const message = {
  externalId: "mail1",
  threadId: "thread1",
  fromEmail: "reader@example.test",
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
