/** Exercises server config filter behavior with deterministic app-core test fixtures. */
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

  test("redacts GH_PAT — a bearer credential the suffix regex cannot catch (#16564)", () => {
    const filtered = filterConfigEnvForResponse({
      env: {
        GH_PAT: "ghp_livecredential",
        GITHUB_TOKEN: "ghs_repo_scoped",
        XDG_DATA_PATH: "/home/user/.local/share",
      },
    });

    const env = filtered.env as Record<string, unknown>;
    // Set members are REMOVED outright (stronger than redaction), exactly
    // like the sibling GITHUB_TOKEN entry.
    expect("GH_PAT" in env).toBe(false);
    expect("GITHUB_TOKEN" in env).toBe(false);
    // PATH-like names stay readable — no false positives from the PAT entry.
    expect(env.XDG_DATA_PATH).toBe("/home/user/.local/share");
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
