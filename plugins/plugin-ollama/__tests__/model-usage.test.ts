/**
 * Live e2e for the Ollama plugin's MODEL_USED telemetry path.
 *
 * Skip gate: requires `OLLAMA_API_ENDPOINT` (or `OLLAMA_API_URL`) pointing at a
 * reachable Ollama server. Set e.g. `OLLAMA_API_ENDPOINT=http://localhost:11434`
 * and run `ollama create eliza-1-2b -f packages/training/cloud/ollama/Modelfile.eliza-1-2b-q4_k_m` (or set `OLLAMA_SMALL_MODEL` /
 * `OLLAMA_EMBEDDING_MODEL` to models you already have) to enable.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const OLLAMA_ENDPOINT =
  process.env.OLLAMA_API_ENDPOINT?.trim() || process.env.OLLAMA_API_URL?.trim() || "";
const OLLAMA_SMALL_MODEL = process.env.OLLAMA_SMALL_MODEL?.trim() || "eliza-1-2b";
const OLLAMA_EMBEDDING_MODEL = process.env.OLLAMA_EMBEDDING_MODEL?.trim() || "eliza-1-2b";

type MinimalRuntime = {
  character: { system: string };
  emitEvent: (event: string, payload: unknown) => Promise<void>;
  fetch: typeof fetch;
  getSetting: (key: string) => string | null;
  getService?: (name: string) => unknown;
  getServicesByType?: (type: string) => unknown[];
  emittedEvents: Array<{ event: string; payload: Record<string, unknown> }>;
};

function createRuntime(extra: Record<string, string> = {}): MinimalRuntime {
  const settings: Record<string, string> = {
    OLLAMA_API_ENDPOINT: OLLAMA_ENDPOINT,
    OLLAMA_SMALL_MODEL,
    OLLAMA_LARGE_MODEL: OLLAMA_SMALL_MODEL,
    OLLAMA_EMBEDDING_MODEL,
    ...extra,
  };
  const emittedEvents: MinimalRuntime["emittedEvents"] = [];
  return {
    character: { system: "You are a concise test agent. Reply briefly." },
    emitEvent: async (event: string, payload: unknown) => {
      emittedEvents.push({ event, payload: payload as Record<string, unknown> });
    },
    fetch: globalThis.fetch.bind(globalThis),
    getSetting: (key: string) => settings[key] ?? null,
    emittedEvents,
  };
}

async function pingOllama(endpoint: string): Promise<boolean> {
  const base = endpoint.replace(/\/api\/?$/, "").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const skipReason = !OLLAMA_ENDPOINT
  ? "OLLAMA_API_ENDPOINT not set (set OLLAMA_API_ENDPOINT=http://localhost:11434 and `ollama create eliza-1-2b -f packages/training/cloud/ollama/Modelfile.eliza-1-2b-q4_k_m` to enable)"
  : null;

if (skipReason) {
  process.env.SKIP_REASON ||= skipReason;
  console.warn(`${YELLOW}[ollama-live] skipped — ${skipReason}${RESET}`);
}

describe.skipIf(skipReason !== null)("ollama MODEL_USED events (live)", () => {
  let serverReachable = false;

  beforeAll(async () => {
    serverReachable = await pingOllama(OLLAMA_ENDPOINT);
    if (!serverReachable) {
      console.warn(
        `${YELLOW}[ollama-live] OLLAMA_API_ENDPOINT=${OLLAMA_ENDPOINT} unreachable — tests will skip${RESET}`
      );
    }
  }, 5000);

  it("emits MODEL_USED with real prompt/completion token counts for TEXT_SMALL", async () => {
    if (!serverReachable) return;
    const { default: plugin } = await import("../index");
    const runtime = createRuntime();

    const result = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime as IAgentRuntime, {
      prompt: "Reply with exactly two words: hello there",
    });

    expect(typeof result === "string" || (typeof result === "object" && result !== null)).toBe(
      true
    );

    const modelUsed = runtime.emittedEvents.find((e) => e.event === "MODEL_USED");
    expect(modelUsed).toBeDefined();
    expect(modelUsed?.payload).toMatchObject({
      source: "ollama",
      type: "TEXT_SMALL",
      model: OLLAMA_SMALL_MODEL,
    });
    const tokens = modelUsed?.payload?.tokens as {
      prompt: number;
      completion: number;
      total: number;
    };
    expect(tokens.prompt).toBeGreaterThan(0);
    expect(tokens.completion).toBeGreaterThan(0);
    expect(tokens.total).toBeGreaterThanOrEqual(tokens.prompt + tokens.completion);
  }, 60_000);

  it("records structured-output generation via TEXT_LARGE in active trajectories", async () => {
    if (!serverReachable) return;
    const { default: plugin } = await import("../index");

    const llmCalls: Record<string, unknown>[] = [];
    const trajectoryLogger = {
      isEnabled: () => true,
      logLlmCall: (call: Record<string, unknown>) => {
        llmCalls.push(call);
      },
    };
    const baseRuntime = createRuntime();
    const runtime = {
      ...baseRuntime,
      getService: (name: string) => (name === "trajectories" ? trajectoryLogger : null),
      getServicesByType: (type: string) => (type === "trajectories" ? [trajectoryLogger] : []),
    };

    await runWithTrajectoryContext({ trajectoryStepId: "step-ollama-live" }, async () => {
      await plugin.models?.[ModelType.TEXT_LARGE]?.(
        runtime as IAgentRuntime,
        {
          prompt: 'Return JSON {"ok": true}. Reply with only the JSON, no commentary.',
          responseSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        } as never
      );
    });

    expect(llmCalls.length).toBeGreaterThanOrEqual(1);
    const call = llmCalls[0];
    expect(call).toMatchObject({
      stepId: "step-ollama-live",
    });
    expect(typeof call.actionType).toBe("string");
    expect((call.promptTokens as number) ?? 0).toBeGreaterThan(0);
  }, 60_000);

  afterAll(() => {
    // No-op: runtime is in-memory and the harness has no resources to release.
  });
});
