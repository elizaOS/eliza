/**
 * Scenario-owned deterministic embedding surface for DocumentRecall.
 *
 * Simulated runtimes omit plugin-local-inference and default to keyword-only
 * recall. This suite proves the opt-in deterministic TEXT_EMBEDDING lane can
 * drive the real DocumentService vector/hybrid consumer with fixture-backed
 * vectors, while the keyword-only lane stays silent (no DocumentRecall.embedding
 * reports) when the canonical capability is disabled.
 */
import {
  DocumentService,
  type Memory,
  MemoryType,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { createDeterministicModelPlugin } from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  disableScenarioEmbeddingCapability,
  enableScenarioDeterministicEmbeddingCapability,
} from "./runtime-factory";

const QUERY = "desert solar panel efficiency";
const SEMANTIC_DOC = "photovoltaic yield under arid conditions";
const KEYWORD_DOC = "weekly grocery list milk eggs bread";
const DIMENSION = 8;

function unitAxis(index: number, dimension = DIMENSION): number[] {
  const vector = new Array(dimension).fill(0);
  vector[index] = 1;
  return vector;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function makeFragment(id: string, text: string, embedding: number[]): Memory {
  return {
    id: id as UUID,
    agentId: "agent-1" as UUID,
    roomId: "room-1" as UUID,
    entityId: "user-1" as UUID,
    content: { text },
    embedding,
    metadata: {
      type: MemoryType.FRAGMENT,
      documentId: `${id}-doc` as UUID,
      position: 0,
      timestamp: Date.now(),
    },
    createdAt: Date.now(),
  };
}

function makeMessage(text: string): Memory {
  return {
    id: "msg-1" as UUID,
    agentId: "agent-1" as UUID,
    roomId: "room-1" as UUID,
    entityId: "user-1" as UUID,
    content: { text },
    createdAt: Date.now(),
  };
}

function buildService(args: {
  fragments: Memory[];
  embeddingsEnabled: boolean;
  plugin?: ReturnType<typeof createDeterministicModelPlugin>;
}) {
  const settings: Record<string, unknown> = {};
  const runtimeSettings = {
    setSetting: (key: string, value: unknown) => {
      settings[key] = value;
    },
    getSetting: (key: string) => settings[key],
  };
  if (args.embeddingsEnabled) {
    enableScenarioDeterministicEmbeddingCapability(runtimeSettings as never);
  } else {
    disableScenarioEmbeddingCapability(runtimeSettings as never);
  }

  const reportError = vi.fn();
  const queryDocumentFragments = vi.fn(
    async (params: {
      embedding?: number[];
      matchThreshold?: number;
      limit: number;
      offset?: number;
    }) => {
      const offset = params.offset ?? 0;
      const ranked = args.fragments
        .map((fragment) => {
          const similarity =
            params.embedding && fragment.embedding
              ? cosine(params.embedding, fragment.embedding)
              : 0;
          return { ...fragment, similarity };
        })
        .filter((fragment) =>
          params.embedding
            ? fragment.similarity >= (params.matchThreshold ?? 0)
            : true,
        )
        .sort((left, right) => right.similarity - left.similarity);
      return ranked.slice(offset, offset + params.limit);
    },
  );

  const runtime = {
    agentId: "agent-1" as UUID,
    adapter: { queryDocumentFragments },
    getSetting: runtimeSettings.getSetting,
    getModel: vi.fn((modelType: string) => {
      if (!args.embeddingsEnabled) return undefined;
      return args.plugin?.models?.[modelType];
    }),
    useModel: vi.fn(async (modelType: string, params: unknown) => {
      const handler = args.plugin?.models?.[modelType];
      if (!handler) {
        throw new Error(
          `no TEXT_EMBEDDING handler registered for ${modelType}`,
        );
      }
      return handler({} as never, params as never);
    }),
    getCurrentRunId: () => "run-1",
    reportError,
    getRoomsForParticipants: vi.fn(async () => ["room-1" as UUID]),
    getRoom: vi.fn(async () => ({
      id: "room-1" as UUID,
      agentId: "agent-1" as UUID,
      worldId: "world-1" as UUID,
    })),
    getWorld: vi.fn(async () => ({
      id: "world-1" as UUID,
      agentId: "agent-1" as UUID,
      metadata: {
        roles: { "user-1": "USER" },
        roleSources: { "user-1": "manual" },
      },
    })),
  };

  const service = new (
    DocumentService as new (
      runtime: unknown,
    ) => DocumentService
  )(runtime);
  return { runtime, service, reportError, settings };
}

describe("scenario deterministic embeddings", () => {
  it("lets DocumentRecall vector/hybrid select a semantic match keyword search cannot", async () => {
    const semantic = unitAxis(0);
    const distractor = unitAxis(1);
    const query = unitAxis(0);
    const plugin = createDeterministicModelPlugin({
      embeddings: { dimension: DIMENSION, strict: true },
      fixtures: [
        {
          name: "query",
          match: { modelType: ModelType.TEXT_EMBEDDING, input: QUERY },
          response: query,
          times: "any",
        },
        {
          name: "semantic-doc",
          match: { modelType: ModelType.TEXT_EMBEDDING, input: SEMANTIC_DOC },
          response: semantic,
          times: "any",
        },
        {
          name: "keyword-doc",
          match: { modelType: ModelType.TEXT_EMBEDDING, input: KEYWORD_DOC },
          response: distractor,
          times: "any",
        },
      ],
    });

    const fragments = [
      makeFragment("frag-semantic", SEMANTIC_DOC, semantic),
      makeFragment("frag-keyword", KEYWORD_DOC, distractor),
    ];
    const { service, reportError, runtime } = buildService({
      fragments,
      embeddingsEnabled: true,
      plugin,
    });

    const vectorHits = await service.searchDocuments(
      makeMessage(QUERY),
      undefined,
      "vector",
    );
    const hybridHits = await service.searchDocuments(
      makeMessage(QUERY),
      undefined,
      "hybrid",
    );
    const keywordHits = await service.searchDocuments(
      makeMessage(QUERY),
      undefined,
      "keyword",
    );

    expect(vectorHits[0]?.id).toBe("frag-semantic");
    expect(hybridHits[0]?.id).toBe("frag-semantic");
    expect(keywordHits.map((hit) => hit.id)).not.toContain("frag-semantic");
    expect(runtime.useModel).toHaveBeenCalledWith(
      ModelType.TEXT_EMBEDDING,
      expect.objectContaining({ text: QUERY }),
    );
    const diagnostics = plugin.getFixtureDiagnostics();
    expect(
      diagnostics.calls.some(
        (call) =>
          call.modelType === ModelType.TEXT_EMBEDDING &&
          call.matchedFixtureName === "query",
      ),
    ).toBe(true);
    expect(diagnostics.unexpectedCalls).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps keyword-only recall silent when the canonical capability is disabled", async () => {
    const plugin = createDeterministicModelPlugin({
      embeddings: { dimension: DIMENSION },
    });
    const fragments = [
      makeFragment("frag-semantic", SEMANTIC_DOC, unitAxis(0)),
      makeFragment(
        "frag-keyword",
        "desert solar panel efficiency notes",
        unitAxis(1),
      ),
    ];
    const { service, reportError, runtime, settings } = buildService({
      fragments,
      embeddingsEnabled: false,
      plugin,
    });

    expect(settings.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBe(false);
    const hybridHits = await service.searchDocuments(
      makeMessage(QUERY),
      undefined,
      "hybrid",
    );

    expect(hybridHits[0]?.id).toBe("frag-keyword");
    expect(runtime.useModel).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
