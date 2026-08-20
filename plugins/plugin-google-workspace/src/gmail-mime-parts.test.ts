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

  it("fails closed on accessor-backed parts without invoking them", () => {
    let invoked = 0;
    const hostile: GmailMimePartLike = {
      mimeType: "multipart/mixed",
      get parts(): GmailMimePartLike[] {
        invoked += 1;
        return nestMime(20_000).parts ?? [];
      },
    };
    try {
      walkGmailMimeParts(hostile, () => {});
      expect.unreachable("walk should fail closed on accessor-backed parts");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("fails closed on accessor-backed child slots without invoking them", () => {
    let invoked = 0;
    const children: GmailMimePartLike[] = [];
    Object.defineProperty(children, 0, {
      configurable: true,
      enumerable: true,
      get(): GmailMimePartLike {
        invoked += 1;
        return { mimeType: "text/plain", body: { data: "x" } };
      },
    });
    try {
      walkGmailMimeParts({ mimeType: "multipart/mixed", parts: children }, () => {});
      expect.unreachable("walk should fail closed on accessor-backed child slots");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("fails closed on accessor-backed mimeType without invoking it", () => {
    let invoked = 0;
    const hostile = {
      get mimeType(): string {
        invoked += 1;
        return "text/plain";
      },
      body: { data: "secret" },
    };
    try {
      extractGmailMimeBody(hostile, "text/plain", (part) => part.body?.data ?? "");
      expect.unreachable("extract should fail closed on accessor-backed mimeType");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("fails closed on accessor-backed body data without invoking it", () => {
    let invoked = 0;
    const body = {};
    Object.defineProperty(body, "data", {
      configurable: true,
      enumerable: true,
      get(): string {
        invoked += 1;
        return "secret";
      },
    });
    try {
      extractGmailMimeBody(
        { mimeType: "text/plain", body: body as { data?: string | null } },
        "text/plain",
        (part) => part.body?.data ?? ""
      );
      expect.unreachable("extract should fail closed on accessor-backed body data");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
    expect(invoked).toBe(0);
  });

  it("does not use in or index-get on child arrays", () => {
    let invoked = 0;
    const child: GmailMimePartLike = { mimeType: "text/plain", body: { data: "ok" } };
    const children = new Proxy([child], {
      has(): boolean {
        invoked += 1;
        return true;
      },
      get(target, property, receiver) {
        if (property !== "length") invoked += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const body = extractGmailMimeBody(
      { mimeType: "multipart/mixed", parts: children },
      "text/plain",
      (part) => part.body?.data ?? ""
    );
    expect(body).toBe("ok");
    expect(invoked).toBe(0);
  });

  it("passes visitors an own-data snapshot so collector body reads stay accessor-free", () => {
    let invoked = 0;
    const body = {};
    Object.defineProperty(body, "data", {
      configurable: true,
      enumerable: true,
      get(): string {
        invoked += 1;
        return "secret";
      },
    });
    try {
      walkGmailMimeParts(
        { mimeType: "text/plain", body: body as { data?: string | null } },
        (node) => {
          void node.body?.data;
          return false;
        }
      );
      expect.unreachable("walk should fail closed before the visitor sees accessor body data");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
    }
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
});

describe("GoogleGmailClient.getGmailMessageDetail MIME bound", () => {
  it("fails closed on a 20k MIME nest without RangeError", async () => {
    const fakeGmail = {
      users: {
        messages: {
          get: async () => ({
            data: {
              id: "msg_hostile",
              threadId: "thread_hostile",
              snippet: "nested",
              payload: nestMime(20_000),
            },
          }),
        },
      },
    };
    const factory = {
      gmail: async () => fakeGmail,
    } as unknown as GoogleApiClientFactory;
    const client = new GoogleGmailClient(factory);
    const started = performance.now();
    try {
      await client.getGmailMessageDetail({
        accountId: "acct_1",
        messageId: "msg_hostile",
      });
      expect.unreachable("getGmailMessageDetail should fail closed on a 20k MIME nest");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(GMAIL_MIME_PART_UNBOUNDED);
      expect((error as Error).name).not.toBe("RangeError");
    }
    expect(performance.now() - started).toBeLessThan(50);
  });
});
