/**
 * Exercises real AgentRuntime and routing-policy dispatch with the real AI SDK's
 * retry loop. A deterministic fetch fixture returns counted HTTP 429 responses;
 * no external model, credentials, device backend, or live routing file is used.
 * Run with vitest.real-runtime.config.ts to exercise current core sources.
 */
import { createOpenAI } from "@ai-sdk/openai";
import {
  AgentRuntime,
  ElizaError,
  type GenerateTextParams,
  type IAgentRuntime,
  MODEL_PROVIDER_ATTEMPTS,
  ModelType,
} from "@elizaos/core";
import { generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../packages/core/src/database/inMemoryAdapter";
import { installRouterHandler } from "../../plugin-local-inference/src/services/router-handler";

const routing = vi.hoisted(() => ({
  policy: { TEXT_SMALL: "cloud-only", TEXT_LARGE: "cloud-only" },
  preferredProvider: {} as Record<string, string>,
}));
vi.mock("../../plugin-local-inference/src/services/routing-preferences", () => ({
  DEFAULT_ROUTING_POLICY: "cloud-only",
  readRoutingPreferences: async () => routing,
}));
vi.mock("../../plugin-local-inference/src/services/assignments", () => ({
  readEffectiveAssignments: async () => ({}),
}));

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  routing.policy.TEXT_SMALL = "cloud-only";
  routing.preferredProvider = {};
});

function fixture(options: { sdk?: boolean; prefer?: string | null } = {}) {
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", "0");
  const runtime = new AgentRuntime({
    character: {
      name: "RetryBudgetFixture",
      bio: "Test request-local provider failover",
      settings: {
        ELIZA_BRAIN_PROVIDER: options.prefer === null ? "" : (options.prefer ?? "openai"),
      },
    },
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { message: "Too Many Requests", type: "rate_limit" } }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        }
      )
  );
  const client = createOpenAI({ apiKey: "fixture-only", fetch });
  const payloads: GenerateTextParams[] = [];
  const exhausted = vi.fn(async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
    payloads.push(params);
    const result = await generateText({
      model: client.chat("fixture-small"),
      prompt: "Complete memory input",
      maxRetries: 2,
    });
    return result.text;
  });
  if (options.sdk !== false) runtime.registerModel(ModelType.TEXT_SMALL, exhausted, "openai", 100);
  installRouterHandler(runtime, {
    skipSlots: ["TEXT_LARGE", "TEXT_EMBEDDING", "TEXT_TO_SPEECH", "TRANSCRIPTION"],
  });
  return { runtime, fetch, exhausted, payloads };
}

describe("runtime and router share one exhausted provider budget", () => {
  it("does not restart the same SDK retry budget through the router alias", async () => {
    const { runtime, fetch, exhausted } = fixture();
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Remember the complete request",
        stream: false,
      })
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("retains a distinct provider without replaying the exhausted provider", async () => {
    const { runtime, fetch, exhausted } = fixture();
    const alternative = vi.fn(async () => "Memory extraction completed");
    runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Remember the complete request",
        stream: false,
      })
    ).resolves.toBe("Memory extraction completed");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(alternative).toHaveBeenCalledTimes(1);
  });

  it("keeps an explicit provider pin terminal after its own retry budget", async () => {
    const { runtime, fetch, exhausted } = fixture();
    const alternative = vi.fn(async () => "Must not replace a pinned provider");
    runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
    await expect(
      runtime.useModel(
        ModelType.TEXT_SMALL,
        { prompt: "Complete request", stream: false },
        "openai"
      )
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(alternative).not.toHaveBeenCalled();
  });

  it("keeps later and concurrent calls independent when they reuse frozen caller input", async () => {
    const { runtime, fetch, exhausted, payloads } = fixture();
    const params = Object.freeze({ prompt: "Complete shared input", stream: false });
    const calls = await Promise.allSettled([
      runtime.useModel(ModelType.TEXT_SMALL, params),
      runtime.useModel(ModelType.TEXT_SMALL, params),
    ]);
    expect(calls.map((call) => call.status)).toEqual(["rejected", "rejected"]);
    await expect(runtime.useModel(ModelType.TEXT_SMALL, params)).rejects.toThrow(
      "Failed after 3 attempts"
    );
    expect(fetch).toHaveBeenCalledTimes(9);
    expect(exhausted).toHaveBeenCalledTimes(3);
    expect(Object.getOwnPropertySymbols(params)).toEqual([]);
    expect(new Set(payloads.map((payload) => payload[MODEL_PROVIDER_ATTEMPTS])).size).toBe(3);
    for (const payload of payloads) {
      expect(payload).not.toBe(params);
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(payload, MODEL_PROVIDER_ATTEMPTS)?.enumerable).toBe(
        false
      );
      expect(JSON.stringify(payload)).not.toContain("modelProviderAttempts");
      expect(JSON.parse(JSON.stringify(payload)).prompt).toBe(params.prompt);
    }
  });

  it.each(["cloud-only", "manual"])(
    "preserves a different handler registered under the same provider and model type (%s)",
    async (policy) => {
      const { runtime, fetch } = fixture();
      routing.policy.TEXT_SMALL = policy;
      routing.preferredProvider.TEXT_SMALL = "openai";
      const alternative = vi.fn(async () => "Second concrete handler");
      runtime.registerModel(ModelType.TEXT_SMALL, alternative, "openai", 10);
      await expect(
        runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Complete request", stream: false })
      ).resolves.toBe("Second concrete handler");
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(alternative).toHaveBeenCalledTimes(1);
    }
  );

  it("preserves the same handler under a different resolved model key", async () => {
    const { runtime } = fixture({ sdk: false, prefer: null });
    const failed = Object.assign(new Error("first model rate limited"), { status: 429 });
    const shared = vi.fn(async (_runtime: IAgentRuntime, params: GenerateTextParams) => {
      if (params.model === ModelType.RESPONSE_HANDLER) throw failed;
      return "Different model succeeded";
    });
    runtime.registerModel(ModelType.RESPONSE_HANDLER, shared, "openai", 100);
    runtime.registerModel(ModelType.TEXT_SMALL, shared, "openai", 100);
    await expect(
      runtime.useModel(ModelType.RESPONSE_HANDLER, {
        prompt: "Complete request",
        stream: false,
        prepareModelAttempt: (attempt, params) => {
          params.model = attempt.modelType;
        },
      })
    ).resolves.toBe("Different model succeeded");
    expect(shared).toHaveBeenCalledTimes(2);
  });

  it("does not label a rejected preparation as a dispatched provider attempt", async () => {
    const { runtime, fetch, exhausted } = fixture();
    const prepare = vi.fn((attempt: { provider: string }) => {
      if (attempt.provider === "openai")
        throw new ElizaError("This preparation rejected the registration", {
          code: "EVALUATOR_INPUT_OVER_BUDGET",
        });
    });
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Complete request",
        stream: false,
        prepareModelAttempt: prepare,
      })
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls.map(([attempt]) => attempt.provider)).toEqual([
      "openai",
      "eliza-router",
    ]);
  });

  it("rethrows the original error when the router has no unattempted provider", async () => {
    const { runtime } = fixture({ sdk: false });
    const failure = Object.assign(new Error("original exhausted rate limit"), { status: 429 });
    const handler = vi.fn(async () => {
      throw failure;
    });
    runtime.registerModel(ModelType.TEXT_SMALL, handler, "openai", 100);
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Complete request", stream: false })
    ).rejects.toBe(failure);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not replay a router-first concrete failure in the outer fallback chain", async () => {
    const { runtime, fetch, exhausted } = fixture({ prefer: null });
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Complete request", stream: false })
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(exhausted).toHaveBeenCalledTimes(1);
  });

  it("retains an explicitly selected router's manual provider pin", async () => {
    const { runtime, fetch } = fixture({ prefer: null });
    routing.policy.TEXT_SMALL = "manual";
    routing.preferredProvider.TEXT_SMALL = "openai";
    const alternative = vi.fn(async () => "Must not bypass manual pin");
    runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
    await expect(
      runtime.useModel(
        ModelType.TEXT_SMALL,
        { prompt: "Complete request", stream: false },
        "eliza-router"
      )
    ).rejects.toThrow("Failed after 3 attempts");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(alternative).not.toHaveBeenCalled();
  });

  it("does not reinterpret an exhausted manual preference as an unconfigured provider", async () => {
    const { runtime, fetch } = fixture();
    routing.policy.TEXT_SMALL = "manual";
    routing.preferredProvider.TEXT_SMALL = "openai";
    const alternative = vi.fn(async () => "Distinct outer fallback");
    runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
    const prepared: string[] = [];
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Complete request",
        stream: false,
        prepareModelAttempt: (attempt) => {
          prepared.push(attempt.provider);
        },
      })
    ).resolves.toBe("Distinct outer fallback");
    // The router's manual pin must reject; the outer runtime still owns its
    // preexisting, separately prepared distinct-provider fallback policy.
    expect(prepared).toEqual(["openai", "eliza-router", "distinct-provider"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(alternative).toHaveBeenCalledTimes(1);
  });

  it("retains the existing fallback when a manual preference is genuinely unconfigured", async () => {
    const { runtime, fetch } = fixture();
    routing.policy.TEXT_SMALL = "manual";
    routing.preferredProvider.TEXT_SMALL = "unconfigured-provider";
    const alternative = vi.fn(async () => "Configured alternative");
    runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
    const prepared: string[] = [];
    await expect(
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Complete request",
        stream: false,
        prepareModelAttempt: (attempt) => {
          prepared.push(attempt.provider);
        },
      })
    ).resolves.toBe("Configured alternative");
    expect(prepared).toEqual(["openai", "eliza-router"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(alternative).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "keeps the existing stream owner after a lazy failure (output started=%s)",
    async (started) => {
      const { runtime } = fixture({ sdk: false, prefer: null });
      const failure = Object.assign(new Error("lazy stream rate limited"), { status: 429 });
      const lazy = vi.fn(async () => ({
        textStream: (async function* () {
          if (started) yield "Already delivered ";
          throw failure;
        })(),
        text: Promise.resolve(""),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve("stop"),
      }));
      const alternative = vi.fn(async () => "Distinct fallback");
      runtime.registerModel(ModelType.TEXT_SMALL, lazy, "openai", 100);
      runtime.registerModel(ModelType.TEXT_SMALL, alternative, "distinct-provider", 10);
      const chunks: string[] = [];
      const result = runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: "Complete request",
        stream: true,
        onStreamChunk: (chunk) => {
          chunks.push(chunk);
        },
      });
      if (started) {
        await expect(result).rejects.toBe(failure);
        expect(chunks.join("")).toBe("Already delivered ");
        expect(alternative).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBe("Distinct fallback");
        expect(alternative).toHaveBeenCalledTimes(1);
      }
      expect(lazy).toHaveBeenCalledTimes(1);
    }
  );
});
