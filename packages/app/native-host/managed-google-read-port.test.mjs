import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCloudRoutes } from "./cloud-runtime-routes.mjs";

const message = {
  externalId: "m1",
  threadId: "t1",
  fromEmail: "bill@example.org",
  to: ["person@example.org"],
  receivedAt: "2026-09-10",
};
function fixture(response) {
  let actor = "owner";
  const calls = [];
  const handler = createCloudRoutes({
    initialApiKey: "host-secret",
    credentialGate: async () => actor,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers.Authorization, "Bearer host-secret");
      return Response.json(
        typeof response === "function" ? await response(url) : response,
      );
    },
  });
  return {
    port: handler.googleForAccount({ actorId: "owner", accountId: "grant" }),
    calls,
    change: () => (actor = "other"),
  };
}
test("managed task reads retain pagination and exact grant without leaking response extras", async () => {
  const f = fixture({
    messages: [{ ...message, token: "private-extra" }],
    nextPageToken: "next",
  });
  const result = await f.port.searchGmailMessagesPage({
    accountId: "grant",
    query: "bill",
    pageSize: 25,
    pageToken: "previous",
  });
  assert.equal(result.nextPageToken, "next");
  assert.equal(JSON.stringify(result).includes("private-extra"), false);
  const url = new URL(f.calls[0].url);
  assert.equal(url.searchParams.get("grantId"), "grant");
  assert.equal(url.searchParams.get("pageToken"), "previous");
  await assert.rejects(
    f.port.searchGmailMessagesPage({
      accountId: "other",
      query: "bill",
      pageSize: 25,
    }),
  );
  assert.equal(f.calls.length, 1);
});
test("older servers cannot silently pass as complete search or attachment-capable reads", async () => {
  await assert.rejects(
    fixture({ messages: [] }).port.searchGmailMessagesPage({
      accountId: "grant",
      query: "bill",
      pageSize: 25,
    }),
  );
  await assert.rejects(
    fixture({ message, bodyText: "bill" }).port.getGmailMessageDetail({
      accountId: "grant",
      messageId: "m1",
    }),
  );
});
test("managed attachment bytes require matching grant, canonical encoding and digest", async () => {
  const bytes = Buffer.from("test-pdf"),
    value = {
      grantId: "grant",
      messageId: "m1",
      partId: "1",
      filename: "bill.pdf",
      mimeType: "application/pdf",
      attachmentId: "a1",
      size: bytes.length,
      data: bytes.toString("base64url"),
      encoding: "base64url",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  const input = {
    accountId: "grant",
    messageId: "m1",
    partId: "1",
    maxBytes: 1024,
  };
  assert.deepEqual(
    (await fixture(value).port.getGmailAttachment(input)).data,
    bytes,
  );
  for (const wrong of [
    { grantId: "other" },
    { sha256: "wrong" },
    { data: value.data + "=" },
    { size: 999 },
  ])
    await assert.rejects(
      fixture({ ...value, ...wrong }).port.getGmailAttachment(input),
    );
});
test("account change during a managed read discards the old response", async () => {
  let release, started;
  const began = new Promise((r) => (started = r)),
    waiting = new Promise((r) => (release = r));
  const f = fixture(async () => {
    started();
    await waiting;
    return { messages: [message], nextPageToken: null };
  });
  const pending = f.port.searchGmailMessagesPage({
    accountId: "grant",
    query: "bill",
    pageSize: 25,
  });
  await began;
  f.change();
  release();
  await assert.rejects(pending, /account changed/);
});
