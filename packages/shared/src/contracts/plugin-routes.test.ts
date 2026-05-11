import { describe, expect, it } from "vitest";
import {
  PostPluginCoreToggleRequestSchema,
  PostPluginInstallRequestSchema,
  PostPluginUninstallRequestSchema,
  PostPluginUpdateRequestSchema,
  PutCuratedSkillSourceRequestSchema,
  PutPluginRequestSchema,
  PutSecretsRequestSchema,
} from "./plugin-routes.js";

describe("PutPluginRequestSchema", () => {
  it("accepts an empty body", () => {
    expect(PutPluginRequestSchema.parse({})).toEqual({});
  });

  it("accepts enabled only", () => {
    expect(PutPluginRequestSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
  });

  it("accepts config only", () => {
    expect(PutPluginRequestSchema.parse({ config: { KEY: "v" } })).toEqual({
      config: { KEY: "v" },
    });
  });

  it("rejects non-string config values", () => {
    expect(() =>
      PutPluginRequestSchema.parse({ config: { KEY: 123 } }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutPluginRequestSchema.parse({ enabled: true, foo: "bar" }),
    ).toThrow();
  });
});

describe("PutSecretsRequestSchema", () => {
  it("accepts a populated secrets map", () => {
    const parsed = PutSecretsRequestSchema.parse({
      secrets: { OPENAI_API_KEY: "sk-...", FOO: "bar" },
    });
    expect(parsed.secrets).toEqual({ OPENAI_API_KEY: "sk-...", FOO: "bar" });
  });

  it("accepts empty secrets map", () => {
    expect(PutSecretsRequestSchema.parse({ secrets: {} })).toEqual({
      secrets: {},
    });
  });

  it("rejects missing secrets", () => {
    expect(() => PutSecretsRequestSchema.parse({})).toThrow();
  });

  it("rejects non-string values", () => {
    expect(() =>
      PutSecretsRequestSchema.parse({ secrets: { KEY: 1 } }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutSecretsRequestSchema.parse({ secrets: {}, audit: true }),
    ).toThrow();
  });
});

describe("PostPluginInstallRequestSchema", () => {
  it("trims name", () => {
    expect(
      PostPluginInstallRequestSchema.parse({ name: "  @elizaos/plugin-x  " }),
    ).toEqual({ name: "@elizaos/plugin-x" });
  });

  it("accepts full body", () => {
    const parsed = PostPluginInstallRequestSchema.parse({
      name: "@elizaos/plugin-x",
      autoRestart: false,
      stream: "beta",
      version: " 1.2.3 ",
    });
    expect(parsed).toEqual({
      name: "@elizaos/plugin-x",
      autoRestart: false,
      stream: "beta",
      version: "1.2.3",
    });
  });

  it("absorbs whitespace-only version as absent", () => {
    expect(
      PostPluginInstallRequestSchema.parse({
        name: "@elizaos/plugin-x",
        version: "  ",
      }),
    ).toEqual({ name: "@elizaos/plugin-x" });
  });

  it("rejects whitespace-only name", () => {
    expect(() => PostPluginInstallRequestSchema.parse({ name: "   " })).toThrow(
      /name is required/,
    );
  });

  it("rejects bad stream value", () => {
    expect(() =>
      PostPluginInstallRequestSchema.parse({ name: "x", stream: "alpha" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostPluginInstallRequestSchema.parse({ name: "x", from: "git" }),
    ).toThrow();
  });
});

describe("PostPluginUpdateRequestSchema", () => {
  it("trims name and accepts the same shape as install", () => {
    expect(
      PostPluginUpdateRequestSchema.parse({ name: "  @elizaos/plugin-x  " }),
    ).toEqual({ name: "@elizaos/plugin-x" });
  });
});

describe("PostPluginUninstallRequestSchema", () => {
  it("trims name", () => {
    expect(PostPluginUninstallRequestSchema.parse({ name: " @x/y " })).toEqual({
      name: "@x/y",
    });
  });

  it("accepts autoRestart=false", () => {
    expect(
      PostPluginUninstallRequestSchema.parse({
        name: "@x/y",
        autoRestart: false,
      }),
    ).toEqual({ name: "@x/y", autoRestart: false });
  });

  it("rejects whitespace-only name", () => {
    expect(() =>
      PostPluginUninstallRequestSchema.parse({ name: "  " }),
    ).toThrow(/name is required/);
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostPluginUninstallRequestSchema.parse({ name: "x", purge: true }),
    ).toThrow();
  });
});

describe("PostPluginCoreToggleRequestSchema", () => {
  it("trims npmName + keeps enabled", () => {
    expect(
      PostPluginCoreToggleRequestSchema.parse({
        npmName: " @elizaos/plugin-x ",
        enabled: true,
      }),
    ).toEqual({ npmName: "@elizaos/plugin-x", enabled: true });
  });

  it("rejects whitespace-only npmName", () => {
    expect(() =>
      PostPluginCoreToggleRequestSchema.parse({ npmName: " ", enabled: true }),
    ).toThrow(/npmName is required/);
  });

  it("rejects missing enabled", () => {
    expect(() =>
      PostPluginCoreToggleRequestSchema.parse({ npmName: "x" }),
    ).toThrow();
  });

  it("rejects non-boolean enabled", () => {
    expect(() =>
      PostPluginCoreToggleRequestSchema.parse({ npmName: "x", enabled: "yes" }),
    ).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PostPluginCoreToggleRequestSchema.parse({
        npmName: "x",
        enabled: true,
        force: true,
      }),
    ).toThrow();
  });
});

describe("PutCuratedSkillSourceRequestSchema", () => {
  it("accepts arbitrary string content", () => {
    expect(
      PutCuratedSkillSourceRequestSchema.parse({ content: "# hi" }),
    ).toEqual({ content: "# hi" });
    expect(PutCuratedSkillSourceRequestSchema.parse({ content: "" })).toEqual({
      content: "",
    });
  });

  it("rejects non-string content", () => {
    expect(() =>
      PutCuratedSkillSourceRequestSchema.parse({ content: 1 }),
    ).toThrow();
  });

  it("rejects missing content", () => {
    expect(() => PutCuratedSkillSourceRequestSchema.parse({})).toThrow();
  });

  it("rejects extra fields", () => {
    expect(() =>
      PutCuratedSkillSourceRequestSchema.parse({ content: "x", path: "/" }),
    ).toThrow();
  });
});
