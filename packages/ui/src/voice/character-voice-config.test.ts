import { PREMADE_VOICES } from "@elizaos/host/protocol";
import { describe, expect, it } from "vitest";
import { resolveCharacterVoiceConfigFromAppConfig } from "./character-voice-config";

function voiceIdOf(presetId: string): string {
  const voice = PREMADE_VOICES.find((candidate) => candidate.id === presetId);
  if (!voice) throw new Error(`unknown premade voice ${presetId}`);
  return voice.voiceId;
}

function resolvedVoiceId(character: string, tts: Record<string, unknown>) {
  return resolveCharacterVoiceConfigFromAppConfig({
    config: { ui: { presetId: character }, messages: { tts } },
    uiLanguage: "en",
  })?.elevenlabs?.voiceId;
}

describe("resolveCharacterVoiceConfigFromAppConfig", () => {
  for (const [character, picked] of [
    ["jin", "sarah"],
    ["rin", "matilda"],
    ["yuki", "sarah"],
  ] as const) {
    it(`keeps an explicitly saved ElevenLabs voice (${character} with ${picked})`, () => {
      expect(
        resolvedVoiceId(character, {
          provider: "elevenlabs",
          mode: "cloud",
          elevenlabs: {
            voiceId: voiceIdOf(picked),
            modelId: "eleven_flash_v2_5",
          },
        }),
      ).toBe(voiceIdOf(picked));
    });
  }

  it("still applies the character preset over the default voice without an explicit choice", () => {
    expect(
      resolvedVoiceId("jin", { elevenlabs: { voiceId: voiceIdOf("sarah") } }),
    ).toBe(voiceIdOf("jin"));
  });
});
