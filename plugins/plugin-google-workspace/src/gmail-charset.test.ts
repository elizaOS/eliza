/**
 * Gmail returns each body part's bytes in the charset its own Content-Type
 * header declares; the reads must decode with that charset, not always UTF-8.
 */
import { describe, expect, it } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.ts";
import { GoogleGmailClient } from "./gmail.ts";

function stubFactory(message: Record<string, unknown>): GoogleApiClientFactory {
  return {
    gmail: async () => ({
      users: {
        messages: {
          get: async () => ({ data: message }),
        },
      },
    }),
  } as unknown as GoogleApiClientFactory;
}

function textPart(data: string, contentType?: string): Record<string, unknown> {
  return {
    partId: "0",
    mimeType: "text/plain",
    filename: "",
    headers: contentType ? [{ name: "Content-Type", value: contentType }] : [],
    body: { data, size: Buffer.from(data, "base64url").length },
  };
}

function messageWith(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg-charset",
    threadId: "thr-charset",
    labelIds: ["INBOX"],
    internalDate: "1728450000000",
    snippet: "",
    payload: {
      ...payload,
      headers: [
        ...((payload.headers as unknown[]) ?? []),
        { name: "Subject", value: "Charset" },
        { name: "From", value: "Sender <sender@example.com>" },
        { name: "To", value: "me@example.com" },
      ],
    },
  };
}

async function readBodies(payload: Record<string, unknown>) {
  const client = new GoogleGmailClient(stubFactory(messageWith(payload)));
  const params = { accountId: "acct-test", messageId: "msg-charset" };
  const detail = await client.getGmailMessageDetail({ ...params, selfEmail: "me@example.com" });
  const summary = await client.getMessage({ ...params, includeBody: true });
  return { detail: detail?.bodyText, summary: summary.bodyText };
}

describe("Gmail body part charset", () => {
  it("decodes an ISO-8859-1 text/plain part", async () => {
    // "Café" with é as the single latin-1 byte 0xe9.
    const bodies = await readBodies(textPart("Q2Fm6Q", "text/plain; charset=ISO-8859-1"));
    expect(bodies).toEqual({ detail: "Café", summary: "Café" });
  });

  it("decodes an EUC-KR text/plain part", async () => {
    // "안녕" in EUC-KR is b8 c8 b3 e7.
    const bodies = await readBodies(textPart("vsiz5w", 'text/plain; charset="euc-kr"'));
    expect(bodies).toEqual({ detail: "안녕", summary: "안녕" });
  });

  it("decodes UTF-8 bytes when the part declares no charset", async () => {
    const data = Buffer.from("Menú ✓ 안녕").toString("base64url");
    const bodies = await readBodies(textPart(data));
    expect(bodies).toEqual({ detail: "Menú ✓ 안녕", summary: "Menú ✓ 안녕" });
  });

  it("uses the nested part's own charset inside multipart/alternative", async () => {
    const bodies = await readBodies({
      mimeType: "multipart/alternative",
      headers: [{ name: "Content-Type", value: 'multipart/alternative; boundary="b"' }],
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/related",
          headers: [{ name: "Content-Type", value: 'multipart/related; boundary="c"' }],
          body: { size: 0 },
          parts: [textPart("Q2Fm6Q", "text/plain; charset=iso-8859-1; format=flowed")],
        },
      ],
    });
    expect(bodies).toEqual({ detail: "Café", summary: "Café" });
  });
});
