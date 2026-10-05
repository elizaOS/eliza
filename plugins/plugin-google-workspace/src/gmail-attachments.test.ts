/** Exercises actual attachment client routing, MIME inventory and byte integrity with a scoped provider fixture. */
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";
import { gmailAttachmentParts } from "./gmail-attachments.js";

const data = Buffer.from("A complete bill 🙂\n");
const descriptor = {
  partId: "1",
  filename: "bill.pdf",
  mimeType: "application/pdf",
  body: { attachmentId: "attachment_1", size: data.length },
};
function fixture() {
  const get = vi.fn().mockResolvedValue({
    data: {
      id: "message1",
      threadId: "thread1",
      payload: { mimeType: "multipart/mixed", parts: [descriptor] },
    },
  });
  const attachment = vi
    .fn()
    .mockResolvedValue({ data: { data: data.toString("base64url"), size: data.length } });
  const gmail = vi
    .fn()
    .mockResolvedValue({ users: { messages: { get, attachments: { get: attachment } } } });
  return {
    get,
    attachment,
    gmail,
    client: new GoogleGmailClient({ gmail } as unknown as GoogleApiClientFactory),
  };
}
const params = { accountId: "account1", messageId: "message1", partId: "1", maxBytes: 1024 };

describe("Gmail attachments", () => {
  it("returns the complete declared bytes and SHA through the explicitly scoped message/attachment path", async () => {
    const f = fixture();
    const result = await f.client.getGmailAttachment(params);
    expect(Buffer.from(result.data)).toEqual(data);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.filename).toBe("bill.pdf");
    expect(f.attachment.mock.calls[0]?.[0]).toEqual({
      userId: "me",
      messageId: "message1",
      id: "attachment_1",
    });
    expect(f.gmail).toHaveBeenCalledTimes(3);
    for (const [account, capabilities] of f.gmail.mock.calls) {
      expect(account.accountId).toBe("account1");
      expect(capabilities).toEqual(["gmail.read"]);
    }
  });
  it("reads a small attachment from a message with a larger unrelated body", async () => {
    const f = fixture();
    const message = {
      id: "message1",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            partId: "0",
            mimeType: "text/html",
            body: {
              data: Buffer.from("x".repeat(80 * 1024)).toString("base64url"),
              size: 80 * 1024,
            },
          },
          descriptor,
        ],
      },
    };
    f.get.mockImplementation(async (_input: unknown, options: { maxContentLength: number }) => {
      if (Buffer.byteLength(JSON.stringify(message)) > options.maxContentLength)
        throw new Error("Provider response exceeds configured limit");
      return { data: message };
    });
    expect(Buffer.from((await f.client.getGmailAttachment(params)).data)).toEqual(data);
    expect(f.attachment.mock.calls[0]?.[1]).toEqual({
      maxContentLength: Math.ceil(params.maxBytes / 3) * 4 + 65536,
    });
  });
  it("reads inline attachment data without inventing an attachment ID", async () => {
    const f = fixture();
    f.get.mockResolvedValue({
      data: {
        id: "message1",
        payload: { ...descriptor, body: { size: data.length, data: data.toString("base64url") } },
      },
    });
    expect(Buffer.from((await f.client.getGmailAttachment(params)).data)).toEqual(data);
    expect(f.attachment).not.toHaveBeenCalled();
  });
  it("rejects missing parts, wrong messages and oversized attachments before fetching bytes", async () => {
    for (const input of [
      { ...params, partId: "9" },
      { ...params, maxBytes: 1 },
      { ...params, accountId: "" },
    ]) {
      const f = fixture();
      await expect(f.client.getGmailAttachment(input)).rejects.toMatchObject({
        code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
      });
      expect(f.attachment).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.get.mockResolvedValue({ data: { id: "other", payload: { parts: [descriptor] } } });
    await expect(f.client.getGmailAttachment(params)).rejects.toMatchObject({
      code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
    });
    expect(f.attachment).not.toHaveBeenCalled();
  });
  it("does not return truncated, corrupt or size-mismatched data or provider error details", async () => {
    for (const value of [
      { data: "not+base64", size: data.length },
      { data: "Zg=", size: data.length },
      { data: data.toString("base64url"), size: 1 },
      { data: "", size: data.length },
    ]) {
      const f = fixture();
      f.attachment.mockResolvedValue({ data: value });
      await expect(f.client.getGmailAttachment(params)).rejects.toMatchObject({
        code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
      });
    }
    const f = fixture();
    f.attachment.mockRejectedValue(new Error("secret bearer and attachment"));
    await expect(f.client.getGmailAttachment(params)).rejects.toThrow(
      "The Gmail attachment could not be read safely."
    );
  });
  it("snapshots account inputs and refuses revoked credentials before attachment fetch", async () => {
    const f = fixture(),
      mutable = { ...params };
    f.gmail.mockImplementation(async () => {
      mutable.accountId = "other";
      return { users: { messages: { get: f.get, attachments: { get: f.attachment } } } };
    });
    await f.client.getGmailAttachment(mutable);
    expect(f.gmail.mock.calls[1]?.[0].accountId).toBe("account1");
    const denied = fixture();
    denied.gmail.mockRejectedValueOnce(new Error("revoked"));
    await expect(denied.client.getGmailAttachment(params)).rejects.toMatchObject({
      code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
    });
    expect(denied.get).not.toHaveBeenCalled();
  });
  it("rejects ambiguous MIME IDs, accessors and cycles without executing getters", () => {
    expect(() => gmailAttachmentParts({ parts: [descriptor, descriptor] })).toThrow();
    let reads = 0;
    const trap = Object.defineProperty({ ...descriptor }, "filename", {
      get() {
        reads++;
        return "secret";
      },
    });
    expect(() => gmailAttachmentParts(trap)).toThrow();
    expect(reads).toBe(0);
    const cyclic: { parts?: unknown[] } = {};
    cyclic.parts = [cyclic];
    expect(() => gmailAttachmentParts(cyclic as never)).toThrow();
  });
  it("exposes attachment metadata in message detail without exposing attachment bytes", async () => {
    const f = fixture(),
      detail = await f.client.getGmailMessageDetail({
        accountId: "account1",
        messageId: "message1",
      });
    expect(detail?.attachments).toEqual([
      {
        partId: "1",
        attachmentId: "attachment_1",
        filename: "bill.pdf",
        mimeType: "application/pdf",
        size: data.length,
      },
    ]);
    expect(f.attachment).not.toHaveBeenCalled();
  });
});

it("withholds bytes when account access is revoked during the final provider response", async () => {
  const f = fixture();
  f.attachment.mockImplementation(async () => {
    f.gmail.mockRejectedValue(new Error("revoked credential with private detail"));
    return { data: { data: data.toString("base64url"), size: data.length } };
  });
  await expect(f.client.getGmailAttachment(params)).rejects.toMatchObject({
    code: "GOOGLE_GMAIL_ATTACHMENT_UNAVAILABLE",
  });
  expect(f.gmail).toHaveBeenCalledTimes(3);
});
