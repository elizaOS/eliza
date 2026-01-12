import { type IAgentRuntime, logger } from "@elizaos/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SamTTSService, simpleVoicePlugin } from "../index";
import { cleanupTestRuntime, createTestMemory, createTestRuntime } from "./test-utils";

beforeAll(() => {
  vi.spyOn(logger, "info");
  vi.spyOn(logger, "warn");
});

describe("SimpleVoicePlugin", () => {
  it("has correct metadata", () => {
    expect(simpleVoicePlugin.name).toBe("@elizaos/plugin-simple-voice");
    expect(simpleVoicePlugin.description).toContain("SAM");
  });

  it("registers SAY_ALOUD action", () => {
    expect(simpleVoicePlugin.actions).toHaveLength(1);
    const firstAction = simpleVoicePlugin.actions?.[0];
    expect(firstAction?.name).toBe("SAY_ALOUD");
  });

  it("registers SamTTSService", () => {
    expect(simpleVoicePlugin.services).toHaveLength(1);
    expect(simpleVoicePlugin.services?.[0]).toBe(SamTTSService);
  });
});

describe("SayAloudAction", () => {
  let runtime: IAgentRuntime;
  const action = simpleVoicePlugin.actions?.[0];

  if (!action) {
    throw new Error("Action not found");
  }

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  it("validates trigger phrases", async () => {
    runtime = await createTestRuntime();

    const triggers = ["say aloud hello", "speak this text", "voice command"];
    for (const text of triggers) {
      expect(await action.validate?.(runtime, createTestMemory({ content: { text } }))).toBe(true);
    }
  });

  it("rejects non-trigger phrases", async () => {
    runtime = await createTestRuntime();

    const nonTriggers = ["hello world", "what is the weather"];
    for (const text of nonTriggers) {
      expect(await action.validate?.(runtime, createTestMemory({ content: { text } }))).toBe(false);
    }
  });
});

describe("SamTTSService", () => {
  let runtime: IAgentRuntime;

  afterEach(async () => {
    if (runtime) {
      await cleanupTestRuntime(runtime);
    }
  });

  it("has correct service type", () => {
    expect(SamTTSService.serviceType).toBe("SAM_TTS");
  });

  it("generates audio from text", async () => {
    runtime = await createTestRuntime();
    const service = new SamTTSService(runtime);

    const audio = service.generateAudio("Hello");
    expect(audio).toBeInstanceOf(Uint8Array);
    expect(audio.length).toBeGreaterThan(0);
  });

  it("applies voice options", async () => {
    runtime = await createTestRuntime();
    const service = new SamTTSService(runtime);

    const slow = service.generateAudio("Test", {
      speed: 40,
      pitch: 64,
      throat: 128,
      mouth: 128,
    });
    const fast = service.generateAudio("Test", {
      speed: 120,
      pitch: 64,
      throat: 128,
      mouth: 128,
    });

    expect(slow.length).not.toBe(fast.length);
  });

  it("creates valid WAV buffer", async () => {
    runtime = await createTestRuntime();
    const service = new SamTTSService(runtime);

    const audio = service.generateAudio("Test");
    const wav = service.createWAVBuffer(audio);

    expect(wav.length).toBe(audio.length + 44);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
  });
});
