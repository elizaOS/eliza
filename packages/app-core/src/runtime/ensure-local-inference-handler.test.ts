import { type AgentRuntime, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modeState = vi.hoisted(() => ({ mode: "local" }));
const engineState = vi.hoisted(() => ({
  activeBackendId: vi.fn(() => "llama-server"),
  available: vi.fn(async () => true),
  canEmbed: vi.fn(() => false),
  conversation: vi.fn(() => null),
  currentModelPath: vi.fn(() => null),
  embed: vi.fn(async () => [[0.1, 0.2]]),
  ensureActiveBundleVoiceReady: vi.fn(async () => undefined),
  generate: vi.fn(async () => "ok"),
  generateInConversation: vi.fn(async () => ({
    slotId: "slot-0",
    text: "ok",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })),
  hasLoadedModel: vi.fn(() => false),
  load: vi.fn(async () => undefined),
  openConversation: vi.fn(() => ({ id: "conversation" })),
  prewarmConversation: vi.fn(async () => true),
  synthesizeSpeech: vi.fn(async () => new Uint8Array([1, 2, 3])),
  transcribePcm: vi.fn(async () => "transcribed"),
  warnIfParallelTooLow: vi.fn(),
}));

vi.mock("./mode/runtime-mode", () => ({
  getRuntimeMode: () => modeState.mode,
}));

vi.mock("../services/local-inference/active-model", () => ({
  resolveLocalInferenceLoadArgs: vi.fn(async (target) => target),
}));

vi.mock("../services/local-inference/assignments", () => ({
  autoAssignAtBoot: vi.fn(async () => null),
  readEffectiveAssignments: vi.fn(async () => ({})),
}));

vi.mock("../services/local-inference/cache-bridge", () => ({
  extractConversationId: vi.fn(() => null),
  extractPromptCacheKey: vi.fn(() => null),
  resolveLocalCacheKey: vi.fn(() => null),
}));

vi.mock("../services/local-inference/device-bridge", () => ({
  deviceBridge: {
    currentModelPath: vi.fn(() => null),
    embed: vi.fn(),
    generate: vi.fn(),
    loadModel: vi.fn(),
    unloadModel: vi.fn(),
  },
}));

vi.mock("../services/local-inference/engine", () => ({
  localInferenceEngine: engineState,
}));

vi.mock("../services/local-inference/handler-registry", () => ({
  handlerRegistry: {
    installOn: vi.fn(),
  },
}));

vi.mock("../services/local-inference/registry", () => ({
  listInstalledModels: vi.fn(async () => []),
}));

vi.mock("../services/local-inference/router-handler", () => ({
  installRouterHandler: vi.fn(),
}));

vi.mock("../services/local-inference/voice", () => ({
  decodeMonoPcm16Wav: vi.fn(() => ({
    pcm: new Float32Array([0]),
    sampleRate: 16_000,
  })),
}));

import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler";

interface Registration {
  modelType: string | number;
  provider: string;
  priority?: number;
  handler: unknown;
}

function makeRuntime(): {
  registrations: Registration[];
  runtime: AgentRuntime;
} {
  const registrations: Registration[] = [];
  const runtime = {
    agentId: "agent-test",
    getModel: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    registerModel: vi.fn(
      (
        modelType: string | number,
        _handler: unknown,
        provider: string,
        priority?: number,
      ) => {
        registrations.push({
          modelType,
          provider,
          priority,
          handler: _handler,
        });
      },
    ),
    registerService: vi.fn(),
  } as unknown as AgentRuntime;
  return { registrations, runtime };
}

beforeEach(() => {
  vi.clearAllMocks();
  modeState.mode = "local";
  delete process.env.ELIZA_LOCAL_LLAMA;
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  engineState.available.mockResolvedValue(true);
  engineState.currentModelPath.mockReturnValue(null);
  engineState.canEmbed.mockReturnValue(false);
  engineState.hasLoadedModel.mockReturnValue(false);
});

describe("ensureLocalInferenceHandler", () => {
  it("registers Eliza-1 text, embedding, voice, and transcription handlers in local mode", async () => {
    const { registrations, runtime } = makeRuntime();

    await ensureLocalInferenceHandler(runtime);

    expect(registrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelType: ModelType.TEXT_SMALL,
          provider: "eliza-local-inference",
          priority: 0,
        }),
        expect.objectContaining({
          modelType: ModelType.TEXT_LARGE,
          provider: "eliza-local-inference",
          priority: 0,
        }),
        expect.objectContaining({
          modelType: ModelType.TEXT_EMBEDDING,
          provider: "eliza-local-inference",
          priority: 0,
        }),
        expect.objectContaining({
          modelType: ModelType.TEXT_TO_SPEECH,
          provider: "eliza-local-inference",
          priority: 0,
        }),
        expect.objectContaining({
          modelType: ModelType.TRANSCRIPTION,
          provider: "eliza-local-inference",
          priority: 0,
        }),
      ]),
    );
  });

  it("skips handler registration outside local modes", async () => {
    modeState.mode = "cloud";
    const { registrations, runtime } = makeRuntime();

    await ensureLocalInferenceHandler(runtime);

    expect(registrations).toHaveLength(0);
    expect(engineState.available).not.toHaveBeenCalled();
  });

  it("does not duplicate registrations on the same runtime", async () => {
    const { registrations, runtime } = makeRuntime();

    await ensureLocalInferenceHandler(runtime);
    const firstCount = registrations.length;
    await ensureLocalInferenceHandler(runtime);

    expect(registrations).toHaveLength(firstCount);
  });

  it("renders v5 messages into a non-empty local prompt", async () => {
    const { registrations, runtime } = makeRuntime();
    engineState.hasLoadedModel.mockReturnValue(true);

    await ensureLocalInferenceHandler(runtime);
    const registration = registrations.find(
      (entry) => entry.modelType === ModelType.TEXT_SMALL,
    );
    const handler = registration?.handler as
      | ((
          runtime: AgentRuntime,
          params: Record<string, unknown>,
        ) => Promise<string>)
      | undefined;
    expect(handler).toBeDefined();

    await handler?.(runtime, {
      messages: [
        { role: "system", content: "You are Eliza." },
        { role: "user", content: "hello. say hello back" },
      ],
      maxTokens: 32,
      temperature: 0.1,
      topP: 0.9,
    });

    expect(engineState.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "system:\nYou are Eliza.\n\nuser:\nhello. say hello back",
        maxTokens: 32,
        temperature: 0.1,
        topP: 0.9,
      }),
    );
  });
});
