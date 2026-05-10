// Integration tests for plugin-local-ai. Skipped unless a real GGUF model
// path is provided via `LOCAL_AI_TEST_MODEL_PATH`. We don't ship the model
// in the repo because gguf files are several GB.
import { afterAll, describe, expect, it } from "vitest";

const modelPath = process.env.LOCAL_AI_TEST_MODEL_PATH;
const describeIfModel = modelPath ? describe : describe.skip;

describeIfModel("plugin-local-ai integration (real model)", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterAll(async () => {
    for (const fn of cleanup) {
      await fn();
    }
  });

  it("returns parsed tool_calls when caller passes tools", async () => {
    const { getLlama } = await import("node-llama-cpp");
    const { buildLlamaFunctions, extractToolCalls } = await import("../structured-output.js");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: modelPath as string });
    const context = await model.createContext({ contextSize: 2048 });
    const { LlamaChatSession } = await import("node-llama-cpp");
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt:
        "You are a tool-calling assistant. Always call the requested function instead of replying with text.",
    });
    cleanup.push(() => context.dispose());

    const functions = buildLlamaFunctions([
      {
        name: "get_weather",
        description: "Look up weather for a city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ] as never);

    const meta = await session.promptWithMeta(
      "What's the weather like in Paris? Call the get_weather function.",
      {
        functions,
        maxTokens: 256,
        temperature: 0,
      }
    );
    const calls = extractToolCalls(meta.response);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.name).toBe("get_weather");
    expect(typeof calls[0]?.arguments).toBe("object");
  }, 120_000);

  it("reuses the same context across consecutive prompts (cache lives)", async () => {
    const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: modelPath as string });
    const context = await model.createContext({ contextSize: 2048 });
    const sequence = context.getSequence();
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt: "You are concise.",
    });
    cleanup.push(() => context.dispose());

    const before = sequence.contextTokens?.length ?? 0;
    await session.prompt("Say hi.", { maxTokens: 16, temperature: 0 });
    const afterFirst = sequence.contextTokens?.length ?? 0;
    expect(afterFirst).toBeGreaterThan(before);

    await session.prompt("Now say bye.", { maxTokens: 16, temperature: 0 });
    const afterSecond = sequence.contextTokens?.length ?? 0;
    // Second turn extends the existing cache; tokens grow but the session
    // is the same instance (KV cache preserved).
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(session.sequence).toBe(sequence);
  }, 120_000);

  it("constrains output to a JSON object via responseSchema grammar", async () => {
    const { getLlama, LlamaChatSession } = await import("node-llama-cpp");
    const { buildJsonSchemaGrammar } = await import("../structured-output.js");
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath: modelPath as string });
    const context = await model.createContext({ contextSize: 2048 });
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: "Reply only with JSON.",
    });
    cleanup.push(() => context.dispose());

    const grammar = buildJsonSchemaGrammar(llama, {
      type: "object",
      properties: { city: { type: "string" }, ok: { type: "boolean" } },
      required: ["city", "ok"],
    } as never);
    const text = await session.prompt(
      "Output a JSON object describing Paris with `city` and `ok: true`.",
      { grammar, maxTokens: 128, temperature: 0 }
    );
    const parsed = JSON.parse(text);
    expect(typeof parsed.city).toBe("string");
    expect(typeof parsed.ok).toBe("boolean");
  }, 120_000);
});
