import { describe, expect, test } from "bun:test";
import { classifyOperation, defaultClassifier } from "./classifier.js";
import type { ClassifyContext } from "./classifier.js";
import type { OperationIntent } from "./types.js";

const ctx = (overrides: Partial<ClassifyContext> = {}): ClassifyContext => ({
  ...overrides,
});

describe("classifyOperation — restart", () => {
  test("restart → cold", () => {
    const intent: OperationIntent = { kind: "restart", reason: "user" };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });
});

describe("classifyOperation — plugin enable/disable", () => {
  test("plugin-enable → cold", () => {
    const intent: OperationIntent = {
      kind: "plugin-enable",
      pluginId: "@elizaos/plugin-discord",
    };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });

  test("plugin-disable → cold", () => {
    const intent: OperationIntent = {
      kind: "plugin-disable",
      pluginId: "@elizaos/plugin-discord",
    };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });
});

describe("classifyOperation — provider-switch", () => {
  test("same provider, only API key changed → hot", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKey: "sk-new",
    };
    expect(
      classifyOperation(
        intent,
        ctx({ currentProvider: "openai", currentApiKey: "sk-old" }),
      ),
    ).toBe("hot");
  });

  test("same provider, only primaryModel changed → hot", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "openai",
      primaryModel: "gpt-5.5",
    };
    expect(
      classifyOperation(
        intent,
        ctx({ currentProvider: "openai", currentPrimaryModel: "gpt-5" }),
      ),
    ).toBe("hot");
  });

  test("same provider, both key and model changed → hot", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "anthropic",
      apiKey: "sk-ant-new",
      primaryModel: "claude-opus-4-7",
    };
    expect(
      classifyOperation(
        intent,
        ctx({
          currentProvider: "anthropic",
          currentApiKey: "sk-ant-old",
          currentPrimaryModel: "claude-haiku-4-5-20251001",
        }),
      ),
    ).toBe("hot");
  });

  test("openai → openai-subscription (same family) → warm", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "openai-subscription",
    };
    expect(
      classifyOperation(intent, ctx({ currentProvider: "openai" })),
    ).toBe("warm");
  });

  test("anthropic → anthropic-subscription (same family) → warm", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "anthropic-subscription",
    };
    expect(
      classifyOperation(intent, ctx({ currentProvider: "anthropic" })),
    ).toBe("warm");
  });

  test("anthropic → openai (cross-family) → cold", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKey: "sk-new",
    };
    expect(
      classifyOperation(intent, ctx({ currentProvider: "anthropic" })),
    ).toBe("cold");
  });

  test("first-time provider setup (no current provider) → cold", () => {
    const intent: OperationIntent = {
      kind: "provider-switch",
      provider: "openai",
      apiKey: "sk-new",
    };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });
});

describe("classifyOperation — config-reload", () => {
  test("changedPaths under env./vars./models. → hot", () => {
    const intent: OperationIntent = {
      kind: "config-reload",
      changedPaths: ["env.OPENAI_API_KEY"],
    };
    expect(classifyOperation(intent, ctx())).toBe("hot");
  });

  test("multiple env/vars/models paths → hot", () => {
    const intent: OperationIntent = {
      kind: "config-reload",
      changedPaths: [
        "env.ANTHROPIC_API_KEY",
        "vars.SOMETHING",
        "models.large",
      ],
    };
    expect(classifyOperation(intent, ctx())).toBe("hot");
  });

  test("no changedPaths → cold (conservative)", () => {
    const intent: OperationIntent = { kind: "config-reload" };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });

  test("empty changedPaths → cold (conservative)", () => {
    const intent: OperationIntent = {
      kind: "config-reload",
      changedPaths: [],
    };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });

  test("any non-hot path → cold", () => {
    const intent: OperationIntent = {
      kind: "config-reload",
      changedPaths: ["env.OPENAI_API_KEY", "agents.list"],
    };
    expect(classifyOperation(intent, ctx())).toBe("cold");
  });
});

describe("defaultClassifier", () => {
  test("delegates to classifyOperation", () => {
    const intent: OperationIntent = { kind: "restart", reason: "user" };
    expect(defaultClassifier(intent, ctx())).toBe(
      classifyOperation(intent, ctx()),
    );
  });
});
