import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { MAX_GMAIL_ATTACHMENT_BYTES } from "@elizaos/plugin-google-workspace/gmail-attachments";
import { readManagedGoogleGmailMessage } from "./gmail";
import { readManagedGoogleGmailAttachment } from "./gmail-attachments";
import * as shared from "./shared";

const args = {
  organizationId: "org",
  userId: "user",
  side: "owner" as const,
  grantId: "grant",
  messageId: "m1",
  partId: "1",
  maxBytes: 100,
};
const bytes = Buffer.from("test PDF bytes");
const descriptor = {
  partId: "1",
  filename: "bill.pdf",
  mimeType: "application/pdf",
  body: { attachmentId: "a1", size: bytes.length },
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup({
  part = descriptor,
  status = {},
  reply = { data: bytes.toString("base64url"), size: bytes.length },
  messageId = "m1",
  bodyText = "",
}: {
  part?: unknown;
  status?: object;
  reply?: unknown;
  messageId?: string;
  bodyText?: string;
} = {}) {
  spies.push(
    spyOn(shared, "getManagedGoogleConnectorStatus").mockResolvedValue({
      connected: true,
      connectionId: "grant",
      identity: { email: "person@example.org" },
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      ...status,
    } as shared.ManagedGoogleConnectorStatus),
  );
  const calls: Array<Parameters<typeof shared.googleFetch>[0]> = [];
  spies.push(
    spyOn(shared, "googleFetch").mockImplementation(async (input) => {
      calls.push(input);
      const body = input.url.includes("/attachments/")
        ? reply
        : {
            id: messageId,
            threadId: "t1",
            payload: {
              mimeType: "multipart/mixed",
              parts: [
                ...(bodyText
                  ? [
                      {
                        partId: "0",
                        mimeType: "text/html",
                        body: {
                          data: Buffer.from(bodyText).toString("base64url"),
                          size: Buffer.byteLength(bodyText),
                        },
                      },
                    ]
                  : []),
                part,
              ],
            },
          };
      if (
        input.maxResponseBytes !== undefined &&
        Buffer.byteLength(JSON.stringify(body)) > input.maxResponseBytes
      )
        throw new Error("Provider response exceeds configured limit");
      return Response.json(body);
    }),
  );
  return calls;
}
test("managed attachment is bound to exact grant/message/part and bounded at both reads", async () => {
  const calls = setup();
  const result = await readManagedGoogleGmailAttachment(args);
  expect(result).toMatchObject({
    messageId: "m1",
    partId: "1",
    grantId: "grant",
    encoding: "base64url",
    data: bytes.toString("base64url"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  expect(calls.length).toBe(2);
  expect(
    calls.every(
      (input) =>
        input.grantId === "grant" && input.organizationId === "org" && input.userId === "user",
    ),
  ).toBe(true);
  expect(calls.map((input) => input.maxResponseBytes)).toEqual([
    Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES / 3) * 4 + 65536,
    65672,
  ]);
});
test("small attachment reads tolerate a larger unrelated message body", async () => {
  const calls = setup({ bodyText: "x".repeat(80 * 1024) });
  expect((await readManagedGoogleGmailAttachment(args)).data).toBe(bytes.toString("base64url"));
  expect(calls[1].maxResponseBytes).toBe(65672);
});
test("inline attachment needs no separate provider request", async () => {
  const calls = setup({
    part: { ...descriptor, body: { data: bytes.toString("base64url"), size: bytes.length } },
  });
  expect((await readManagedGoogleGmailAttachment(args)).data).toBe(bytes.toString("base64url"));
  expect(calls.length).toBe(1);
});
test("missing explicit grant and changed grant cannot read attachment bytes", async () => {
  const calls = setup({ status: { connectionId: "other" } });
  await expect(readManagedGoogleGmailAttachment({ ...args, grantId: "" })).rejects.toMatchObject({
    status: 400,
  });
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({ status: 409 });
  expect(calls.length).toBe(0);
});
test("oversize and wrong message stop before attachment fetch; bad bytes are rejected", async () => {
  let calls = setup({ part: { ...descriptor, body: { ...descriptor.body, size: 101 } } });
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({ status: 502 });
  expect(calls.length).toBe(1);
  for (const spy of spies.splice(0)) spy.mockRestore();
  calls = setup({ messageId: "other" });
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({ status: 502 });
  expect(calls.length).toBe(1);
  for (const spy of spies.splice(0)) spy.mockRestore();
  setup({ reply: { data: "wrong", size: bytes.length } });
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({ status: 502 });
});
test("message detail exposes descriptors without attachment bytes", async () => {
  const calls = setup();
  const result = await readManagedGoogleGmailMessage(args);
  expect(result.attachments).toEqual([
    {
      partId: "1",
      attachmentId: "a1",
      filename: "bill.pdf",
      mimeType: "application/pdf",
      size: bytes.length,
    },
  ]);
  expect(calls.length).toBe(1);
  expect(calls[0].maxResponseBytes).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain(bytes.toString("base64url"));
});

test("provider failures are sanitized even when authorization disappears between reads", async () => {
  setup();
  let reads = 0;
  spies.push(
    spyOn(shared, "googleFetch").mockImplementation(async () => {
      reads++;
      if (reads === 1) return Response.json({ id: "m1", payload: { parts: [descriptor] } });
      throw new shared.AgentGoogleConnectorError(409, "private provider content");
    }),
  );
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({
    status: 409,
    message: "Google attachment read access is unavailable.",
  });
  expect(reads).toBe(2);
});

test("revocation during the final provider response prevents attachment release", async () => {
  setup();
  let reads = 0;
  spies.push(
    spyOn(shared, "getManagedGoogleConnectorStatus").mockImplementation(
      async () =>
        ({
          connected: ++reads === 1,
          connectionId: "grant",
          identity: { email: "person@example.org" },
          grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        }) as shared.ManagedGoogleConnectorStatus,
    ),
  );
  await expect(readManagedGoogleGmailAttachment(args)).rejects.toMatchObject({ status: 409 });
  expect(reads).toBe(2);
});
