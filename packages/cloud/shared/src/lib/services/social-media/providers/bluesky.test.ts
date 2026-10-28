import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { blueskyProvider } from "./bluesky";

interface SentFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; did?: string; tag?: string; uri?: string }>;
}

const KNOWN_HANDLES: Record<string, string> = {
  "alice.bsky.social": "did:plc:alice123",
};

const UNAVAILABLE_HANDLE = "busy.bsky.social";

const originalFetch = globalThis.fetch;
let createRecordBodies: Array<{ record: { text: string; facets?: SentFacet[] } }>;
let resolvedHandles: string[];
let sessionResponse: (() => Response) | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubBlueskyServer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const method = url.pathname.replace("/xrpc/", "");

  if (method === "com.atproto.server.createSession") {
    if (sessionResponse) return Promise.resolve(sessionResponse());
    return Promise.resolve(
      json({
        did: "did:plc:poster",
        handle: "poster.bsky.social",
        accessJwt: "access",
        refreshJwt: "refresh",
      }),
    );
  }

  if (method === "com.atproto.identity.resolveHandle") {
    const handle = url.searchParams.get("handle") ?? "";
    resolvedHandles.push(handle);
    if (handle === UNAVAILABLE_HANDLE) {
      return Promise.resolve(new Response("upstream unavailable", { status: 503 }));
    }
    if (handle === "malformed.bsky.social") return Promise.resolve(json({ did: "alice" }));
    const did = KNOWN_HANDLES[handle];
    return Promise.resolve(
      did
        ? json({ did })
        : json({ error: "InvalidRequest", message: "Unable to resolve handle" }, 400),
    );
  }

  if (method === "com.atproto.repo.createRecord") {
    const body = JSON.parse(String(init?.body));
    createRecordBodies.push(body);
    // Mirrors the PDS: createRecord validates app.bsky.feed.post against the lexicon,
    // where a mention facet's `did` must be in DID format.
    const badMention = (body.record.facets ?? []).some((facet: SentFacet) =>
      facet.features.some(
        (feature) =>
          feature.$type === "app.bsky.richtext.facet#mention" && !feature.did?.startsWith("did:"),
      ),
    );
    if (badMention) {
      return Promise.resolve(
        json({ error: "InvalidRecord", message: "Invalid app.bsky.feed.post record" }, 400),
      );
    }
    return Promise.resolve(
      json({ uri: "at://did:plc:poster/app.bsky.feed.post/3kabc", cid: "bafyreia" }),
    );
  }

  return Promise.resolve(json({ error: "NotFound" }, 404));
}

const credentials = { handle: "poster.bsky.social", appPassword: "app-password" };

function sliceBytes(text: string, start: number, end: number): string {
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(start, end));
}

function lastFacets(): SentFacet[] {
  return createRecordBodies.at(-1)?.record.facets ?? [];
}

beforeEach(() => {
  createRecordBodies = [];
  resolvedHandles = [];
  sessionResponse = null;
  globalThis.fetch = stubBlueskyServer as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("blueskyProvider.createPost facets", () => {
  test("a handle inside a URL is not resolved or emitted as an overlapping mention", async () => {
    const text = "See https://example.com/(@alice.bsky.social)";
    const result = await blueskyProvider.createPost(credentials, { text });
    expect(result.success).toBe(true);
    expect(resolvedHandles).toEqual([]);
    expect(lastFacets()).toHaveLength(1);
    expect(lastFacets()[0].features[0].uri).toBe("https://example.com/(@alice.bsky.social)");
  });

  test("a malformed successful lookup fails before publishing the post", async () => {
    const result = await blueskyProvider.createPost(credentials, {
      text: "Hi @malformed.bsky.social",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid DID");
    expect(createRecordBodies).toHaveLength(0);
  });

  test("an email address in the text does not become a mention and the post succeeds", async () => {
    const text = "Questions? Write to support@acme.com";
    const result = await blueskyProvider.createPost(credentials, { text });

    expect(result.success).toBe(true);
    expect(createRecordBodies).toHaveLength(1);
    expect(
      lastFacets().filter((f) => f.features[0]?.$type === "app.bsky.richtext.facet#mention"),
    ).toEqual([]);
    expect(resolvedHandles).toEqual([]);
  }, 20_000);

  test("a handle mention is resolved to its DID with UTF-8 byte offsets", async () => {
    const text = "Café launch with @alice.bsky.social today";
    const result = await blueskyProvider.createPost(credentials, { text });

    expect(result.success).toBe(true);
    const mentions = lastFacets().filter(
      (f) => f.features[0]?.$type === "app.bsky.richtext.facet#mention",
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].features[0].did).toBe("did:plc:alice123");
    expect(mentions[0].index).toEqual({ byteStart: 18, byteEnd: 36 });
    expect(sliceBytes(text, mentions[0].index.byteStart, mentions[0].index.byteEnd)).toBe(
      "@alice.bsky.social",
    );
  }, 20_000);

  test("an unresolvable handle is left as plain text and the post still succeeds", async () => {
    const text = "Thanks @alice.bsky.social and @ghost.bsky.social";
    const result = await blueskyProvider.createPost(credentials, { text });

    expect(result.success).toBe(true);
    expect(resolvedHandles.sort()).toEqual(["alice.bsky.social", "ghost.bsky.social"]);
    const mentions = lastFacets().filter(
      (f) => f.features[0]?.$type === "app.bsky.richtext.facet#mention",
    );
    expect(mentions.map((f) => f.features[0].did)).toEqual(["did:plc:alice123"]);
  }, 20_000);

  test("a URL fragment does not produce a tag facet overlapping the link", async () => {
    const text = "See https://x.app/#pricing and #launch";
    const result = await blueskyProvider.createPost(credentials, { text });

    expect(result.success).toBe(true);
    const facets = lastFacets();
    const link = facets.find((f) => f.features[0]?.$type === "app.bsky.richtext.facet#link");
    const tags = facets.filter((f) => f.features[0]?.$type === "app.bsky.richtext.facet#tag");
    expect(link?.features[0].uri).toBe("https://x.app/#pricing");
    expect(tags.map((f) => f.features[0].tag)).toEqual(["launch"]);
    for (const tag of tags) {
      const overlaps =
        link !== undefined &&
        tag.index.byteStart < link.index.byteEnd &&
        link.index.byteStart < tag.index.byteEnd;
      expect(overlaps).toBe(false);
    }
  }, 20_000);

  test("a hashtag after punctuation is still a tag", async () => {
    const text = "Launch (#alpha) one,#two";
    const result = await blueskyProvider.createPost(credentials, { text });

    expect(result.success).toBe(true);
    const tags = lastFacets().filter((f) => f.features[0]?.$type === "app.bsky.richtext.facet#tag");
    expect(tags.map((f) => f.features[0].tag)).toEqual(["alpha", "two"]);
    const bytes = new TextEncoder().encode(text);
    const decoder = new TextDecoder();
    expect(
      tags.map((f) => decoder.decode(bytes.slice(f.index.byteStart, f.index.byteEnd))),
    ).toEqual(["#alpha", "#two"]);
  }, 20_000);

  test("a failed handle lookup fails the post instead of dropping the mention", async () => {
    const result = await blueskyProvider.createPost(credentials, {
      text: "Hi @busy.bsky.social",
    });

    expect(result.success).toBe(false);
    expect(createRecordBodies).toHaveLength(0);
  }, 20_000);
});

describe("blueskyProvider.createPost session failures", () => {
  // withRetry backs off 1s and 2s between the three createSession attempts.
  test("an exhausted createSession 5xx is a refundable failure, not a held unknown outcome", async () => {
    sessionResponse = () => new Response("upstream unavailable", { status: 503 });
    const result = await blueskyProvider.createPost(credentials, { text: "Never sent" });

    expect(createRecordBodies).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBeUndefined();
    expect(result.creditDisposition).toBeUndefined();
    expect(result.error).not.toContain("may have been published");
  }, 10_000);
});
