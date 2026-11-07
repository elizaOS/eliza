/** Links, previews, retained edits, read-ahead, read state and reviewed agent hand-off. Synthetic data only. */
import { describe, expect, it, vi } from "vitest";
import {
  attachmentBytes,
  checkOutgoingAttachments,
  reviewOpaqueAttachment,
} from "../../src/mailbox/attachments.ts";
import { sha256Hex } from "../../src/mailbox/digest.ts";
import { attachmentRefused } from "../../src/mailbox/failures.ts";
import {
  linkifyMailText,
  linkTextMismatch,
  safeMailLink,
} from "../../src/mailbox/links.ts";
import {
  reviewMailContext,
  validateMailContext,
} from "../../src/mailbox/mail-context.ts";
import {
  decodeMailPreview,
  numericReference,
} from "../../src/mailbox/preview.ts";
import { GmailReadAhead } from "../../src/mailbox/read-ahead.ts";
import { setGmailReadState } from "../../src/mailbox/read-state.ts";
import {
  encodeInboxUnsaved,
  readInboxUnsaved,
} from "../../src/mailbox/retained-draft.ts";

const signal = () => new AbortController().signal;

describe("mail links and previews", () => {
  it("keeps only safe links and trims trailing punctuation", () => {
    expect(
      linkifyMailText(
        "See https://example.org/a). and https://example.org/(b).",
      ),
    ).toEqual([
      { href: "https://example.org/a", text: "https://example.org/a" },
      { href: "https://example.org/(b)", text: "https://example.org/(b)" },
    ]);
    expect(safeMailLink({ href: "https://example.org", text: 7 })).toBeNull();
    expect(
      linkTextMismatch({ href: "https://evil.example/", text: "bank.example" }),
    ).toBe(true);
    expect(
      linkTextMismatch({
        href: "https://www.bank.example/x",
        text: "bank.example",
      }),
    ).toBe(false);
  });

  it("decodes references once and collapses padding runs", () => {
    expect(decodeMailPreview("Tom &amp;amp; Jerry", numericReference)).toBe(
      "Tom &amp; Jerry",
    );
    expect(decodeMailPreview("A&#x1F600;B", numericReference)).toBe("A😀B");
    expect(
      decodeMailPreview("Hi\u200b\u200b\u200b there", numericReference),
    ).toBe("Hi there");
  });
});

describe("attachments", () => {
  it("counts decoded bytes and enforces the outgoing policy", () => {
    expect(attachmentBytes({ dataBase64: btoa("abcd") })).toBe(4);
    const file = (name: string) => ({ name, dataBase64: btoa("x") });
    expect(() =>
      checkOutgoingAttachments([file("a"), file("b")], {
        maximumOutgoing: 1,
        maximumTotalBytes: 1000,
      }),
    ).toThrow("one attachment");
    expect(() => checkOutgoingAttachments([file("a"), file("A")])).toThrow(
      "same name",
    );
  });

  it("hashes opaque bytes and refuses unsafe names", async () => {
    const reviewed = await reviewOpaqueAttachment({
      name: "data.bin",
      mimeType: "Application/Octet-Stream",
      dataBase64: btoa("abc"),
    });
    expect(reviewed.sha256).toBe(await sha256Hex("abc"));
    expect(reviewed.mimeType).toBe("application/octet-stream");
    await reviewOpaqueAttachment({
      name: "../x",
      mimeType: "text/plain",
      dataBase64: btoa("abc"),
    }).then(
      () => expect.unreachable(),
      (error) => expect(attachmentRefused(error)).toBe(true),
    );
  });
});

describe("retained edits", () => {
  it("round-trips a valid copy and refuses another owner's", () => {
    const value = {
      version: 1 as const,
      owner: "owner",
      baseRevision: null,
      toQ: "",
      draft: {
        version: 1,
        id: "d",
        revision: "r",
        owner: "owner",
        to: ["a@example.invalid"],
        subject: "S",
        body: "B",
      },
    };
    const raw = encodeInboxUnsaved(value);
    expect(readInboxUnsaved(raw, "owner").draft.id).toBe("d");
    expect(() => readInboxUnsaved(raw, "other")).toThrow("need recovery");
    expect(() =>
      encodeInboxUnsaved({ ...value, draft: { ...value.draft, mode: "x" } }),
    ).toThrow("need recovery");
  });
});

describe("read-ahead", () => {
  it("serves one prepared page once within the TTL", async () => {
    let now = 0;
    const ahead = new GmailReadAhead<string>(30000, () => now);
    const read = vi.fn(async () => "page-2");
    ahead.prepare("key", "cursor", read);
    ahead.prepare("key", "cursor", read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await ahead.take("key", "cursor", signal())).toBe("page-2");
    expect(await ahead.take("key", "cursor", signal())).toBeUndefined();
    ahead.prepare("key", "cursor", read);
    await Promise.resolve();
    now = 31000;
    expect(await ahead.take("key", "cursor", signal())).toBeUndefined();
  });
});

describe("read state", () => {
  it("dispatches once and reports uncertain outcomes as null", async () => {
    for (const state of ["succeeded", "outcome-unknown"] as const) {
      const calls = { dispatch: 0 };
      const client = {
        async gmailPrepareOperation(
          _grant: string,
          requestId: string,
          proposal: Record<string, unknown>,
        ) {
          const review = { ...proposal, from: "o@example.invalid" };
          return {
            review,
            receipt: {
              requestId,
              kind: proposal.kind as "mark-read",
              state: "prepared" as const,
              reviewDigest: await sha256Hex(JSON.stringify(review)),
              providerResult: null,
              rejectionCode: null,
            },
          };
        },
        async gmailDispatchOperation(
          _grant: string,
          requestId: string,
          reviewDigest: string,
          proposal: Record<string, unknown>,
        ) {
          calls.dispatch++;
          return {
            requestId,
            kind: proposal.kind as "mark-read",
            state,
            reviewDigest,
            providerResult:
              state === "succeeded"
                ? { messageId: "m1", unread: false, historyId: "h2" }
                : null,
            rejectionCode: null,
          };
        },
      };
      const result = await setGmailReadState(
        client,
        "grant",
        { messageId: "m1", expectedHistoryId: "h1", unread: false },
        signal(),
      );
      expect(result).toEqual(
        state === "succeeded" ? { unread: false, historyId: "h2" } : null,
      );
      expect(calls.dispatch).toBe(1);
    }
  });
});

describe("reviewed mail context", () => {
  it("binds the exact message and destination", async () => {
    const source = {
      accountId: "grant",
      messageId: "m1",
      revision: "h1",
      from: "F",
      to: ["o@example.invalid"],
      subject: "S",
      bodyText: "Body",
    };
    const destination = {
      ownerId: "owner",
      agentId: "agent",
      sessionId: "session",
      origin: "local",
    };
    const review = await reviewMailContext(source, destination);
    expect(await validateMailContext(review, source, destination)).toContain(
      "untrusted data",
    );
    await expect(
      validateMailContext(review, { ...source, revision: "h2" }, destination),
    ).rejects.toThrow("changed");
  });
});
