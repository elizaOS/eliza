/**
 * Unit tests for `maybeAugmentChatMessageWithDocuments`: the optional document
 * context must stay off the critical chat path — the lookup and LLM
 * query-recovery calls are time-bounded and aborted, recovery only fires when
 * weak candidates exist, an empty corpus short-circuits before any
 * embed/search, a seed-only corpus (bundled default docs) searches in keyword
 * mode with no embed round-trip and no recovery call, and a rewrite aliases
 * the envelope text onto the clean prompt's per-turn recall embed so in-run
 * recall never re-embeds. Uses a mocked documents service and useModel; no
 * live model.
 */
import type { AgentRuntime, createMessageMemory } from "@elizaos/core";
import { embedRecallQuery, ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { maybeAugmentChatMessageWithDocuments } from "./chat-augmentation.ts";

function makeMessage(): ReturnType<typeof createMessageMemory> {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    agentId: "00000000-0000-0000-0000-0000000000aa",
    entityId: "00000000-0000-0000-0000-0000000000bb",
    roomId: "00000000-0000-0000-0000-0000000000cc",
    content: { text: "what are you up to?" },
    createdAt: Date.now(),
  } as unknown as ReturnType<typeof createMessageMemory>;
}

function makeRuntime(
  documentsService: unknown,
  useModel = vi.fn(),
): AgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getService: vi.fn((name: string) =>
      name === "documents" ? documentsService : null,
    ),
    getServiceLoadPromise: vi.fn(),
    useModel,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

describe("maybeAugmentChatMessageWithDocuments", () => {
  it("skips optional document context when lookup exceeds its budget", async () => {
    const message = makeMessage();
    const documents = {
      searchDocuments: vi.fn(
        () =>
          new Promise<never>(() => {
            // Simulate a wedged retrieval backend.
          }),
      ),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        lookupTimeoutMs: 10,
        recoveryTimeoutMs: 10,
      },
    );

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        src: "api:chat-augmentation",
        timeoutMs: 10,
      }),
      "Document lookup timed out; skipping optional document context",
    );
  });

  it("bounds and aborts LLM query recovery before the real chat turn", async () => {
    const message = makeMessage();
    // The corpus returns a candidate that falls BELOW the relevance threshold:
    // documents exist, so a better recovered query is worth attempting. (This is
    // the only case the recovery call should fire.)
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "loosely related context" },
          similarity: 0.05,
          metadata: {},
        },
      ]),
    };
    let recoverySignal: AbortSignal | undefined;
    const useModel = vi.fn((_modelType, params) => {
      recoverySignal = params.signal;
      return new Promise<never>(() => {
        // Simulate a local model request that does not finish on its own.
      });
    });
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        lookupTimeoutMs: 10,
        recoveryTimeoutMs: 10,
      },
    );

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(1);
    expect(useModel).toHaveBeenCalledWith(
      "TEXT_LARGE",
      expect.objectContaining({
        maxTokens: 96,
        responseFormat: { type: "json_object" },
        signal: expect.any(AbortSignal),
        temperature: 0,
      }),
    );
    expect(recoverySignal?.aborted).toBe(true);
  });

  it("skips LLM query recovery when the corpus returns no candidates at all", async () => {
    const message = makeMessage();
    // No raw candidates at all (no documents indexed, or embeddings never clear
    // retrieval). A recovered query would match nothing either, so the recovery
    // model call is pure per-turn waste — it must NOT fire.
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        lookupTimeoutMs: 10,
        recoveryTimeoutMs: 10,
      },
    );

    expect(result).toBe(message);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("skips the embedding doc search entirely when the corpus has zero fragments", async () => {
    const message = makeMessage();
    // Empty corpus (the common cloud-agent case): the query embed + fragment
    // search is pure per-turn latency for guaranteed-zero matches. A cheap
    // fragment count must short-circuit BEFORE searchDocuments embeds anything.
    const documents = {
      countMemories: vi.fn().mockResolvedValue(0),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).toBe(message);
    expect(documents.countMemories).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "document_fragments" }),
    );
    expect(documents.searchDocuments).not.toHaveBeenCalled();
    expect(useModel).not.toHaveBeenCalled();
  });

  it("still runs the document search when the corpus has fragments", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(3),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const runtime = makeRuntime(documents);

    await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(documents.countMemories).toHaveBeenCalledTimes(1);
    expect(documents.searchDocuments).toHaveBeenCalled();
  });

  it("searches a seed-only corpus in keyword mode — no embed round-trip, no LLM recovery, and no injection for a zero-overlap query", async () => {
    const message = makeMessage();
    // Corpus is exactly the bundled seed set: keyword (BM25) search must be
    // requested so the turn never pays the blocking gateway embed, and the
    // seed corpus must never trigger the query-recovery model call even when
    // weak candidates fall below the relevance threshold.
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
      getMemories: vi
        .fn()
        .mockResolvedValue([
          { metadata: { addedFrom: "default-seed" } },
          { metadata: { addedFrom: "default-seed" } },
        ]),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "weakly overlapping FAQ fragment" },
          similarity: 0.1,
          metadata: {},
        },
      ]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).toBe(message);
    expect(documents.getMemories).toHaveBeenCalledWith(
      expect.objectContaining({ tableName: "documents" }),
    );
    const [, , searchMode] = documents.searchDocuments.mock.calls[0];
    expect(searchMode).toBe("keyword");
    // Neither an embed nor the TEXT_LARGE recovery call may fire.
    expect(useModel).not.toHaveBeenCalled();
  });

  it("still injects seed-FAQ context on a real keyword match — the seed-only gate skips the embed, not the lookup", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
      getMemories: vi
        .fn()
        .mockResolvedValue([{ metadata: { addedFrom: "default-seed" } }]),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "Eliza Cloud monetization: set inference markup." },
          similarity: 0.85,
          metadata: { filename: "eliza-cloud-monetization.txt" },
        },
      ]),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).not.toBe(message);
    expect(result.content.text).toContain("<contextual_documents>");
    expect(result.content.text).toContain("set inference markup");
    const [, , searchMode] = documents.searchDocuments.mock.calls[0];
    expect(searchMode).toBe("keyword");
  });

  it("keeps the full hybrid path when any non-seed document exists", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(20),
      getMemories: vi
        .fn()
        .mockResolvedValue([
          { metadata: { addedFrom: "default-seed" } },
          { metadata: { addedFrom: "upload" } },
        ]),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const runtime = makeRuntime(documents);

    await maybeAugmentChatMessageWithDocuments(runtime, message);

    const [, , searchMode] = documents.searchDocuments.mock.calls[0];
    expect(searchMode).toBeUndefined();
  });

  it("fails open to the hybrid path when the seed probe errors or the corpus exceeds the probe cap", async () => {
    const probeCases = [
      // Probe rejects → classification unknown → full retrieval path.
      vi.fn().mockRejectedValue(new Error("documents table unavailable")),
      // Corpus at the probe cap → cannot be the bundled seed set → hybrid,
      // even though every probed row carries the seed marker.
      vi.fn().mockResolvedValue(
        Array.from({ length: 32 }, () => ({
          metadata: { addedFrom: "default-seed" },
        })),
      ),
    ];
    for (const getMemories of probeCases) {
      const message = makeMessage();
      const documents = {
        countMemories: vi.fn().mockResolvedValue(40),
        getMemories,
        searchDocuments: vi.fn().mockResolvedValue([]),
      };
      const runtime = makeRuntime(documents);

      await maybeAugmentChatMessageWithDocuments(runtime, message);

      const [, , searchMode] = documents.searchDocuments.mock.calls[0];
      expect(searchMode).toBeUndefined();
    }
  });

  it("aliases the augmentation envelope onto the clean prompt's recall embed — in-run recall of the rewritten text issues zero new embeds", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(3),
      getMemories: vi
        .fn()
        .mockResolvedValue([{ metadata: { addedFrom: "upload" } }]),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "The QA codeword is BLUEBIRD." },
          similarity: 0.9,
          metadata: { filename: "qa.txt" },
        },
      ]),
    };
    const embedCalls: string[] = [];
    const useModel = vi.fn(
      async (modelType: string, params: { text: string }) => {
        if (modelType !== ModelType.TEXT_EMBEDDING) {
          throw new Error(`unexpected model ${modelType}`);
        }
        embedCalls.push(params.text);
        return [0.1, 0.2, 0.3];
      },
    );
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);
    expect(result).not.toBe(message);
    expect(result.content.text).toContain("<contextual_documents>");

    // The rewrite warmed ONE embed of the clean prompt (the mocked service
    // never embedded, so the warm is the turn's only round-trip)…
    expect(embedCalls).toEqual(["what are you up to?"]);

    // …and the in-run recall callers presenting the ENVELOPE text (as the
    // message-service prefetch and relevant-conversations provider do) resolve
    // the aliased vector with no additional embed.
    const envelopeText = result.content.text as string;
    const vec = await embedRecallQuery(runtime, envelopeText, {
      messageId: message.id as string,
    });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(embedCalls).toEqual(["what are you up to?"]);
  });

  it("passes the original message id as turnMessageId so the in-run recall embed adopts this pre-run embed (#15253)", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(3),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const runtime = makeRuntime(documents);

    await maybeAugmentChatMessageWithDocuments(runtime, message);

    // The turn key travels via the 5th `options` arg, NOT the search message —
    // whose id is deliberately a fresh UUID for the scope-read coercion.
    const [searchMessage, , , , options] =
      documents.searchDocuments.mock.calls[0];
    expect(options).toEqual({ turnMessageId: message.id });
    expect(searchMessage.id).not.toBe(message.id);
    expect(typeof searchMessage.id).toBe("string");
  });
});
