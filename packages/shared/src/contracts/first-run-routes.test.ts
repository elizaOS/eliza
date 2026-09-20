/** Exercises real first-run payload parsing, complete field preservation and legacy rejection. */
import { describe, expect, it } from "vitest";
import { PostFirstRunRequestSchema } from "./first-run-routes.js";

describe("PostFirstRunRequestSchema", () => {
  it("trims the required name in a minimal payload", () => {
    expect(PostFirstRunRequestSchema.parse({ name: "  Eliza  " })).toEqual({
      name: "Eliza",
    });
  });

  it("preserves the complete character, structured sections and voice extensions", () => {
    const input = {
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
      deploymentTarget: { runtime: "local" },
      linkedAccounts: { foo: { ok: true } },
      serviceRouting: { llmText: { backend: "openai" } },
      credentialInputs: { OPENAI_API_KEY: "sk-example" },
      connectors: { telegram: { botToken: "x" } },
      features: { shellEnabled: true },
      inventoryProviders: [
        { chain: "ethereum", rpcProvider: "alchemy", rpcApiKey: "xx" },
      ],
      voicePresetId: "vox1",
      voiceLang: "en",
    };
    expect(PostFirstRunRequestSchema.parse(input)).toEqual(input);
  });

  it("preserves legacy message examples for downstream normalization", () => {
    const input = {
      name: "Eliza",
      messageExamples: [
        [{ user: "u", content: { text: "hi" } }],
        [{ name: "a", content: { text: "ok" } }],
      ],
    };
    expect(PostFirstRunRequestSchema.parse(input)).toEqual(input);
  });

  it.each([
    "connection",
    "runMode",
    "cloudProvider",
    "provider",
    "providerApiKey",
    "primaryModel",
    "nanoModel",
    "smallModel",
    "mediumModel",
    "largeModel",
    "megaModel",
  ])("rejects legacy %s payloads with a migration error", (legacy) => {
    expect(() =>
      PostFirstRunRequestSchema.parse({ name: "x", [legacy]: "v" }),
    ).toThrow(/deprecated first-run payloads are no longer supported/);
  });

  it("rejects a blank name with an actionable error", () => {
    expect(() => PostFirstRunRequestSchema.parse({ name: " " })).toThrow(
      /Missing or invalid agent name/,
    );
  });

  it.each([
    ["missing name", {}],
    ["unknown theme", { name: "Eliza", theme: "neon" }],
    ["non-string prompt", { name: "Eliza", systemPrompt: 1 }],
    ["non-array style", { name: "Eliza", style: { all: "concise" } }],
    ["unknown style key", { name: "Eliza", style: { random: ["x"] } }],
    ["non-object section", { name: "Eliza", deploymentTarget: "local" }],
    [
      "missing inventory chain",
      { name: "Eliza", inventoryProviders: [{ rpcProvider: "alchemy" }] },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => PostFirstRunRequestSchema.parse(input)).toThrow();
  });
});
