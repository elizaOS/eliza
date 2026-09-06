/**
 * Applies explicit prompt-cache experiments at the real runtime model boundary.
 * The benchmark owns these overrides; production affinity defaults remain unchanged.
 * Complete prompts, tool definitions and unrelated provider options retain their identity.
 */
import { createHash } from "node:crypto";

export type CacheExperimentMode = "existing" | "automatic" | "conversation";

export interface CacheExperiment {
  mode: CacheExperimentMode;
  /** Account capability must be independently confirmed before requesting key routing. */
  keyCapabilityConfirmed: boolean;
  agentId: string;
  conversationId: string;
  model: string;
  stage: string;
}

type ModelInput = {
  providerOptions?: Record<string, unknown>;
};

function optionsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Prompt-cache experiment requires object provider options");
  }
  return value as Record<string, unknown>;
}

/**
 * Selects the optional routing hint after core cache-plan assembly but before
 * the provider adapter. This prevents the dynamic plan merge from overwriting
 * the experiment, and lets the actual SDK wire capture verify its effect.
 */
export function applyCacheExperiment<T>(
  input: T,
  experiment: CacheExperiment,
): T {
  if (experiment.mode !== "automatic" && !experiment.keyCapabilityConfirmed) {
    throw new Error(
      "Confirm account prompt_cache_key capability before a keyed experiment",
    );
  }
  if (experiment.mode === "existing") return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "Prompt-cache experiment requires a model parameter object",
    );
  }
  const providerOptions = optionsRecord((input as ModelInput).providerOptions);
  const eliza = optionsRecord(providerOptions.eliza);
  const openai = optionsRecord(providerOptions.openai);
  const cerebras = optionsRecord(providerOptions.cerebras);
  let key: string | undefined;
  if (experiment.mode === "conversation") {
    for (const value of [
      experiment.agentId,
      experiment.conversationId,
      experiment.model,
      experiment.stage,
    ]) {
      if (!value.trim())
        throw new Error(
          "Conversation cache experiment requires complete scoped identity",
        );
    }
    const prefix = eliza.prefixHash;
    if (typeof prefix !== "string" || !prefix) {
      throw new Error(
        "Conversation cache experiment requires the rendered stable-prefix hash",
      );
    }
    key = `experiment:v1:${createHash("sha256")
      .update(
        JSON.stringify([
          experiment.agentId,
          experiment.conversationId,
          experiment.model,
          experiment.stage,
          prefix,
        ]),
      )
      .digest("hex")}`;
  }
  // The compatible SDK reads the OpenAI namespace even in Cerebras mode.
  // Remove both spellings so an alternate adapter cannot resurrect the old hint.
  const {
    promptCacheKey: _openaiKey,
    prompt_cache_key: _openaiWireKey,
    ...openaiRest
  } = openai;
  const {
    promptCacheKey: _cerebrasKey,
    prompt_cache_key: _cerebrasWireKey,
    ...cerebrasRest
  } = cerebras;
  return {
    ...input,
    providerOptions: {
      ...providerOptions,
      openai: { ...openaiRest, ...(key ? { promptCacheKey: key } : {}) },
      cerebras: {
        ...cerebrasRest,
        ...(key ? { promptCacheKey: key, prompt_cache_key: key } : {}),
      },
    },
  };
}

export interface EmbeddingEvidenceConfig {
  endpoint: string;
  model: string;
  dimensions: number;
}

/** Rejects the synthetic Cerebras embedding fallback before any paid model work. */
export function requireRealEmbeddingConfig(
  environment: Record<string, string | undefined>,
): EmbeddingEvidenceConfig {
  const endpoint = environment.OPENAI_EMBEDDING_URL?.trim();
  const model = environment.OPENAI_EMBEDDING_MODEL?.trim();
  const dimensionSetting = environment.OPENAI_EMBEDDING_DIMENSIONS?.trim();
  if (!endpoint || !model || !dimensionSetting) {
    throw new Error(
      "Live evidence requires OPENAI_EMBEDDING_URL, OPENAI_EMBEDDING_MODEL and OPENAI_EMBEDDING_DIMENSIONS; synthetic feature-hash embeddings are not admissible",
    );
  }
  const url = new URL(endpoint);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Embedding endpoint must be an HTTP(S) URL without credentials, query or fragment",
    );
  }
  const dimensions = Number(dimensionSetting);
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error("OPENAI_EMBEDDING_DIMENSIONS must be a positive integer");
  }
  return { endpoint: url.toString(), model, dimensions };
}

export interface ProviderWireEvidence {
  kind: "text" | "embedding";
  context: { phase: string; index?: number; proof: string } | null;
  /** Serialized SDK request body; credentials/headers are deliberately never captured. */
  request: unknown;
  status: number | null;
  requestCaptureMs: number;
  headersMs: number;
  outcome: "response" | "error";
}

/** Reject an experiment whose effective SDK request contradicts the selected hint mode. */
export function verifyCacheExperimentWire(
  evidence: readonly ProviderWireEvidence[],
  mode: CacheExperimentMode,
): number {
  const textRequests = evidence.filter((wire) => wire.kind === "text");
  if (textRequests.length === 0)
    throw new Error("Cache experiment has no text wire requests");
  for (const wire of textRequests) {
    const request = optionsRecord(wire.request);
    if (mode === "automatic" && Object.hasOwn(request, "prompt_cache_key")) {
      throw new Error(
        "Automatic cache experiment was overwritten before SDK dispatch",
      );
    }
    if (
      mode === "conversation" &&
      (typeof request.prompt_cache_key !== "string" ||
        !/^experiment:v1:[a-f0-9]{64}$/.test(request.prompt_cache_key))
    ) {
      throw new Error(
        "Conversation cache experiment was overwritten or omitted before SDK dispatch",
      );
    }
  }
  return textRequests.length;
}

/** Observes the actual SDK fetch boundary without consuming or replacing response streams. */
export function measuredProviderFetch(
  originalFetch: typeof fetch,
  endpoints: { text: string; embedding: string },
  context: () => ProviderWireEvidence["context"],
  observe: (evidence: ProviderWireEvidence) => void,
): typeof fetch {
  const textBase = new URL(endpoints.text);
  const embeddingBase = new URL(endpoints.embedding);
  const matches = (url: URL, base: URL, suffix: string) =>
    url.origin === base.origin &&
    url.pathname === `${base.pathname.replace(/\/$/, "")}/${suffix}`;
  const measured = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const kind =
      matches(url, textBase, "chat/completions") ||
      matches(url, textBase, "responses")
        ? "text"
        : matches(url, embeddingBase, "embeddings")
          ? "embedding"
          : null;
    if (!kind) return originalFetch(input, init);
    const capturedContext = context();
    const startedAt = performance.now();
    const request = new Request(input, init);
    const requestBody: unknown = await request.clone().json();
    const requestCaptureMs = performance.now() - startedAt;
    const fetchStartedAt = performance.now();
    try {
      const response = await originalFetch(request);
      observe({
        kind,
        context: capturedContext ? { ...capturedContext } : null,
        request: requestBody,
        status: response.status,
        requestCaptureMs,
        headersMs: performance.now() - fetchStartedAt,
        outcome: "response",
      });
      return response;
    } catch (cause) {
      // error-policy:J2 Record a payload-free transport outcome, then preserve the original failure.
      observe({
        kind,
        context: capturedContext ? { ...capturedContext } : null,
        request: requestBody,
        status: null,
        requestCaptureMs,
        headersMs: performance.now() - fetchStartedAt,
        outcome: "error",
      });
      throw cause;
    }
  };
  return Object.assign(measured, originalFetch);
}

export type ChatCondition = "rolling-history" | "fresh-room" | "post-idle";

/**
 * Defines workload state independently from observed provider cache hits. A fresh
 * room is not called a cold cache: the upstream may reuse a shared system prefix.
 * Post-idle samples each resume their own primed room, so later samples are not
 * mislabeled warm turns of the first resumed room.
 */
export async function runChatCondition<T>(options: {
  condition: ChatCondition;
  samples: number;
  idleMs: number;
  initialRoom: string;
  prepareRoom: () => Promise<string>;
  runTurn: (index: number, prime: boolean, roomId: string) => Promise<T>;
  wait: (milliseconds: number) => Promise<void>;
}): Promise<Array<{ index: number; roomId: string; value: T }>> {
  if (!Number.isSafeInteger(options.samples) || options.samples < 1)
    throw new Error("Sample count must be positive");
  if (
    options.condition === "post-idle" &&
    (!Number.isFinite(options.idleMs) || options.idleMs <= 0)
  ) {
    throw new Error(
      "Post-idle workload requires a positive measured idle interval",
    );
  }
  const rooms: string[] = [];
  for (let index = 0; index < options.samples; index++) {
    const room =
      options.condition === "rolling-history"
        ? options.initialRoom
        : await options.prepareRoom();
    rooms.push(room);
    if (options.condition === "post-idle")
      await options.runTurn(index, true, room);
  }
  if (options.condition === "post-idle") await options.wait(options.idleMs);
  const results: Array<{ index: number; roomId: string; value: T }> = [];
  for (const [index, roomId] of rooms.entries()) {
    results.push({
      index,
      roomId,
      value: await options.runTurn(index, false, roomId),
    });
  }
  return results;
}
