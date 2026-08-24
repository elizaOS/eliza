/**
 * Unit tests for character editor voice configuration helpers.
 * Validates ElevenLabs/Edge voice group structures and preset-to-config derivations.
 */
import { describe, expect, it } from "vitest";
import { PREMADE_VOICES } from "../../../voice/types.ts";
import type { CharacterRosterEntry } from "../CharacterRoster.tsx";
import {
  buildVoiceConfigForCharacterEntry,
  DEFAULT_ELEVEN_FAST_MODEL,
  EDGE_VOICE_GROUPS,
  ELEVENLABS_VOICE_GROUPS,
} from "../character-voice-config.ts";

describe("character-voice-config", () => {
  describe("constants and voice groups", () => {
    it("defines the default ElevenLabs fast model", () => {
      expect(DEFAULT_ELEVEN_FAST_MODEL).toBe("eleven_flash_v2_5");
    });

    it("defines structured ElevenLabs voice groups for female, male, and character", () => {
      expect(ELEVENLABS_VOICE_GROUPS).toHaveLength(3);
      const labels = ELEVENLABS_VOICE_GROUPS.map((g) => g.defaultLabel);
      expect(labels).toContain("Female");
      expect(labels).toContain("Male");
      expect(labels).toContain("Character");
    });

    it("defines Edge backup voice groups", () => {
      expect(EDGE_VOICE_GROUPS).toHaveLength(1);
      expect(EDGE_VOICE_GROUPS[0].defaultLabel).toBe("Backup Voices");
    });
  });

  describe("buildVoiceConfigForCharacterEntry", () => {
    it("returns null when voicePresetId does not exist", () => {
      const entry: CharacterRosterEntry = {
        id: "char-1",
        name: "Custom",
        voicePresetId: "non-existent-preset-id",
      } as unknown as CharacterRosterEntry;

      const res = buildVoiceConfigForCharacterEntry({
        entry,
        useElevenLabs: true,
        voiceConfig: {},
      });
      expect(res).toBeNull();
    });

    it("derives elevenlabs voice configuration when useElevenLabs is true", () => {
      const entry: CharacterRosterEntry = {
        id: "char-1",
        name: "Eliza",
        voicePresetId: PREMADE_VOICES[0].id,
      } as unknown as CharacterRosterEntry;

      const res = buildVoiceConfigForCharacterEntry({
        entry,
        useElevenLabs: true,
        voiceConfig: {
          elevenlabs: { apiKey: "test-api-key" },
        },
      });

      expect(res).not.toBeNull();
      expect(res?.selectedVoicePresetId).toBe(PREMADE_VOICES[0].id);
      expect(res?.nextVoiceConfig.provider).toBe("elevenlabs");
      expect(res?.nextVoiceConfig.mode).toBe("own-key");
      expect(res?.nextVoiceConfig.elevenlabs?.modelId).toBe(
        DEFAULT_ELEVEN_FAST_MODEL,
      );
    });

    it("derives edge voice configuration when useElevenLabs is false", () => {
      const entry: CharacterRosterEntry = {
        id: "char-1",
        name: "Eliza",
        voicePresetId: PREMADE_VOICES[0].id,
      } as unknown as CharacterRosterEntry;

      const res = buildVoiceConfigForCharacterEntry({
        entry,
        useElevenLabs: false,
        voiceConfig: {},
      });

      expect(res).not.toBeNull();
      expect(res?.nextVoiceConfig.provider).toBe("edge");
    });
  });
});
