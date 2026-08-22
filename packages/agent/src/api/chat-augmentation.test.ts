/**
 * Exercises chat document augmentation's latency contract: its pre-model
 * lookup is always lexical, empty corpora short-circuit, cancellation reaches
 * retrieval, and rewritten prompts reuse one clean-query embedding.
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
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

describe("maybeAugmentChatMessageWithDocuments", () => {
  it.each([["/help"], ["/model show"], ["!status"]])(
    "never rewrites a command turn (%s) — the deterministic command path needs the verbatim text",
    async (text) => {
      const message = makeMessage();
      (message.content as { text: string }).text = text;
      const documents = { searchDocuments: vi.fn() };
      const runtime = makeRuntime(documents);

      const result = await maybeAugmentChatMessageWithDocuments(
        runtime,
        message,
      );

      expect(result).toBe(message);
      // The skip happens before any retrieval work — no embed/search cost.
      expect(documents.searchDocuments).not.toHaveBeenCalled();
      expect(runtime.useModel).not.toHaveBeenCalled();
    },
  );

  it("propagates caller cancellation into document retrieval", async () => {
    const message = makeMessage();
    const controller = new AbortController();
    let retrievalSignal: AbortSignal | undefined;
    let signalRetrievalStarted: (() => void) | undefined;
    const retrievalStarted = new Promise<void>((resolve) => {
      signalRetrievalStarted = resolve;
    });
    const documents = {
      searchDocuments: vi.fn(
        (
          _message,
          _scope,
          _mode,
          _access,
          options?: { signal?: AbortSignal },
        ) => {
          retrievalSignal = options?.signal;
          signalRetrievalStarted?.();
          return new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options.signal?.reason),
              { once: true },
            );
          });
        },
      ),
    };
    const runtime = makeRuntime(documents);

    const augmentation = maybeAugmentChatMessageWithDocuments(
      runtime,
      message,
      {
        signal: controller.signal,
      },
    );
    await retrievalStarted;
    controller.abort(new Error("chat request cancelled"));

    await expect(augmentation).rejects.toThrow("chat request cancelled");
    expect(retrievalSignal).toBe(controller.signal);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(1);
    expect(runtime.useModel).not.toHaveBeenCalled();
  });

  it("keeps a lexical miss off the serial embedding and recovery-LLM paths", async () => {
    const message = makeMessage();
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "loosely related context" },
          similarity: 0.05,
          metadata: {},
        },
      ]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(1);
    expect(documents.searchDocuments.mock.calls[0]?.[2]).toBe("keyword");
    expect(useModel).not.toHaveBeenCalled();
  });

  it("does not invoke a model when lexical retrieval returns no candidates", async () => {
    const message = makeMessage();
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).toBe(message);
    expect(documents.searchDocuments).toHaveBeenCalledTimes(2);
    expect(runtime.useModel).not.toHaveBeenCalled();
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

  it("searches the corpus in keyword mode without a pre-model embed", async () => {
    const message = makeMessage();
    // Corpus is exactly the bundled seed set: keyword (BM25) search must be
    // requested so the turn never pays the blocking gateway embed, and the
    // seed corpus must never trigger the query-recovery model call even when
    // weak candidates fall below the relevance threshold.
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
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
    const [, , searchMode] = documents.searchDocuments.mock.calls[0];
    expect(searchMode).toBe("keyword");
    // Neither an embed nor the TEXT_LARGE recovery call may fire.
    expect(useModel).not.toHaveBeenCalled();
  });

  it("injects context on a real keyword match", async () => {
    const message = makeMessage();
    // A query that genuinely shares meaningful terms with the fragment — the
    // absolute coverage gate (#17028) requires literal query-term overlap,
    // not just a relative BM25 rank.
    (message.content as { text: string }).text =
      "how do i set the inference markup for monetization?";
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
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

  it("preserves every relevant lexical match beyond the former four-document cap", async () => {
    const message = makeMessage();
    (message.content as { text: string }).text = "alpha beta details";
    const matches = Array.from({ length: 7 }, (_, index) => ({
      content: { text: `Alpha beta detail ${index + 1}.` },
      similarity: 1 - index / 100,
      metadata: { filename: `detail-${index + 1}.txt` },
    }));
    const documents = {
      searchDocuments: vi.fn().mockResolvedValue(matches),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    for (let index = 1; index <= matches.length; index += 1) {
      expect(result.content.text).toContain(`Alpha beta detail ${index}.`);
    }
  });

  it("does not inject an unrelated help FAQ on a workout query (#17028)", async () => {
    // Keyword search max-normalizes BM25 within each result set, so the best
    // positive match reports similarity 1.0 even when the only shared words
    // are stopwords. Live this injected the navigation FAQ's "Do not ...
    // invoke tools/actions" envelope into a routine-creation turn. The
    // absolute query-term coverage gate must reject it.
    const message = makeMessage();
    (message.content as { text: string }).text =
      "can you help me schedule a workout every day";
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: {
            text: "How do I switch screens or views? Say the view name or ask me to open it.",
          },
          similarity: 1,
          metadata: { filename: "help-navigation.txt" },
        },
      ]),
    };
    const useModel = vi.fn();
    const runtime = makeRuntime(documents, useModel);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).toBe(message);
    expect(useModel).not.toHaveBeenCalled();
  });

  it("still injects a genuinely-answering help FAQ on a navigation ask (#17028)", async () => {
    const message = makeMessage();
    (message.content as { text: string }).text = "how do i switch views?";
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: {
            text: "How do I switch screens or views? Say the view name or ask me to open it.",
          },
          similarity: 1,
          metadata: { filename: "help-navigation.txt" },
        },
      ]),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).not.toBe(message);
    expect(result.content.text).toContain("<contextual_documents>");
  });

  it("keeps literal document relevance available for non-English scripts", async () => {
    const message = makeMessage();
    (message.content as { text: string }).text = "如何切换视图";
    const documents = {
      countMemories: vi.fn().mockResolvedValue(14),
      searchDocuments: vi.fn().mockResolvedValue([
        {
          content: { text: "帮助：如何切换视图。" },
          similarity: 1,
          metadata: { filename: "help-navigation-zh.txt" },
        },
      ]),
    };
    const runtime = makeRuntime(documents);

    const result = await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(result).not.toBe(message);
    expect(result.content.text).toContain("如何切换视图");
  });

  it("never injects for a query made only of stopwords", async () => {
    for (const query of ["what are you up to?", "this does not do it"]) {
      const message = makeMessage();
      (message.content as { text: string }).text = query;
      const documents = {
        countMemories: vi.fn().mockResolvedValue(14),
        searchDocuments: vi.fn().mockResolvedValue([
          {
            content: { text: "This does not do it either." },
            similarity: 1,
            metadata: { filename: "noise.txt" },
          },
        ]),
      };
      const runtime = makeRuntime(documents);

      const result = await maybeAugmentChatMessageWithDocuments(
        runtime,
        message,
      );

      expect(result).toBe(message);
    }
  });

  it("keeps uploaded corpora on the lexical pre-model path", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockResolvedValue(20),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const runtime = makeRuntime(documents);

    await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(
      documents.searchDocuments.mock.calls.every(
        (call) => call[2] === "keyword",
      ),
    ).toBe(true);
  });

  it("continues lexical retrieval when the empty-corpus optimization probe fails", async () => {
    const message = makeMessage();
    const documents = {
      countMemories: vi.fn().mockRejectedValue(new Error("count unavailable")),
      searchDocuments: vi.fn().mockResolvedValue([]),
    };
    const runtime = makeRuntime(documents);

    await maybeAugmentChatMessageWithDocuments(runtime, message);

    expect(documents.searchDocuments).toHaveBeenCalled();
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ src: "api:chat-augmentation" }),
      "Document fragment count failed; continuing with retrieval",
    );
  });

  it("aliases the augmentation envelope onto the clean prompt's recall embed — in-run recall of the rewritten text issues zero new embeds", async () => {
    const message = makeMessage();
    // Meaningful-term overlap with the fragment so the absolute coverage
    // gate (#17028) admits the injection this test depends on.
    (message.content as { text: string }).text = "tell me the qa codeword";
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
    expect(embedCalls).toEqual(["tell me the qa codeword"]);

    // …and the in-run recall callers presenting the ENVELOPE text (as the
    // message-service prefetch and relevant-conversations provider do) resolve
    // the aliased vector with no additional embed.
    const envelopeText = result.content.text as string;
    const vec = await embedRecallQuery(runtime, envelopeText, {
      messageId: message.id as string,
    });
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(embedCalls).toEqual(["tell me the qa codeword"]);
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
