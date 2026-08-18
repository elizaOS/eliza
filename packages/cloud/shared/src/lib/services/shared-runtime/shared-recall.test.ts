/**
 * Pins the flag-gated semantic recall skeleton for the Shared edge runtime:
 * the native Workers AI request/response contract and typed failures, and the
 * miss-only orchestration (flag off / keyword hit / blank query never embed;
 * K-cap, char-cap, and recent-window dedupe bound the block). The harness is
 * deterministic: Workers AI and the orchestrator collaborators are injected
 * fakes.
 */

import { describe, expect, mock, test } from "bun:test";
import { CANONICAL_EMBEDDING_SPACE_FINGERPRINT, isElizaError } from "@elizaos/core/edge";
import type { RuntimeWorkersAiBinding } from "../../../types/cloud-worker-env";
import {
  buildSharedRecallContext,
  embedTextsViaWorkersAi,
  embedTextViaWorkersAi,
  SHARED_RECALL_DEFAULT_MAX_CHARS,
  SHARED_RECALL_DEFAULT_TOP_K,
  SHARED_RECALL_EDGE_COMPATIBILITY,
  SHARED_RECALL_EMBED_MAX_BATCH_SIZE,
  SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS,
  SHARED_RECALL_EMBED_MAX_INPUT_TOKENS,
  SHARED_RECALL_EMBED_TIMEOUT_MS,
  SHARED_RECALL_EMBEDDING_DIMENSIONS,
  SHARED_RECALL_EMBEDDING_MODEL,
  SHARED_RECALL_EMBEDDING_POOLING,
  SHARED_RECALL_WORKERS_AI_MODEL,
  type SharedRecallRow,
} from "./shared-recall";

function vectorOf(length: number): number[] {
  return Array.from({ length }, (_, index) => index / length);
}

function embeddingResponse(vectors: number[][], pooling: "mean" | "cls" = "cls") {
  return {
    shape: [vectors.length, vectors[0]?.length ?? 0],
    data: vectors,
    pooling,
  };
}

function aiReturning(payload: unknown): {
  ai: RuntimeWorkersAiBinding;
  calls: Array<{
    model: string;
    input: { text: string | string[]; pooling?: "mean" | "cls" };
    options?: { signal?: AbortSignal; tags?: string[] };
  }>;
} {
  const calls: Array<{
    model: string;
    input: { text: string | string[]; pooling?: "mean" | "cls" };
    options?: { signal?: AbortSignal; tags?: string[] };
  }> = [];
  return {
    calls,
    ai: {
      async run(model, input, options) {
        calls.push({ model, input, options });
        return payload;
      },
    },
  };
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

describe("Workers AI embedding request contract", () => {
  test("pins the model, CLS pooling, limits, timeout, and L2-normalized space", async () => {
    const raw = new Array(SHARED_RECALL_EMBEDDING_DIMENSIONS).fill(0);
    raw[0] = 3;
    raw[1] = 4;
    const { ai, calls } = aiReturning(embeddingResponse([raw]));

    const embedding = await embedTextViaWorkersAi(ai, "  what was my keyboard budget?  ");

    expect(SHARED_RECALL_WORKERS_AI_MODEL).toBe("@cf/baai/bge-small-en-v1.5");
    expect(SHARED_RECALL_EMBEDDING_MODEL).toBe(CANONICAL_EMBEDDING_SPACE_FINGERPRINT);
    expect(SHARED_RECALL_EMBEDDING_DIMENSIONS).toBe(384);
    expect(SHARED_RECALL_EMBEDDING_POOLING).toBe("cls");
    expect(SHARED_RECALL_EMBED_MAX_INPUT_TOKENS).toBe(512);
    expect(SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS).toBe(510);
    expect(SHARED_RECALL_EMBED_MAX_BATCH_SIZE).toBe(100);
    expect(SHARED_RECALL_EMBED_TIMEOUT_MS).toBe(5_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(SHARED_RECALL_WORKERS_AI_MODEL);
    expect(calls[0]?.input).toEqual({
      text: ["what was my keyboard budget?"],
      pooling: "cls",
    });
    expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.options?.signal?.aborted).toBe(false);
    expect(calls[0]?.options?.tags).toEqual(["eliza:shared-recall"]);
    expect(embedding).toHaveLength(SHARED_RECALL_EMBEDDING_DIMENSIONS);
    expect(embedding[0]).toBeCloseTo(0.6);
    expect(embedding[1]).toBeCloseTo(0.8);
    expect(Math.hypot(...embedding)).toBeCloseTo(1);
  });

  test("batches texts in input order and normalizes every vector", async () => {
    const first = new Array(SHARED_RECALL_EMBEDDING_DIMENSIONS).fill(0);
    first[0] = 2;
    const second = new Array(SHARED_RECALL_EMBEDDING_DIMENSIONS).fill(0);
    second[1] = 7;
    const { ai, calls } = aiReturning(embeddingResponse([first, second]));

    const vectors = await embedTextsViaWorkersAi(ai, [" user ", " assistant "]);

    expect(calls[0]?.input.text).toEqual(["user", "assistant"]);
    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[1]?.[1]).toBe(1);
  });

  test("rejects blank or oversized batches before invoking the binding", async () => {
    const { ai, calls } = aiReturning(embeddingResponse([]));

    await expectElizaError(embedTextViaWorkersAi(ai, "   "), "SHARED_RECALL_EMBEDDING_EMPTY_TEXT");
    const oversized = Array.from({ length: SHARED_RECALL_EMBED_MAX_BATCH_SIZE + 1 }, () => "x");
    const error = await expectElizaError(
      embedTextsViaWorkersAi(ai, oversized),
      "SHARED_RECALL_EMBEDDING_BATCH_LIMIT",
    );
    expect(error.context).toMatchObject({
      actual: SHARED_RECALL_EMBED_MAX_BATCH_SIZE + 1,
      max: SHARED_RECALL_EMBED_MAX_BATCH_SIZE,
    });
    const overLimit = await expectElizaError(
      embedTextViaWorkersAi(ai, "x".repeat(SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS + 1)),
      "SHARED_RECALL_EMBEDDING_INVALID_INPUT",
    );
    expect(overLimit.context).toMatchObject({
      index: 0,
      maxInputCodeUnits: SHARED_RECALL_EMBED_MAX_INPUT_CODE_UNITS,
    });
    await expectElizaError(
      embedTextViaWorkersAi(ai, "bad \uD83D input"),
      "SHARED_RECALL_EMBEDDING_INVALID_INPUT",
    );
    await expectElizaError(
      embedTextsViaWorkersAi(ai, ["ok", 42] as never),
      "SHARED_RECALL_EMBEDDING_INVALID_INPUT",
    );
    expect(calls).toHaveLength(0);
  });
});

describe("Workers AI embedding fail-closed validation", () => {
  test("a provider/timeout failure wraps as UNREACHABLE with its cause and contract", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const ai: RuntimeWorkersAiBinding = {
      async run() {
        throw timeout;
      },
    };

    const error = await expectElizaError(
      embedTextViaWorkersAi(ai, "hi"),
      "SHARED_RECALL_EMBEDDING_UNREACHABLE",
    );
    expect(error.cause).toBe(timeout);
    expect(error.context).toMatchObject({
      model: SHARED_RECALL_WORKERS_AI_MODEL,
      pooling: "cls",
      maxInputTokens: 512,
      timeoutMs: SHARED_RECALL_EMBED_TIMEOUT_MS,
    });
  });

  test("an async request id without vectors is invalid, never a fabricated result", async () => {
    const { ai } = aiReturning({ request_id: "queued-1" });
    const error = await expectElizaError(
      embedTextViaWorkersAi(ai, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context?.reason).toBe("invalid-vector-count");
  });

  test("rejects wrong pooling metadata", async () => {
    const { ai } = aiReturning(
      embeddingResponse([vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS)], "mean"),
    );
    const error = await expectElizaError(
      embedTextViaWorkersAi(ai, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context).toMatchObject({
      reason: "wrong-pooling",
      expected: "cls",
      actual: "mean",
    });
  });

  test("rejects shape metadata inconsistent with batch count and dimensions", async () => {
    const { ai } = aiReturning({
      shape: [1, 3],
      data: [vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS)],
      pooling: "cls",
    });
    const error = await expectElizaError(
      embedTextViaWorkersAi(ai, "hi"),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context).toMatchObject({
      reason: "wrong-shape",
      expected: [1, SHARED_RECALL_EMBEDDING_DIMENSIONS],
      actual: [1, 3],
    });
  });

  test("rejects wrong-dimensional vectors before vector(384) storage", async () => {
    const { ai } = aiReturning({
      data: [vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS), vectorOf(3)],
      pooling: "cls",
    });
    const error = await expectElizaError(
      embedTextsViaWorkersAi(ai, ["user", "assistant"]),
      "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
    );
    expect(error.context).toMatchObject({
      reason: "wrong-dimensions",
      index: 1,
      expected: SHARED_RECALL_EMBEDDING_DIMENSIONS,
      actual: 3,
    });
  });

  test("rejects non-finite and zero-norm vectors", async () => {
    const nonFinite = vectorOf(SHARED_RECALL_EMBEDDING_DIMENSIONS);
    nonFinite[7] = Number.NaN;
    const first = aiReturning(embeddingResponse([nonFinite]));
    expect(
      (
        await expectElizaError(
          embedTextViaWorkersAi(first.ai, "hi"),
          "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
        )
      ).context?.reason,
    ).toBe("non-finite-vector");

    const zero = new Array(SHARED_RECALL_EMBEDDING_DIMENSIONS).fill(0);
    const second = aiReturning(embeddingResponse([zero]));
    expect(
      (
        await expectElizaError(
          embedTextViaWorkersAi(second.ai, "hi"),
          "SHARED_RECALL_EMBEDDING_INVALID_RESPONSE",
        )
      ).context?.reason,
    ).toBe("invalid-l2-norm");
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
    const failure = new Error("embedding provider down");
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

describe("buildSharedRecallContext — output bounds", () => {
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

  test("caps rendered rows at topK, preserving the store's ranking order", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(8),
      topK: 3,
    });

    expect(block).toContain("fact number 0");
    expect(block).toContain("fact number 1");
    expect(block).toContain("fact number 2");
    expect(block).not.toContain("fact number 3");
    expect(block?.indexOf("fact number 0")).toBeLessThan(block?.indexOf("fact number 2") ?? -1);
  });

  test("defaults cap at SHARED_RECALL_DEFAULT_TOP_K rows", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(SHARED_RECALL_DEFAULT_TOP_K + 4),
    });

    expect(block).toContain(`fact number ${SHARED_RECALL_DEFAULT_TOP_K - 1}`);
    expect(block).not.toContain(`fact number ${SHARED_RECALL_DEFAULT_TOP_K}`);
  });

  test("caps total block characters and drops rows that would overflow", async () => {
    const maxChars = 220;
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(8),
      maxChars,
    });

    expect(block).not.toBeNull();
    expect((block as string).length).toBeLessThanOrEqual(maxChars);
    expect(block).toContain("fact number 0");
    expect(block).not.toContain("fact number 7");
  });

  test("stays within the default char cap even with maximal rows", async () => {
    const long = "x".repeat(5_000);
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () =>
        Array.from({ length: 10 }, (_, index) => ({
          id: `long-${index}`,
          content: `${long} ${index}`,
        })),
    });

    expect(block).not.toBeNull();
    expect((block as string).length).toBeLessThanOrEqual(SHARED_RECALL_DEFAULT_MAX_CHARS);
    // Per-row clipping keeps one huge row from starving every later match.
    expect(block).toContain("…");
  });

  test("returns null when the cap cannot fit a single row", async () => {
    const block = await buildSharedRecallContext({
      ...base,
      storeSearch: async () => rows(2),
      maxChars: 10,
    });

    expect(block).toBeNull();
  });
});

describe("SHARED_RECALL_EDGE_COMPATIBILITY", () => {
  test("declares the edge target with tenant-postgres state and its effect set", () => {
    expect(SHARED_RECALL_EDGE_COMPATIBILITY.target).toBe("edge");
    expect(SHARED_RECALL_EDGE_COMPATIBILITY.state).toBe("tenant-postgres");
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.effects]).toEqual([
      "tenant-postgres-read",
      "workers-ai-embeddings",
    ]);
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.requiredBindings]).toEqual(["HYPERDRIVE", "AI"]);
    expect([...SHARED_RECALL_EDGE_COMPATIBILITY.requiredSecrets]).toEqual([]);
  });
});
