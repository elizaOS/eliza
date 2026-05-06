import { describe, expect, test } from "vitest";
import { filterConfigEnvForResponse } from "../src/api/server-config-filter";

describe("filterConfigEnvForResponse", () => {
  test("redacts nested secret-shaped config values", () => {
    const filtered = filterConfigEnvForResponse({
      cloud: { apiKey: "eliza_secret" },
      messages: {
        tts: {
          provider: "elevenlabs",
          elevenlabs: { apiKey: "voice_secret", voiceId: "voice" },
        },
      },
      linkedAccounts: {
        elizacloud: { status: "linked", source: "api-key" },
      },
    });

    expect(filtered.cloud).toEqual({ apiKey: "[REDACTED]" });
    expect(filtered.messages).toEqual({
      tts: {
        provider: "elevenlabs",
        elevenlabs: { apiKey: "[REDACTED]", voiceId: "voice" },
      },
    });
    expect(filtered.linkedAccounts).toEqual({
      elizacloud: { status: "linked", source: "api-key" },
    });
  });

  test("removes blocked env keys after redaction", () => {
    const filtered = filterConfigEnvForResponse({
      env: {
        ELIZAOS_CLOUD_API_KEY: "eliza_secret",
        OPENAI_API_KEY: "sk-secret",
        SAFE_FLAG: "1",
      },
    });

    expect(filtered.env).toEqual({
      SAFE_FLAG: "1",
      OPENAI_API_KEY: "[REDACTED]",
    });
  });
});
