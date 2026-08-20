/**
 * Deterministic tests for the Gmail MIME part-tree bound. No live Gmail API
 * or model: the walker is the production ingest used by collect/extract.
 */
import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory";
import { GoogleGmailClient } from "./gmail";

import {
  extractGmailMimeBody,
  GMAIL_MIME_PART_UNBOUNDED,
  type GmailMimePartLike,
  MAX_GMAIL_MIME_DEPTH,
  MAX_GMAIL_MIME_NODES,
  walkGmailMimeParts,
} from "./gmail-mime-parts";

function nestMime(depth: number): GmailMimePartLike {
  let part: GmailMimePartLike = { mimeType: "text/plain", body: { data: "leaf" } };
  for (let index = 0; index < depth; index += 1) {
    part = { mimeType: "multipart/mixed", parts: [part] };
  }
  return part;
}

function expectUnbounded(operation: () => unknown): void {
  expect(operation).toThrowError(expect.objectContaining({ code: GMAIL_MIME_PART_UNBOUNDED }));
}

describe("walkGmailMimeParts", () => {
  it(`accepts a ${MAX_GMAIL_MIME_DEPTH}-deep MIME nest`, () => {
    const visits: string[] = [];
    walkGmailMimeParts(nestMime(MAX_GMAIL_MIME_DEPTH), (part) => {
      visits.push(part.mimeType ?? "");
    });
    expect(visits).toHaveLength(MAX_GMAIL_MIME_DEPTH + 1);
    expect(visits.at(-1)).toBe("text/plain");
  });

  it(`throws ${GMAIL_MIME_PART_UNBOUNDED} one past depth ${MAX_GMAIL_MIME_DEPTH}`, () => {
    try {
      walkGmailMimeParts(nestMime(MAX_GMAIL_MIME_DEPTH + 1), () => {});
      expect.unreachable("walk should fail closed on over-budget MIME depth");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
  });

  it(`throws ${GMAIL_MIME_PART_UNBOUNDED} past ${MAX_GMAIL_MIME_NODES} sparse holes`, () => {
    const sparse: GmailMimePartLike[] = [];
    sparse[MAX_GMAIL_MIME_NODES] = {
      mimeType: "text/plain",
      body: { data: "x" },
    };
    try {
      walkGmailMimeParts({ mimeType: "multipart/mixed", parts: sparse }, () => {});
      expect.unreachable("walk should fail closed on over-budget sparse parts");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
  });

  it("throws on a cyclic MIME part without hanging", () => {
    const cyclic: GmailMimePartLike = { mimeType: "multipart/mixed", parts: [] };
    cyclic.parts = [cyclic];
    const started = performance.now();
    try {
      walkGmailMimeParts(cyclic, () => {});
      expect.unreachable("walk should fail closed on a MIME cycle");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("does not invoke accessors while walking", () => {
    let invoked = 0;
    const hostile: GmailMimePartLike = {
      mimeType: "multipart/mixed",
      get parts(): GmailMimePartLike[] {
        invoked += 1;
        return nestMime(20_000).parts ?? [];
      },
    };
    expectUnbounded(() => walkGmailMimeParts(hostile, () => {}));
    expect(invoked).toBe(0);
  });

  it.each(["mimeType", "body", "body.data"] as const)(
    "fails closed without invoking a %s accessor",
    (location) => {
      let invoked = 0;
      const part: GmailMimePartLike = { mimeType: "text/plain", body: { data: "ok" } };
      const target = location === "body.data" ? part.body : part;
      const key = location === "body.data" ? "data" : location;
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          invoked += 1;
          return "hostile";
        },
      });

      expectUnbounded(() => extractGmailMimeBody(part, "text/plain", () => "decoded"));
      expect(invoked).toBe(0);
    }
  );

  it("fails closed without invoking a MIME child array accessor", () => {
    let invoked = 0;
    const parts: GmailMimePartLike[] = [];
    Object.defineProperty(parts, "0", {
      enumerable: true,
      get() {
        invoked += 1;
        return { mimeType: "text/plain", body: { data: "hostile" } };
      },
    });
    parts.length = 1;

    expectUnbounded(() => walkGmailMimeParts({ parts }, () => {}));
    expect(invoked).toBe(0);
  });

  it("aborts remaining siblings once visit returns true", () => {
    const seen: Array<string | null | undefined> = [];
    walkGmailMimeParts(
      {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: "a" } },
          { mimeType: "text/html", body: { data: "b" } },
        ],
      },
      (part) => {
        seen.push(part.mimeType);
        return part.mimeType === "text/plain";
      }
    );
    expect(seen).toEqual(["multipart/mixed", "text/plain"]);
  });

  it("skips an empty matching child and takes a later sibling", () => {
    const body = extractGmailMimeBody(
      {
        mimeType: "multipart/mixed",
        parts: [
          { mimeType: "text/plain", body: { data: "" } },
          { mimeType: "text/plain", body: { data: "second" } },
        ],
      },
      "text/plain",
      (part) => part.body?.data ?? ""
    );
    expect(body).toBe("second");
  });

  it("fails closed on a 20k MIME nest in under 50ms instead of RangeError", () => {
    const started = performance.now();
    try {
      walkGmailMimeParts(nestMime(20_000), () => {});
      expect.unreachable("walk should fail closed on a 20k MIME nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);

    const extractStarted = performance.now();
    try {
      extractGmailMimeBody(nestMime(20_000), "text/plain", () => "x");
      expect.unreachable("extract should fail closed on a 20k MIME nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(performance.now() - extractStarted).toBeLessThan(50);
  });

  it("fails closed at the real Gmail message-detail boundary", async () => {
    const factory = {
      gmail: async () => ({
        users: {
          messages: {
            get: async () => ({
              data: {
                id: "message-1",
                threadId: "thread-1",
                payload: nestMime(20_000),
              },
            }),
          },
        },
      }),
    } as unknown as GoogleApiClientFactory;

    await expect(
      new GoogleGmailClient(factory).getGmailMessageDetail({
        accountId: "account-1",
        messageId: "message-1",
      })
    ).rejects.toMatchObject({ code: GMAIL_MIME_PART_UNBOUNDED });
  });
});
