/** Managed Gmail route parsing against a closed in-process transport. No network or account. */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import { ManagedGmailProtocolError } from "../../src/mailbox/failures.ts";
import { ManagedGmailMailboxClient } from "../../src/mailbox/managed-gmail-client.ts";

type Route = (
  path: string,
  options?: { body?: unknown; timeoutMs?: number },
) => unknown;

class HostError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CloudProtocolError";
  }
}

function fixture(routes: Record<string, Route>) {
  const sent: Array<{ path: string; body?: unknown; timeoutMs?: number }> = [];
  const client = new ManagedGmailMailboxClient({
    async request(path, _signal, options) {
      sent.push({ path, ...options });
      const route = Object.keys(routes).find((key) => path.includes(key));
      if (!route) throw new HostError("http");
      return (routes[route] as Route)(path, options);
    },
    invalidResponse: () => new HostError("invalid-response"),
    reviewAttachment: async (file) => {
      const raw = atob(file.dataBase64);
      return {
        name: file.name,
        mimeType: file.mimeType,
        size: raw.length,
        sha256: await sha256Hex(raw),
      };
    },
  });
  return { client, sent };
}
const signal = () => new AbortController().signal;
const message = {
  externalId: "m1",
  threadId: "t1",
  subject: "S",
  from: "F",
  fromEmail: "f@example.invalid",
  to: ["o@example.invalid"],
  snippet: "",
  receivedAt: "2026-10-08T00:00:00Z",
  isUnread: true,
};

describe("ManagedGmailMailboxClient", () => {
  it("validates links, attachments and the optional HTML body of a read", async () => {
    const { client } = fixture({
      "/gmail/read?": () => ({
        message: {
          ...message,
          hasAttachments: true,
          metadata: { historyId: "42" },
        },
        bodyText: "Body",
        bodyHtml: "<p>Body</p>",
        attachments: [
          {
            partId: "1",
            filename: "a.pdf",
            mimeType: "application/pdf",
            size: 3,
          },
          { partId: "2", name: "b.zip", mimeType: "application/zip", size: 9 },
        ],
        links: [
          { href: "https://example.org/a", text: "A\u0007 link" },
          { href: "javascript:alert(1)", text: "x" },
          { href: "https://user:pw@example.org/", text: "creds" },
          { href: "https://example.org/a", text: "duplicate" },
          { href: "http://plain.example.org/", text: "" },
        ],
      }),
    });
    const read = await client.gmailRead("grant", "m1", signal());
    expect(read.links).toEqual([
      { href: "https://example.org/a", text: "A link" },
      { href: "http://plain.example.org/", text: "plain.example.org" },
    ]);
    expect(read.historyId).toBe("42");
    expect(read.bodyHtml).toBe("<p>Body</p>");
    expect(read.bodyHtmlOmitted).toBeUndefined();
    expect(read.omittedLinks).toBeUndefined();
    expect(read.message.hasAttachments).toBe(true);
    expect(read.attachments.map((a) => [a.name, a.supported])).toEqual([
      ["a.pdf", true],
      ["b.zip", false],
    ]);
  });

  it("reports links and HTML left out of the display bounds", async () => {
    const { client } = fixture({
      "/gmail/read?": () => ({
        message,
        bodyText: "Body",
        bodyHtml: `<p>${"x".repeat(512 * 1024)}</p>`,
        links: Array.from({ length: 53 }, (_, i) => ({
          href: `https://example.org/${i}`,
          text: `L${i}`,
        })),
      }),
    });
    const read = await client.gmailRead("grant", "m1", signal());
    expect(read.links).toHaveLength(50);
    expect(read.omittedLinks).toBe(3);
    expect(read.bodyHtml).toBeUndefined();
    expect(read.bodyHtmlOmitted).toBe(true);
    expect(read.bodyText).toBe("Body");
  });

  it("uses the host's invalid-response error for malformed provider data", async () => {
    const { client } = fixture({
      "/gmail/read?": () => ({
        message: { ...message, hasAttachments: "yes" },
        bodyText: "Body",
      }),
      "/gmail/search?": () => ({
        messages: [],
        syncedAt: "2026-10-08T00:00:00Z",
        nextPageToken: "same",
      }),
    });
    await expect(client.gmailRead("grant", "m1", signal())).rejects.toThrow(
      HostError,
    );
    await expect(
      client.gmailSearch("grant", "in:inbox", signal(), 25, "same"),
    ).rejects.toThrow("invalid-response");
    const fallback = new ManagedGmailMailboxClient({
      request: async () => [{}],
      reviewAttachment: async () => {
        throw new Error("unused");
      },
    });
    await expect(fallback.gmailAccounts(signal())).rejects.toBeInstanceOf(
      ManagedGmailProtocolError,
    );
  });

  it("reads search pages with their mailbox revision", async () => {
    const { client, sent } = fixture({
      "/gmail/search?": () => ({
        messages: [message],
        syncedAt: "2026-10-08T00:00:00Z",
        nextPageToken: "next",
        mailboxHistoryId: "1234",
        supportsSpamTrash: true,
      }),
    });
    const page = await client.gmailSearch("grant", "in:inbox", signal(), 25);
    expect(page.mailboxHistoryId).toBe("1234");
    expect(page.nextPageToken).toBe("next");
    expect(page.supportsSpamTrash).toBe(true);
    expect(page.messages[0]?.unread).toBe(true);
    expect(sent[0]?.path).toContain("query=in%3Ainbox");
    await expect(
      client.gmailSearch("grant", "in:inbox", signal(), 25, ""),
    ).rejects.toThrow(TypeError);
  });

  it("labels a blank sender 'Unknown sender' and keeps the whole page", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...message,
      externalId: `m${i}`,
      from: i === 7 ? "" : i === 8 ? "  " : "F",
    }));
    const { client } = fixture({
      "/gmail/search?": () => ({
        messages: rows,
        syncedAt: "2026-10-08T00:00:00Z",
      }),
      "/gmail/read?": () => ({
        message: { ...message, from: 42 },
        bodyText: "",
      }),
    });
    const page = await client.gmailSearch("grant", "in:inbox", signal(), 25);
    expect(page.messages).toHaveLength(25);
    expect(page.messages[7]?.from).toBe("Unknown sender");
    expect(page.messages[8]?.from).toBe("Unknown sender");
    expect(page.messages[9]?.from).toBe("F");
    await expect(client.gmailRead("grant", "m1", signal())).rejects.toThrow(
      "invalid-response",
    );
  });

  it("defaults absent capabilities to false and one outgoing attachment", async () => {
    const base = {
      version: 1,
      from: "o@example.invalid",
      threads: true,
      send: true,
      providerDrafts: true,
      mailboxMutations: true,
      attachments: true,
      providerExactlyOnce: false,
      atomicDraftReplacement: false,
    };
    let data: Record<string, unknown> = base;
    const { client } = fixture({ "/inbox-v1/capabilities": () => data });
    const old = await client.gmailInboxCapabilities("grant", signal());
    expect([
      old.readState,
      old.draftsList,
      old.forwardAttachments,
      old.opaqueAttachments,
      old.searchTrash,
      old.attachmentPolicy,
    ]).toEqual([
      false,
      false,
      false,
      false,
      false,
      { maximumOutgoing: 1, maximumBytes: 5242880, maximumTotalBytes: 5242880 },
    ]);
    data = {
      ...base,
      readState: true,
      attachmentPolicy: { maximumOutgoing: 10, maximumBytes: 5242880 },
    };
    const next = await client.gmailInboxCapabilities("grant", signal());
    expect(next.readState).toBe(true);
    expect(next.attachmentPolicy.maximumOutgoing).toBe(10);
    data = { ...base, providerExactlyOnce: true };
    await expect(
      client.gmailInboxCapabilities("grant", signal()),
    ).rejects.toThrow("invalid-response");
  });

  it("opens a long newsletter, inspecting at most 200 link rows", async () => {
    const { client } = fixture({
      "/gmail/read?": () => ({
        message,
        bodyText: "Body",
        links: Array.from({ length: 250 }, (_, i) => ({
          href: `https://example.org/${i % 120}`,
          text: `L${i}`,
        })),
      }),
    });
    const read = await client.gmailRead("grant", "m1", signal());
    expect(read.links).toHaveLength(50);
    expect(read.links[49]?.href).toBe("https://example.org/49");
    // 70 distinct links past the first 50 in the inspected rows, plus 50 uninspected rows.
    expect(read.omittedLinks).toBe(70 + 50);
    expect(
      client.mailLinks([{ href: "https://example.org/x", text: "x" }]),
    ).toHaveLength(1);
  });

  it("offers an attachment for review only with Cloud's name, type and size rule", async () => {
    const pdf = (filename: string, size: number, supported?: boolean) => ({
      partId: filename,
      filename,
      mimeType: "application/pdf",
      size,
      ...(supported === undefined ? {} : { supported }),
    });
    const { client } = fixture({
      "/gmail/read?": () => ({
        message,
        bodyText: "Body",
        attachments: [
          pdf("small.pdf", 1024),
          pdf("large.pdf", 8 * 1024 * 1024),
          pdf("invoice", 1024),
          pdf("cloud-says-no.pdf", 1024, false),
          { partId: "x", filename: "x.pdf", mimeType: "constructor", size: 1 },
        ],
      }),
    });
    const read = await client.gmailRead("grant", "m1", signal());
    expect(read.attachments.map((a) => [a.name, a.supported])).toEqual([
      ["small.pdf", true],
      ["large.pdf", false],
      ["invoice", false],
      ["cloud-says-no.pdf", false],
      ["x.pdf", false],
    ]);
  });

  it("accepts only an exact 64-character provider draft digest", async () => {
    let providerDigest = `${"a".repeat(64)}b`;
    const { client } = fixture({
      "/draft?": () => ({ id: "d1", messageId: "m1", providerDigest }),
    });
    await expect(client.gmailDraft("grant", "d1", signal())).rejects.toThrow(
      "invalid-response",
    );
    providerDigest = "a".repeat(64);
    expect(
      (await client.gmailDraft("grant", "d1", signal())).providerDigest,
    ).toBe(providerDigest);
  });

  it("scales prepare and dispatch timeouts with the uploaded body, up to 120 s", async () => {
    const digest = "a".repeat(64),
      id = "00000000-0000-4000-8000-000000000001";
    const receipt = {
      requestId: id,
      kind: "send",
      state: "prepared",
      reviewDigest: digest,
      providerResult: null,
      rejectionCode: null,
    };
    const { client, sent } = fixture({
      "/dispatch": () => ({ version: 1, providerExactlyOnce: false, receipt }),
      "/operations": () => ({
        version: 1,
        providerExactlyOnce: false,
        receipt,
        review: {},
      }),
    });
    const proposal = (bytes: number) => ({
      kind: "send",
      attachments: [{ dataBase64: "A".repeat(bytes) }],
    });
    await client.gmailPrepareOperation("grant", id, proposal(0), signal());
    await client.gmailPrepareOperation(
      "grant",
      id,
      proposal(2 * 1024 * 1024),
      signal(),
    );
    await client.gmailDispatchOperation(
      "grant",
      id,
      digest,
      proposal(2 * 1024 * 1024),
      signal(),
    );
    await client.gmailDispatchOperation(
      "grant",
      id,
      digest,
      proposal(7 * 1024 * 1024),
      signal(),
    );
    const [small, prepare, dispatch, capped] = sent.map(
      (row) => row.timeoutMs as number,
    );
    expect(small).toBeGreaterThanOrEqual(30_000);
    expect(small).toBeLessThan(30_100);
    // 2 MiB at 32 KiB/s is 64 s on top of the base.
    expect(prepare).toBeGreaterThanOrEqual(94_000);
    expect(prepare).toBeLessThan(94_100);
    expect(dispatch).toBeGreaterThanOrEqual(109_000);
    expect(dispatch).toBeLessThan(109_100);
    expect(capped).toBe(120_000);
  });

  it("cancels a request through Cloud and reads back its receipt", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const { client, sent } = fixture({
      "/cancel": () => ({
        version: 1,
        providerExactlyOnce: false,
        receipt: {
          requestId: id,
          kind: "send",
          state: "rejected",
          reviewDigest: "a".repeat(64),
          providerResult: null,
          rejectionCode: "cancelled",
        },
      }),
    });
    const receipt = await client.gmailCancelOperation("grant", id, signal());
    expect(receipt).toMatchObject({
      state: "rejected",
      rejectionCode: "cancelled",
    });
    expect(sent[0]).toMatchObject({
      path: `/api/v1/eliza/google/gmail/inbox-v1/operations/${id}/cancel`,
      body: { grantId: "grant" },
    });
  });

  it("validates receipts and dispatches with the longer timeout", async () => {
    const digest = "a".repeat(64);
    const receipt = (state: string, providerResult: unknown) => ({
      requestId: "00000000-0000-4000-8000-000000000001",
      kind: "send",
      state,
      reviewDigest: digest,
      providerResult,
      rejectionCode: null,
    });
    let state = "succeeded",
      result: unknown = { messageId: "sent" };
    const { client, sent } = fixture({
      "/dispatch": () => ({
        version: 1,
        providerExactlyOnce: false,
        receipt: receipt(state, result),
      }),
    });
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      (await client.gmailDispatchOperation("grant", id, digest, {}, signal()))
        .state,
    ).toBe("succeeded");
    expect(sent[0]?.timeoutMs).toBeGreaterThanOrEqual(45000);
    expect(sent[0]?.timeoutMs).toBeLessThan(45100);
    result = null;
    await expect(
      client.gmailDispatchOperation("grant", id, digest, {}, signal()),
    ).rejects.toThrow("invalid-response");
    state = "outcome-unknown";
    expect(
      (await client.gmailDispatchOperation("grant", id, digest, {}, signal()))
        .state,
    ).toBe("outcome-unknown");
  });

  it("refuses an attachment whose bytes do not match the declared hash", async () => {
    const bytes = btoa("%PDF-1");
    const { client } = fixture({
      "/inbox-v1/attachment?": (path) => ({
        version: 1,
        messageId: "m1",
        partId: "1",
        historyId: "9",
        name: "a.pdf",
        mimeType: "application/pdf",
        dataBase64: bytes,
        size: 6,
        sha256: path.includes("opaque") ? "0".repeat(64) : "1".repeat(64),
        ...(path.includes("opaque") ? { opaque: true } : {}),
      }),
    });
    await expect(
      client.gmailAttachment("grant", "m1", "1", "9", signal()),
    ).rejects.toThrow("invalid-response");
    await expect(
      client.gmailOpaqueAttachment("grant", "m1", "1", "9", signal()),
    ).rejects.toThrow("invalid-response");
  });
});
