/**
 * `parseCharacter` moves every settings key its schema does not declare into
 * `settings.extra`. The cloud runtime must still use the character's own
 * voice, model and embedding settings from there, not the defaults. Real
 * `parseCharacter`, `buildSettings` and `AgentRuntime.getSetting`.
 */
import { describe, expect, test } from "bun:test";
import { AgentRuntime, parseCharacter } from "@elizaos/core";
import { buildSettings, resolveHostedEmbeddingModel } from "./settings";

const character = parseCharacter({
  name: "Ava",
  bio: ["A voice agent."],
  settings: {
    ELEVENLABS_VOICE_ID: "customVoice123",
    ELIZAOS_CLOUD_SMALL_MODEL: "anthropic/claude-x",
    OPENAI_EMBEDDING_MODEL: "text-embedding-3-large",
  },
});

describe("cloud runtime settings from a parsed character", () => {
  test("uses the character's own settings that parseCharacter moved to extra", () => {
    const settings = buildSettings(character, {} as never) as Record<string, unknown>;

    expect(settings.ELEVENLABS_VOICE_ID).toBe("customVoice123");
    expect(settings.ELIZAOS_CLOUD_SMALL_MODEL).toBe("anthropic/claude-x");
    expect(settings.ELIZAOS_CLOUD_EMBEDDING_MODEL).toBe("text-embedding-3-large");
    expect(resolveHostedEmbeddingModel(character)).toBe("text-embedding-3-large");

    const runtime = new AgentRuntime({ character: { ...character, settings } });
    expect(runtime.getSetting("ELEVENLABS_VOICE_ID")).toBe("customVoice123");
    expect(runtime.getSetting("ELIZAOS_CLOUD_SMALL_MODEL")).toBe("anthropic/claude-x");
  });
});
