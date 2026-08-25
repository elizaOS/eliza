/**
 * Pins the flag-gated semantic recall skeleton for the Shared edge runtime:
 * the sidecar embedding call's request/response contract and typed failures,
 * and the miss-only orchestration (flag off / keyword hit / blank query never
 * embed; complete ranked recall and recent-window dedupe shape the block). The
 * harness is deterministic — the global fetch is stubbed and restored, and the
 * orchestrator's collaborators are injected fakes.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { isElizaError } from "@elizaos/core/edge";
import {
  buildSharedRecallContext,
  embedTextsViaSidecar,
  embedTextViaSidecar,
  SHARED_RECALL_EDGE_COMPATIBILITY,
  SHARED_RECALL_EMBED_TIMEOUT_MS,
  SHARED_RECALL_EMBEDDING_DIMENSIONS,
  SHARED_RECALL_EMBEDDING_MODEL,
  type SharedRecallRow,
} from "./shared-recall";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_, index) => index / length);
}

function embeddingResponse(embedding: number[]): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding }],
      model: SHARED_RECALL_EMBEDDING_MODEL,
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function expectElizaError(
  promise: Promise<unknown>,
  code: string,
): Promise<{ code: string; context?: Record<string, unknown>; cause?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (!isElizaError(error)) throw new Error(`expected ElizaError, got ${String(error)}`);
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected rejection with ${code}, but the promise resolved`);
}

describe("embedTextViaSidecar — request contract", () => {
  test("POSTs the OpenAI embeddings shape with auth and a bounded abort signal", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return embeddingResponse(vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS));
    }) as unknown as typeof fetch;

    const embedding = await embedTextViaSidecar(
      "https://sidecar.internal/",
      "sk-sidecar",
      "what was my keyboard budget?",
    );

    expect(embedding).toHaveLength(SHARED_RECALL_EMBEDDING_DIMENSIONS);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://sidecar.internal/v1/embeddings");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer sk-sidecar");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      input: "what was my keyboard budget?",
      model: SHARED_RECALL_EMBEDDING_MODEL,
    });
    const signal = calls[0].init.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);
    expect(SHARED_RECALL_EMBED_TIMEOUT_MS).toBe(5_000);
  });

  test("omits the authorization header when the sidecar needs no key", async () => {
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return embeddingResponse(vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS));
    }) as unknown as typeof fetch;

    await embedTextViaSidecar("https://sidecar.internal", undefined, "hello");

    expect("authorization" in seenHeaders).toBe(false);
  });

  test("rejects blank input before any network call", async () => {
    const fetchSpy = mock(async () => embeddingResponse([]));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "   "),
      "SHARED_RECALL_EMBEDDING_EMPTY_TEXT",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("embedTextViaSidecar — typed failure surface", () => {
  test("a timeout/network failure wraps as UNREACHABLE with the cause preserved", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    globalThis.fetch = (async () => {
      throw timeout;
    }) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "hi"),
      "SHARED_RECALL_EMBEDDING_UNREACHABLE",
    );
    expect(error.cause).toBe(timeout);
    expect(error.context?.timeoutMs).toBe(SHARED_RECALL_EMBED_TIMEOUT_MS);
  });

  test("a non-2xx status is a typed HTTP error carrying the status", async () => {
    globalThis.fetch = (async () =>
      new Response("busy", { status: 503 })) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "hi"),
      "SHARED_RECALL_EMBEDDING_HTTP_ERROR",
    );
    expect(error.context?.status).toBe(503);
  });

  test("a non-JSON 2xx body is an invalid-response failure, not a fake vector", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context?.reason).toBe("non-json-body");
  });

  test("a JSON body without a numeric embedding is invalid", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: ["not", "numbers"] }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context?.reason).toBe("missing-embedding");
  });

  test("a wrong-dimensionality vector is rejected, never returned", async () => {
    globalThis.fetch = (async () => embeddingResponse(vectorOf(3))) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextViaSidecar("https://sidecar.internal", undefined, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context?.reason).toBe("wrong-dimensions");
    expect(error.context?.expected).toBe(SHARED_RECALL_EMBEDDING_DIMENSIONS);
    expect(error.context?.actual).toBe(3);
  });
});

describe("embedTextsViaSidecar — batch validation", () => {
  test("rejects a wrong-dimensional vector before it can reach vector(384) storage", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { embedding: vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS) },
            { embedding: vectorOf(3) },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextsViaSidecar("https://sidecar.internal", undefined, ["user", "assistant"]),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context).toMatchObject({
      reason: "wrong-dimensions",
      index: 1,
      expected: SHARED_RECALL_EMBEDDING_DIMENSIONS,
      actual: 3,
    });
  });

  test("classifies a non-JSON success body as an invalid batch response", async () => {
    globalThis.fetch = (async () =>
      new Response("upstream proxy", { status: 200 })) as unknown as typeof fetch;

    const error = await expectElizaError(
      embedTextsViaSidecar("https://sidecar.internal", undefined, ["user", "assistant"]),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context?.reason).toBe("non-json-body");
  });
});

describe("buildSharedRecallContext — gating", () => {
  const row = (id: string, content: string, createdAt?: number): SharedRecallRow => ({
    id,
    role: "user",
    content,
    ...(createdAt === undefined ? {} : { createdAt }),
  });

  function collaborators(rows: SharedRecallRow[]) {
    const embed = mock(async () => vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS));
    const storeSearch = mock(async () => rows);
    return { embed, storeSearch };
  }

  test("flag off returns null without invoking embed or search", async () => {
    const { embed, storeSearch } = collaborators([row("a", "budget is $150")]);

    const block = await buildSharedRecallContext({
      flagEnabled: false,
      hadKeywordHit: false,
      queryText: "whats my keyboard budget",
      history: [],
      embed,
      storeSearch,
    });

    expect(block).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(storeSearch).not.toHaveBeenCalled();
  });

  test("a keyword hit short-circuits to null — embedding search is the miss fallback", async () => {
    const { embed, storeSearch } = collaborators([row("a", "budget is $150")]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: true,
      queryText: "whats my keyboard budget",
      history: [],
      embed,
      storeSearch,
    });

    expect(block).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(storeSearch).not.toHaveBeenCalled();
  });

  test("a blank query returns null without embedding", async () => {
    const { embed, storeSearch } = collaborators([row("a", "budget is $150")]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "   ",
      history: [],
      embed,
      storeSearch,
    });

    expect(block).toBeNull();
    expect(embed).not.toHaveBeenCalled();
    expect(storeSearch).not.toHaveBeenCalled();
  });

  test("a genuine miss embeds the trimmed query and searches with that vector", async () => {
    const vector = vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS);
    const embeddedTexts: string[] = [];
    const embed = async (text: string) => {
      embeddedTexts.push(text);
      return vector;
    };
    let searchedWith: number[] | undefined;
    const storeSearch = mock(async (v: number[]) => {
      searchedWith = v;
      return [row("a", "my keyboard budget is $150 max", 1_754_000_000_000)];
    });

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "  whats my keyboard budget  ",
      history: [],
      embed,
      storeSearch,
    });

    expect(embeddedTexts).toEqual(["whats my keyboard budget"]);
    expect(searchedWith).toBe(vector);
    expect(block).toContain("my keyboard budget is $150 max");
    expect(block).toContain("[user 2025-07-31]");
    expect(block?.startsWith("Recalled from earlier in this conversation")).toBe(true);
  });

  test("embed failures propagate to the caller — the orchestrator owns no degrade policy", async () => {
    const failure = new Error("sidecar down");
    const storeSearch = mock(async () => [row("a", "anything")]);

    await expect(
      buildSharedRecallContext({
        flagEnabled: true,
        hadKeywordHit: false,
        queryText: "question",
        history: [],
        embed: async () => {
          throw failure;
        },
        storeSearch,
      }),
    ).rejects.toBe(failure);
    expect(storeSearch).not.toHaveBeenCalled();
  });

  test("empty search results return null, not an empty header block", async () => {
    const { embed, storeSearch } = collaborators([]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "question",
      history: [],
      embed,
      storeSearch,
    });

    expect(block).toBeNull();
  });

  test("rows already inside the recent window are dropped by id and by content", async () => {
    const { embed, storeSearch } = collaborators([
      row("in-window", "we settled on the blue keycaps"),
      { content: "  my keyboard budget is $150 max  " },
      row("fresh", "the switches are gateron reds"),
    ]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "keyboard question",
      history: [
        { id: "in-window", role: "assistant", content: "we settled on the blue keycaps" },
        { role: "user", content: "my keyboard budget is $150 max" },
      ],
      embed,
      storeSearch,
    });

    expect(block).toContain("the switches are gateron reds");
    expect(block).not.toContain("blue keycaps");
    expect(block).not.toContain("$150 max");
  });

  test("returns null when every match is already in the recent window", async () => {
    const { embed, storeSearch } = collaborators([row("known", "old news")]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "question",
      history: [{ id: "known", role: "user", content: "old news" }],
      embed,
      storeSearch,
    });

    expect(block).toBeNull();
  });

  test("blank-content rows are filtered before ranking against the K cap", async () => {
    const { embed, storeSearch } = collaborators([
      { id: "blank", content: "   " },
      row("real", "an actual older fact"),
    ]);

    const block = await buildSharedRecallContext({
      flagEnabled: true,
      hadKeywordHit: false,
      queryText: "question",
      history: [],
      embed,
      storeSearch,
    });

    expect(block).toContain("an actual older fact");
    expect(block).not.toContain("[message]   ");
  });
});

describe("buildSharedRecallContext — complete output", () => {
  function rows(count: number): SharedRecallRow[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `row-${index}`,
      role: "user" as const,
      content: `distinct recalled fact number ${index}`,
    }));
  }

  const base = {
    flagEnabled: true,
    hadKeywordHit: false,
    queryText: "question",
    history: [] as const,
    embed: async () => vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS),
  };

  test("ignores the legacy topK option and preserves every ranked row", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(8),
      topK: 3,
    });

    expect(block).toContain("fact number 0");
    expect(block).toContain("fact number 1");
    expect(block).toContain("fact number 2");
    expect(block).toContain("fact number 7");
    expect(block?.indexOf("fact number 0")).toBeLessThan(block?.indexOf("fact number 2") ?? -1);
  });

  test("ignores the legacy character option and retains every row", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(8),
      maxChars: 220,
    });

    expect(block).not.toBeNull();
    expect(block).toContain("fact number 0");
    expect(block).toContain("fact number 7");
  });

  test("retains complete million-character recalled rows", async () => {
    const long = "x".repeat(110_000);
    const block = await buildSharedRecallContext(
      {
        ...base,
        storeSearch: async () =>
          Array.from({ length: 10 }, (_, index) => ({
            id: `long-${index}`,
            content: `${long} ${index}`,
          })),
      },
      20_000,
    );

    expect(block).not.toBeNull();
    expect(block).toContain(`${long} 0`);
    expect(block).toContain(`${long} 9`);
    expect(block).not.toContain("…");
  });

  test("renders rows even when the legacy cap could not fit one", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(2),
      maxChars: 10,
    });

    expect(block).toContain("fact number 0");
    expect(block).toContain("fact number 1");
  });
});

describe("SHARED_RECALL_EDGE_COMPATIBILITY", () => {
  test("declares the edge target with tenant-postgres state and its effect set", () => {
    expect(SHARED_RECALL_EDGE_COMPATIBILITY.target).toBe("edge");
    expect(SHARED_RECALL_EDGE_COMPATIBILITY.state).toBe("tenant-postgres");
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.effects]).toEqual([
      "tenant-postgres-read",
      "sidecar-embeddings",
    ]);
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.requiredBindings]).toEqual(["HYPERDRIVE"]);
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.requiredSecrets]).toEqual([]);
  });
});
