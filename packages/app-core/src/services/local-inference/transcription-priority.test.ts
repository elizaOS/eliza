/**
 * Tests for the `TRANSCRIPTION` model handler priority + provider hint
 * semantics on `AgentRuntime`. These exercise the same `registerModel`
 * machinery used by plugin-elizacloud (remote Whisper) and the local
 * Qwen3-ASR / OpenVINO Whisper handler so callers know exactly:
 *
 *   - which handler wins when priorities tie (first-registered),
 *   - how an explicit `priority` overrides that,
 *   - that a `provider` hint to `useModel` overrides priority entirely,
 *   - that the runtime does NOT auto-fall-through on handler errors,
 *   - and how a caller can implement an explicit try/catch fallback.
 *
 * The test is intentionally provider-agnostic — it registers stub handlers
 * named "local" and "openai" so the contract is observable without booting
 * any real ASR backend.
 */

import { describe, expect, it } from "vitest";

import { InMemoryDatabaseAdapter } from "../../../../core/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../../core/src/runtime";
import { ModelType } from "../../../../core/src/types";

interface TranscriptionParams {
  audio?: Float32Array | Uint8Array | Buffer | string;
}

interface TestRuntimeCtx {
  runtime: AgentRuntime;
  calls: string[];
}

function makeRuntime(): TestRuntimeCtx {
  const runtime = new AgentRuntime({
    character: {
      name: "TranscriptionPriorityTest",
      bio: "asr-priority test",
      settings: {},
    } as never,
    adapter: new InMemoryDatabaseAdapter(),
    logLevel: "fatal",
  });
  const calls: string[] = [];
  return { runtime, calls };
}

function makeHandler(
  calls: string[],
  label: string,
  result: string | (() => string),
  options: { throws?: boolean } = {},
) {
  return async (
    _runtime: unknown,
    _params: unknown,
  ): Promise<string> => {
    calls.push(label);
    if (options.throws) {
      throw new Error(`${label} handler failed`);
    }
    return typeof result === "function" ? result() : result;
  };
}

describe("TRANSCRIPTION handler priority on AgentRuntime", () => {
  it("local Qwen3-ASR wins over remote OpenAI Whisper by registration order when priorities tie", async () => {
    const { runtime, calls } = makeRuntime();
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local", "local transcript"),
      "eliza-local-inference",
      0,
    );
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "openai", "openai transcript"),
      "openai",
      0,
    );

    const text = await runtime.useModel(ModelType.TRANSCRIPTION, {
      audio: new Float32Array(160),
    } as TranscriptionParams as never);

    expect(text).toBe("local transcript");
    expect(calls).toEqual(["local"]);
  });

  it("explicit higher priority always wins regardless of registration order", async () => {
    const { runtime, calls } = makeRuntime();
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "remote", "remote transcript"),
      "openai",
      100,
    );
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local", "local transcript"),
      "eliza-local-inference",
      0,
    );

    // Remote wins because priority 100 > 0.
    let text = await runtime.useModel(ModelType.TRANSCRIPTION, {
      audio: new Float32Array(160),
    } as TranscriptionParams as never);
    expect(text).toBe("remote transcript");
    expect(calls).toEqual(["remote"]);

    // Re-register local with a higher priority — now local wins.
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local-priority", "local-priority transcript"),
      "eliza-local-inference",
      200,
    );

    text = await runtime.useModel(ModelType.TRANSCRIPTION, {
      audio: new Float32Array(160),
    } as TranscriptionParams as never);
    expect(text).toBe("local-priority transcript");
    expect(calls).toEqual(["remote", "local-priority"]);
  });

  it("provider hint to useModel overrides priority", async () => {
    const { runtime, calls } = makeRuntime();
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local", "local transcript"),
      "eliza-local-inference",
      200,
    );
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "openai", "openai transcript"),
      "openai",
      0,
    );

    // Default useModel: local wins (priority 200 > 0).
    let text = await runtime.useModel(ModelType.TRANSCRIPTION, {
      audio: new Float32Array(160),
    } as TranscriptionParams as never);
    expect(text).toBe("local transcript");

    // Explicit provider hint flips it to openai despite the priority gap.
    text = await runtime.useModel(
      ModelType.TRANSCRIPTION,
      { audio: new Float32Array(160) } as TranscriptionParams as never,
      "openai",
    );
    expect(text).toBe("openai transcript");
    expect(calls).toEqual(["local", "openai"]);
  });

  it("runtime does NOT auto-fall-through on handler errors", async () => {
    const { runtime, calls } = makeRuntime();
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local", "should never reach this", { throws: true }),
      "eliza-local-inference",
      200,
    );
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "openai", "openai transcript"),
      "openai",
      0,
    );

    await expect(
      runtime.useModel(ModelType.TRANSCRIPTION, {
        audio: new Float32Array(160),
      } as TranscriptionParams as never),
    ).rejects.toThrow(/local handler failed/);
    // The remote handler should NOT have been invoked — there is no
    // implicit fallback chain on the runtime.
    expect(calls).toEqual(["local"]);
  });

  it("caller can implement fallback via try/catch + provider hint", async () => {
    const { runtime, calls } = makeRuntime();
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "local", "boom", { throws: true }),
      "eliza-local-inference",
      200,
    );
    runtime.registerModel(
      ModelType.TRANSCRIPTION,
      makeHandler(calls, "openai", "openai transcript"),
      "openai",
      0,
    );

    let result: string;
    try {
      result = (await runtime.useModel(ModelType.TRANSCRIPTION, {
        audio: new Float32Array(160),
      } as TranscriptionParams as never)) as string;
    } catch {
      // Caller-controlled fallback: explicit retry with provider hint.
      result = (await runtime.useModel(
        ModelType.TRANSCRIPTION,
        { audio: new Float32Array(160) } as TranscriptionParams as never,
        "openai",
      )) as string;
    }

    expect(result).toBe("openai transcript");
    expect(calls).toEqual(["local", "openai"]);
  });
});
