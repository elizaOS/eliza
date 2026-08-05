/** Verifies Character voice writes wait for config readiness and surface failures. */

import { describe, expect, it, vi } from "vitest";
import { persistCharacterVoiceSelection } from "./character-voice-persistence";

describe("persistCharacterVoiceSelection", () => {
  it("does not write before configuration is ready (#15922)", async () => {
    const updateConfig = vi.fn(async () => undefined);
    await expect(
      persistCharacterVoiceSelection({
        configReady: false,
        voiceConfig: { provider: "edge" },
        writer: { updateConfig },
      }),
    ).resolves.toBe(false);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("persists once ready and rejects required write failures", async () => {
    const failure = new Error("Unauthorized");
    const updateConfig = vi.fn(async () => {
      throw failure;
    });
    await expect(
      persistCharacterVoiceSelection({
        configReady: true,
        voiceConfig: { provider: "edge" },
        writer: { updateConfig },
      }),
    ).rejects.toBe(failure);
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });
});
