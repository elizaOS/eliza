import { describe, expect, it } from "vitest";
import {
  ONBOARDING_LEGACY_FIELD_KEYS,
  PostOnboardingRequestSchema,
} from "./onboarding-routes.js";

describe("PostOnboardingRequestSchema", () => {
  it("accepts the minimal required body and trims name", () => {
    const parsed = PostOnboardingRequestSchema.parse({ name: "  Eliza  " });
    expect(parsed.name).toBe("Eliza");
  });

  it("rejects whitespace-only name", () => {
    expect(() => PostOnboardingRequestSchema.parse({ name: " " })).toThrow(
      /Missing or invalid agent name/,
    );
  });

  it("rejects missing name", () => {
    expect(() => PostOnboardingRequestSchema.parse({})).toThrow();
  });

  it("rejects each legacy field with the canonical legacy message", () => {
    for (const legacy of ONBOARDING_LEGACY_FIELD_KEYS) {
      expect(() =>
        PostOnboardingRequestSchema.parse({ name: "x", [legacy]: "v" }),
      ).toThrow(/legacy onboarding payloads are no longer supported/);
    }
  });

  it("accepts a fully populated character body", () => {
    const parsed = PostOnboardingRequestSchema.parse({
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
      PostOnboardingRequestSchema.parse({
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
      PostOnboardingRequestSchema.parse({ name: "Eliza", theme: "neon" }),
    ).toThrow();
  });

  it("rejects non-string field type (systemPrompt as number)", () => {
    expect(() =>
      PostOnboardingRequestSchema.parse({
        name: "Eliza",
        systemPrompt: 1,
      }),
    ).toThrow();
  });

  it("rejects bad style.all (not an array)", () => {
    expect(() =>
      PostOnboardingRequestSchema.parse({
        name: "Eliza",
        style: { all: "concise" },
      }),
    ).toThrow();
  });

  it("rejects unknown style key (strict)", () => {
    expect(() =>
      PostOnboardingRequestSchema.parse({
        name: "Eliza",
        style: { random: ["x"] },
      }),
    ).toThrow();
  });

  it("accepts structured sections as objects (deep shape goes to normalization helpers)", () => {
    const parsed = PostOnboardingRequestSchema.parse({
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
      PostOnboardingRequestSchema.parse({
        name: "Eliza",
        deploymentTarget: "local",
      }),
    ).toThrow();
  });

  it("accepts inventory providers", () => {
    const parsed = PostOnboardingRequestSchema.parse({
      name: "Eliza",
      inventoryProviders: [
        { chain: "ethereum", rpcProvider: "alchemy", rpcApiKey: "xx" },
      ],
    });
    expect(parsed.inventoryProviders?.[0]?.chain).toBe("ethereum");
  });

  it("rejects malformed inventory providers entry (missing chain)", () => {
    expect(() =>
      PostOnboardingRequestSchema.parse({
        name: "Eliza",
        inventoryProviders: [{ rpcProvider: "alchemy" }],
      }),
    ).toThrow();
  });

  it("passes voice preset fields through unchanged (passthrough)", () => {
    const parsed = PostOnboardingRequestSchema.parse({
      name: "Eliza",
      voicePresetId: "vox1",
      voiceLang: "en",
    } as unknown as { name: string });
    expect((parsed as Record<string, unknown>).voicePresetId).toBe("vox1");
    expect((parsed as Record<string, unknown>).voiceLang).toBe("en");
  });
});
