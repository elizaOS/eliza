/**
 * Custom-voice usage accounting — the detached TTS accounting task's only
 * writer. Pure unit tests with a deterministic repository fixture: voice
 * ownership binding (org match vs mismatch vs missing voice), usage-count
 * increment, and the J7 error policy (enrichment failure must never suppress
 * the canonical billing/usage record — logged, not thrown).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const findByElevenLabsVoiceId = mock();
const incrementUsageCount = mock();

mock.module("../../../db/repositories/user-voices", () => ({
  userVoicesRepository: {
    findByElevenLabsVoiceId,
    incrementUsageCount,
  },
}));

const loggerWarn = mock();

mock.module("../../utils/logger", () => ({
  logger: {
    warn: loggerWarn,
    debug: mock(),
    info: mock(),
    error: mock(),
  },
}));

const { recordCustomVoiceUsage } = await import("../tts-custom-voice-usage");

beforeEach(() => {
  findByElevenLabsVoiceId.mockReset();
  incrementUsageCount.mockReset();
  loggerWarn.mockReset();
});

describe("recordCustomVoiceUsage", () => {
  test("returns the voice when it belongs to the organization and increments usage", async () => {
    findByElevenLabsVoiceId.mockResolvedValue({
      id: "voice-1",
      organizationId: "org-123",
      name: "My Voice",
      elevenLabsVoiceId: "elv-1",
    });
    incrementUsageCount.mockResolvedValue(undefined);

    const result = await recordCustomVoiceUsage({
      elevenLabsVoiceId: "elv-1",
      organizationId: "org-123",
    });

    expect(result).toEqual({ userVoiceId: "voice-1", voiceName: "My Voice" });
    expect(findByElevenLabsVoiceId).toHaveBeenCalledWith("elv-1");
    expect(incrementUsageCount).toHaveBeenCalledWith("voice-1");
  });

  test("returns nulls and skips increment when the voice belongs to another organization", async () => {
    findByElevenLabsVoiceId.mockResolvedValue({
      id: "voice-2",
      organizationId: "org-OTHER",
      name: "Someone Else's Voice",
      elevenLabsVoiceId: "elv-2",
    });

    const result = await recordCustomVoiceUsage({
      elevenLabsVoiceId: "elv-2",
      organizationId: "org-123",
    });

    expect(result).toEqual({ userVoiceId: null, voiceName: null });
    expect(incrementUsageCount).not.toHaveBeenCalled();
  });

  test("returns nulls and skips increment when no voice exists", async () => {
    findByElevenLabsVoiceId.mockResolvedValue(null);

    const result = await recordCustomVoiceUsage({
      elevenLabsVoiceId: "elv-missing",
      organizationId: "org-123",
    });

    expect(result).toEqual({ userVoiceId: null, voiceName: null });
    expect(incrementUsageCount).not.toHaveBeenCalled();
  });

  test("swallows increment failure with a warning and still reports the voice (J7)", async () => {
    findByElevenLabsVoiceId.mockResolvedValue({
      id: "voice-3",
      organizationId: "org-123",
      name: "My Voice",
      elevenLabsVoiceId: "elv-3",
    });
    incrementUsageCount.mockRejectedValue(new Error("redis down"));

    const result = await recordCustomVoiceUsage({
      elevenLabsVoiceId: "elv-3",
      organizationId: "org-123",
    });

    expect(result).toEqual({ userVoiceId: "voice-3", voiceName: "My Voice" });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0][1]).toMatchObject({
      voiceId: "voice-3",
      error: "redis down",
    });
  });
});
