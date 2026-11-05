/**
 * ENABLE_MICROPHONE / USE_STREAMING_AUDIO must be read with the repository's
 * boolean parser. Every other boolean in this service already tolerates case
 * and whitespace ("TRUE", " true "), and core's parser also accepts 1/yes/on.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { AudioCaptureService } from "./audio-capture";
import { VisionService } from "./service";

// The audio path does not touch images; keep sharp out of this unit test.
vi.mock("./image/sharp-compat", () => ({
  getSharp: vi.fn(async () => ({})),
}));

function createRuntime(settings: Record<string, unknown>) {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    agentId: "agent-vision",
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  });
}

/** Returns how many times batch audio capture was initialized. */
async function initializeAudio(
  settings: Record<string, unknown>,
): Promise<number> {
  const service = new VisionService(createRuntime(settings));
  const initialize = vi
    .spyOn(AudioCaptureService.prototype, "initialize")
    .mockResolvedValue(undefined);
  try {
    await Reflect.get(service, "initializeAudioCapture").call(service);
    return initialize.mock.calls.length;
  } finally {
    initialize.mockRestore();
  }
}

describe("VisionService audio capture boolean settings", () => {
  it("opens microphone capture when ENABLE_MICROPHONE is the string true", async () => {
    expect(await initializeAudio({ ENABLE_MICROPHONE: "true" })).toBe(1);
  });

  it("opens microphone capture when ENABLE_MICROPHONE has different case or spaces", async () => {
    expect(await initializeAudio({ ENABLE_MICROPHONE: "TRUE" })).toBe(1);
    expect(await initializeAudio({ ENABLE_MICROPHONE: " true " })).toBe(1);
  });

  it("opens microphone capture when ENABLE_MICROPHONE is a boolean setting", async () => {
    expect(await initializeAudio({ ENABLE_MICROPHONE: true })).toBe(1);
  });

  it("opens microphone capture for 1, yes and on like the core boolean parser", async () => {
    expect(await initializeAudio({ ENABLE_MICROPHONE: "1" })).toBe(1);
    expect(await initializeAudio({ ENABLE_MICROPHONE: "yes" })).toBe(1);
    expect(await initializeAudio({ ENABLE_MICROPHONE: "on" })).toBe(1);
  });

  it("keeps microphone capture off when ENABLE_MICROPHONE is false", async () => {
    expect(await initializeAudio({ ENABLE_MICROPHONE: "false" })).toBe(0);
  });

  it("keeps microphone capture off when ENABLE_MICROPHONE is unset", async () => {
    expect(await initializeAudio({})).toBe(0);
  });
});
