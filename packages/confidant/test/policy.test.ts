import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide } from "../src/policy/grants.js";
import {
  __resetSecretSchemaForTests,
  defineSecretSchema,
} from "../src/secret-schema.js";

beforeEach(() => __resetSecretSchemaForTests());
afterEach(() => __resetSecretSchemaForTests());

describe("policy.decide", () => {
  it("denies by default with no grants and no implicit ownership", () => {
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [],
    });
    expect(decision.kind).toBe("deny");
  });

  it("implicitly grants the registering plugin always-access", () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const decision = decide({
      skillId: "@elizaos/plugin-openrouter",
      secretId: "llm.openrouter.apiKey",
      grants: [],
    });
    expect(decision).toMatchObject({ kind: "allow", mode: "always", pattern: "implicit" });
  });

  it("explicit deny wins over allow at the same pattern", () => {
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [
        { pattern: "llm.openrouter.apiKey", mode: "always", grantedAt: 1 },
        { pattern: "llm.openrouter.apiKey", mode: "deny", grantedAt: 2 },
      ],
    });
    expect(decision.kind).toBe("deny");
  });

  it("explicit deny on a parent pattern blocks a child secret", () => {
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [
        { pattern: "llm.openrouter.apiKey", mode: "always", grantedAt: 1 },
        { pattern: "llm.openrouter.*", mode: "deny", grantedAt: 2 },
      ],
    });
    expect(decision.kind).toBe("deny");
  });

  it("more-specific allow wins over broader allow", () => {
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [
        { pattern: "llm.*", mode: "audit", grantedAt: 1 },
        { pattern: "llm.openrouter.apiKey", mode: "always", grantedAt: 2 },
      ],
    });
    expect(decision).toMatchObject({
      kind: "allow",
      mode: "always",
      pattern: "llm.openrouter.apiKey",
    });
  });

  it("prompt mode surfaces as a `prompt` decision", () => {
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [
        { pattern: "llm.openrouter.*", mode: "prompt", grantedAt: 1 },
      ],
    });
    expect(decision).toMatchObject({ kind: "prompt", pattern: "llm.openrouter.*" });
  });

  it("implicit ownership applies only to the exact plugin id", () => {
    defineSecretSchema({
      "llm.openrouter.apiKey": {
        label: "OpenRouter API Key",
        sensitive: true,
        pluginId: "@elizaos/plugin-openrouter",
      },
    });
    const decision = decide({
      skillId: "weather-bot",
      secretId: "llm.openrouter.apiKey",
      grants: [],
    });
    expect(decision.kind).toBe("deny");
  });
});
