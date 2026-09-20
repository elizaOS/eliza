/**
 * Contract tests for the plugin-management route request schemas (install, update,
 * uninstall, core-toggle, PUT plugin, secrets, curated skill source): covers name
 * trimming, config/secret value typing, the release-stream enum, and strict
 * extra-field rejection. Parses through the real Zod schemas.
 */
import { describe, expect, it } from "vitest";
import {
  PostPluginCoreToggleRequestSchema,
  PostPluginInstallRequestSchema,
  PostPluginUninstallRequestSchema,
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

  it.each([
    ["non-string config values", { config: { KEY: 123 } }],
    ["extra fields", { enabled: true, foo: "bar" }],
  ])("rejects %s", (_name, input) => {
    expect(() => PutPluginRequestSchema.parse(input)).toThrow();
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

  it.each([
    ["missing secrets", {}],
    ["non-string values", { secrets: { KEY: 1 } }],
    ["extra fields", { secrets: {}, audit: true }],
  ])("rejects %s", (_name, input) => {
    expect(() => PutSecretsRequestSchema.parse(input)).toThrow();
  });
});

describe("PostPluginInstallRequestSchema", () => {
  it("normalizes names and versions in a complete install request", () => {
    const parsed = PostPluginInstallRequestSchema.parse({
      name: "  @elizaos/plugin-x  ",
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

describe("PostPluginUninstallRequestSchema", () => {
  it("trims name and preserves autoRestart=false", () => {
    expect(
      PostPluginUninstallRequestSchema.parse({
        name: " @x/y ",
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

  it.each([
    ["missing enabled", { npmName: "x" }],
    ["non-boolean enabled", { npmName: "x", enabled: "yes" }],
    ["extra fields", { npmName: "x", enabled: true, force: true }],
  ])("rejects %s", (_name, input) => {
    expect(() => PostPluginCoreToggleRequestSchema.parse(input)).toThrow();
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

  it.each([
    ["non-string content", { content: 1 }],
    ["missing content", {}],
    ["extra fields", { content: "x", path: "/" }],
  ])("rejects %s", (_name, input) => {
    expect(() => PutCuratedSkillSourceRequestSchema.parse(input)).toThrow();
  });
});
