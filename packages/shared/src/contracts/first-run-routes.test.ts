/**
 * Contract tests for PostFirstRunRequestSchema, the onboarding payload that
 * seeds a new agent's character. Covers the required trimmed name, rejection
 * of every deprecated field key with the canonical legacy message, the full
 * character body (bio/systemPrompt/style/examples/theme/preset), both the
 * current and legacy messageExamples shapes, strict style keys, structured
 * sections (deployment/linked accounts/service routing/credentials/connectors/
 * features/inventory providers), and voice-preset passthrough. Pure in-process
 * schema parsing — no server or mocks.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_DEPRECATED_FIELD_KEYS,
  PostFirstRunRequestSchema,
} from "./first-run-routes.js";

describe("PostFirstRunRequestSchema", () => {
  it("accepts the minimal required body and trims name", () => {
    const parsed = PostFirstRunRequestSchema.parse({ name: "  Eliza  " });
    expect(parsed.name).toBe("Eliza");
  });

  it("rejects whitespace-only name", () => {
    expect(() => PostFirstRunRequestSchema.parse({ name: " " })).toThrow(
      /Missing or invalid agent name/,
    );
  });

  it("rejects missing name", () => {
    expect(() => PostFirstRunRequestSchema.parse({})).toThrow();
  });

  it("rejects each legacy field with the canonical legacy message", () => {
    for (const legacy of FIRST_RUN_DEPRECATED_FIELD_KEYS) {
      expect(() =>
        PostFirstRunRequestSchema.parse({ name: "x", [legacy]: "v" }),
      ).toThrow(/deprecated first-run payloads are no longer supported/);
    }
  });

  it("accepts a fully populated character body", () => {
    const parsed = PostFirstRunRequestSchema.parse({
      name: "Eliza",
      bio: ["one", "two"],
      systemPrompt: "you are Eliza",
      style: { all: ["concise"], chat: ["friendly"], post: ["sharp"] },
      adjectives: ["curious"],
      topics: ["ai"],
      postExamples: ["hello world"],
      messageExamples: [{ examples: [{ name: "u", content: { text: "hi" } }] }],
      avatarIndex: 3,
      presetId: "default",
      language: "en",
      theme: "eliza",
    });
    expect(parsed.theme).toBe("eliza");
    expect(parsed.bio).toEqual(["one", "two"]);
  });

  it("accepts the legacy messageExamples shape (per-item array of users)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        messageExamples: [
          [{ user: "u", content: { text: "hi" } }],
          [{ name: "a", content: { text: "ok" } }],
        ],
      }),
    ).not.toThrow();
  });

  it("rejects unknown theme", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({ name: "Eliza", theme: "neon" }),
    ).toThrow();
  });

  it("rejects non-string field type (systemPrompt as number)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        systemPrompt: 1,
      }),
    ).toThrow();
  });

  it("rejects bad style.all (not an array)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        style: { all: "concise" },
      }),
    ).toThrow();
  });

  it("rejects unknown style key (strict)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        style: { random: ["x"] },
      }),
    ).toThrow();
  });

  it("accepts structured sections as objects (deep shape goes to normalization helpers)", () => {
    const parsed = PostFirstRunRequestSchema.parse({
      name: "Eliza",
      deploymentTarget: { runtime: "local" },
      linkedAccounts: { foo: { ok: true } },
      serviceRouting: { llmText: { backend: "openai" } },
      credentialInputs: { OPENAI_API_KEY: "sk-..." },
      connectors: { telegram: { botToken: "x" } },
      features: { shellEnabled: true },
    });
    expect(parsed.deploymentTarget).toEqual({ runtime: "local" });
  });

  it("rejects non-object structured section (deploymentTarget as string)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        deploymentTarget: "local",
      }),
    ).toThrow();
  });

  it("accepts inventory providers", () => {
    const parsed = PostFirstRunRequestSchema.parse({
      name: "Eliza",
      inventoryProviders: [
        { chain: "ethereum", rpcProvider: "alchemy", rpcApiKey: "xx" },
      ],
    });
    expect(parsed.inventoryProviders?.[0]?.chain).toBe("ethereum");
  });

  it("rejects malformed inventory providers entry (missing chain)", () => {
    expect(() =>
      PostFirstRunRequestSchema.parse({
        name: "Eliza",
        inventoryProviders: [{ rpcProvider: "alchemy" }],
      }),
    ).toThrow();
  });

  it("passes voice preset fields through unchanged (passthrough)", () => {
    const input: Record<string, unknown> = {
      name: "Eliza",
      voicePresetId: "vox1",
      voiceLang: "en",
    };
    const parsed = PostFirstRunRequestSchema.parse(input);
    expect((parsed as Record<string, unknown>).voicePresetId).toBe("vox1");
    expect((parsed as Record<string, unknown>).voiceLang).toBe("en");
  });
});
