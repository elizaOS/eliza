import { describe, expect, it, vi } from "vitest";
import {
  buildTokenTreeDescriptor,
  buildTokenTrie,
  countTerminals,
  estimateTrieBytes,
  isUniqueContinuation,
  step,
  TRIE_ROOT_TOKEN_ID,
} from "./token-tree";
import { TokenizerClient } from "./tokenizer-client";

describe("buildTokenTrie", () => {
  it("returns an empty root for an empty input", () => {
    const trie = buildTokenTrie([]);
    expect(trie.tokenId).toBe(TRIE_ROOT_TOKEN_ID);
    expect(trie.children.size).toBe(0);
    expect(trie.isTerminal).toBe(false);
    expect(countTerminals(trie)).toBe(0);
  });

  it("skips leaves with empty token sequences", () => {
    const trie = buildTokenTrie([
      { name: "EMPTY", tokens: [] },
      { name: "REPLY", tokens: [12, 34] },
    ]);
    expect(countTerminals(trie)).toBe(1);
    const node12 = step(trie, 12);
    expect(node12).not.toBeNull();
    const node34 = step(node12!, 34);
    expect(node34?.isTerminal).toBe(true);
    expect(node34?.leafName).toBe("REPLY");
  });

  it("shares prefixes across leaves with a common start", () => {
    const trie = buildTokenTrie([
      { name: "OWNER_REMINDERS", tokens: [10, 20, 30] },
      { name: "OWNER_ACTIONS", tokens: [10, 20, 40] },
    ]);
    // Both leaves share the [10, 20] prefix; the divergence is at depth 2.
    expect(trie.children.size).toBe(1);
    const a = step(trie, 10)!;
    expect(a.children.size).toBe(1);
    const b = step(a, 20)!;
    expect(b.children.size).toBe(2);
    expect(b.isTerminal).toBe(false);
    const reminders = step(b, 30)!;
    const actions = step(b, 40)!;
    expect(reminders.isTerminal).toBe(true);
    expect(reminders.leafName).toBe("OWNER_REMINDERS");
    expect(actions.isTerminal).toBe(true);
    expect(actions.leafName).toBe("OWNER_ACTIONS");
    expect(countTerminals(trie)).toBe(2);
  });

  it("marks an inner node terminal when one leaf is a strict prefix of another", () => {
    const trie = buildTokenTrie([
      { name: "REPLY", tokens: [1, 2] },
      { name: "REPLY_THREAD", tokens: [1, 2, 3] },
    ]);
    const inner = step(step(trie, 1)!, 2)!;
    expect(inner.isTerminal).toBe(true);
    expect(inner.leafName).toBe("REPLY");
    expect(inner.children.size).toBe(1);
    expect(isUniqueContinuation(inner)).toBe(false); // has children
    const leaf = step(inner, 3)!;
    expect(isUniqueContinuation(leaf)).toBe(true); // no children, terminal
  });

  it("collapses duplicate token paths to one terminal with the smallest leafName", () => {
    const trie = buildTokenTrie([
      { name: "ZULU", tokens: [7, 8] },
      { name: "ALPHA", tokens: [7, 8] },
    ]);
    expect(countTerminals(trie)).toBe(1);
    const node = step(step(trie, 7)!, 8)!;
    expect(node.isTerminal).toBe(true);
    expect(node.leafName).toBe("ALPHA");
  });

  it("step returns null for an out-of-vocabulary continuation", () => {
    const trie = buildTokenTrie([{ name: "X", tokens: [99] }]);
    expect(step(trie, 99)?.isTerminal).toBe(true);
    expect(step(trie, 100)).toBeNull();
  });

  it("estimateTrieBytes scales with node count", () => {
    const small = buildTokenTrie([{ name: "X", tokens: [1] }]);
    const large = buildTokenTrie([
      { name: "A", tokens: [1, 2, 3, 4, 5] },
      { name: "B", tokens: [6, 7, 8, 9, 10] },
      { name: "C", tokens: [11, 12, 13, 14, 15] },
    ]);
    expect(estimateTrieBytes(large)).toBeGreaterThan(estimateTrieBytes(small));
  });
});

describe("buildTokenTreeDescriptor", () => {
  it("returns null when no name has tokens", () => {
    const map = new Map<string, number[]>();
    expect(buildTokenTreeDescriptor("action", ["FOO", "BAR"], map)).toBeNull();
  });

  it("skips names without a tokenization", () => {
    const map = new Map([["REPLY", [1, 2]]]);
    const descriptor = buildTokenTreeDescriptor(
      "action",
      ["MISSING", "REPLY"],
      map,
    );
    expect(descriptor).not.toBeNull();
    expect(descriptor?.leaves).toHaveLength(1);
    expect(descriptor?.leaves[0].name).toBe("REPLY");
  });

  it("deduplicates repeated names while preserving the first occurrence", () => {
    const map = new Map([
      ["A", [1]],
      ["B", [2]],
    ]);
    const descriptor = buildTokenTreeDescriptor("action", ["A", "B", "A"], map);
    expect(descriptor?.leaves).toHaveLength(2);
  });

  it("sorts leaves by name for byte-stable output", () => {
    const map = new Map([
      ["ZULU", [99]],
      ["ALPHA", [10]],
      ["MIKE", [50]],
    ]);
    const d1 = buildTokenTreeDescriptor(
      "action",
      ["ZULU", "ALPHA", "MIKE"],
      map,
    );
    const d2 = buildTokenTreeDescriptor(
      "action",
      ["MIKE", "ALPHA", "ZULU"],
      map,
    );
    expect(d1?.leaves.map((l) => l.name)).toEqual(["ALPHA", "MIKE", "ZULU"]);
    expect(d1?.leaves).toEqual(d2?.leaves);
  });

  it("path is preserved verbatim", () => {
    const map = new Map([["X", [1]]]);
    const descriptor = buildTokenTreeDescriptor(
      "parameters.agentType",
      ["X"],
      map,
    );
    expect(descriptor?.path).toBe("parameters.agentType");
  });
});

describe("TokenizerClient", () => {
  function makeStubFetch(
    responses: Record<string, number[]>,
    calls: { count: number; texts: string[] } = { count: 0, texts: [] },
  ): typeof fetch {
    const stub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.count += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
      };
      calls.texts.push(body.content);
      const tokens = responses[body.content];
      if (!tokens) throw new Error(`stub: no response for ${body.content}`);
      return new Response(JSON.stringify({ tokens }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return stub as unknown as typeof fetch;
  }

  it("calls /tokenize on a cold miss and caches the result", async () => {
    const calls = { count: 0, texts: [] as string[] };
    const stub = makeStubFetch({ REPLY: [1, 2, 3] }, calls);
    const client = new TokenizerClient({ fetch: stub });
    const a = await client.tokenize("model-a", "http://localhost", "REPLY");
    const b = await client.tokenize("model-a", "http://localhost", "REPLY");
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1, 2, 3]);
    expect(calls.count).toBe(1); // second call hit the cache
    expect(client.cachedSize("model-a")).toBe(1);
  });

  it("tokenizeMany batches requests and respects the cache", async () => {
    const calls = { count: 0, texts: [] as string[] };
    const stub = makeStubFetch({ A: [1], B: [2], C: [3] }, calls);
    const client = new TokenizerClient({ fetch: stub });
    // Prime the cache for A.
    await client.tokenize("model-a", "http://localhost", "A");
    expect(calls.count).toBe(1);
    const result = await client.tokenizeMany("model-a", "http://localhost", [
      "A",
      "B",
      "C",
      "B",
    ]);
    // 1 prime + 2 fresh fetches (B & C; the duplicate B is dedup'd).
    expect(calls.count).toBe(3);
    expect(result.get("A")).toEqual([1]);
    expect(result.get("B")).toEqual([2]);
    expect(result.get("C")).toEqual([3]);
  });

  it("namespaces caches per modelId", async () => {
    const calls = { count: 0, texts: [] as string[] };
    const stub = makeStubFetch({ FOO: [42] }, calls);
    const client = new TokenizerClient({ fetch: stub });
    await client.tokenize("model-a", "http://x", "FOO");
    await client.tokenize("model-b", "http://x", "FOO");
    expect(calls.count).toBe(2); // each model required its own fetch
    expect(client.cachedSize("model-a")).toBe(1);
    expect(client.cachedSize("model-b")).toBe(1);
  });

  it("forgetModel evicts the per-model cache", async () => {
    const calls = { count: 0, texts: [] as string[] };
    const stub = makeStubFetch({ FOO: [1] }, calls);
    const client = new TokenizerClient({ fetch: stub });
    await client.tokenize("model-a", "http://x", "FOO");
    expect(client.cachedSize("model-a")).toBe(1);
    client.forgetModel("model-a");
    expect(client.cachedSize("model-a")).toBe(0);
    await client.tokenize("model-a", "http://x", "FOO");
    expect(calls.count).toBe(2); // refetched after eviction
  });

  it("evicts when the per-model cap is exceeded", async () => {
    const stub = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
      };
      return new Response(
        JSON.stringify({ tokens: [body.content.charCodeAt(0)] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = new TokenizerClient({
      fetch: stub,
      maxEntriesPerModel: 2,
    });
    await client.tokenize("model-a", "http://x", "A");
    await client.tokenize("model-a", "http://x", "B");
    expect(client.cachedSize("model-a")).toBe(2);
    // Crossing the cap clears the per-model cache.
    await client.tokenize("model-a", "http://x", "C");
    expect(client.cachedSize("model-a")).toBeLessThanOrEqual(2);
  });

  it("throws a useful error when /tokenize returns a non-2xx", async () => {
    const stub = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    const client = new TokenizerClient({ fetch: stub });
    await expect(client.tokenize("model-a", "http://x", "FOO")).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("throws when /tokenize body is missing the tokens array", async () => {
    const stub = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const client = new TokenizerClient({ fetch: stub });
    await expect(client.tokenize("model-a", "http://x", "FOO")).rejects.toThrow(
      /tokens\[\]/,
    );
  });
});

describe("end-to-end: TokenizerClient → buildTokenTrie", () => {
  it("assembles a turn-scoped trie from a mock /tokenize backend", async () => {
    const stub = vi.fn(async (_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content: string;
      };
      const fixture: Record<string, number[]> = {
        REPLY: [1, 2],
        OWNER_REMINDERS: [3, 4, 5],
        OWNER_ACTIONS: [3, 4, 6],
        STOP: [9],
      };
      return new Response(
        JSON.stringify({ tokens: fixture[body.content] ?? [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = new TokenizerClient({ fetch: stub });

    // Turn 1: only REPLY + STOP exposed.
    const tokens1 = await client.tokenizeMany("eliza-1-4b", "http://x", [
      "REPLY",
      "STOP",
    ]);
    const desc1 = buildTokenTreeDescriptor(
      "action",
      ["REPLY", "STOP"],
      tokens1,
    );
    if (!desc1) throw new Error("desc1 unexpectedly undefined");
    const trie1 = buildTokenTrie(desc1.leaves);
    expect(countTerminals(trie1)).toBe(2);
    // OWNER_REMINDERS was NOT exposed this turn -> not reachable.
    expect(trie1.children.has(3)).toBe(false);

    // Turn 2: full action set; cached tokens reused for REPLY + STOP.
    const tokens2 = await client.tokenizeMany("eliza-1-4b", "http://x", [
      "REPLY",
      "STOP",
      "OWNER_REMINDERS",
      "OWNER_ACTIONS",
    ]);
    const desc2 = buildTokenTreeDescriptor(
      "action",
      ["REPLY", "STOP", "OWNER_REMINDERS", "OWNER_ACTIONS"],
      tokens2,
    );
    if (!desc2) throw new Error("desc2 unexpectedly undefined");
    const trie2 = buildTokenTrie(desc2.leaves);
    expect(countTerminals(trie2)).toBe(4);
    // Prefix sharing on OWNER_*: [3, 4] is shared.
    const ownerPrefix = step(step(trie2, 3)!, 4)!;
    expect(ownerPrefix.children.size).toBe(2);
    // Leaf ordering inside descriptor is name-sorted.
    expect(desc2?.leaves.map((l) => l.name)).toEqual([
      "OWNER_ACTIONS",
      "OWNER_REMINDERS",
      "REPLY",
      "STOP",
    ]);
  });
});
