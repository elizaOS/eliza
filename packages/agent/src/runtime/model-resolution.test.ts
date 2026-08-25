/**
 * Coverage for the model-resolution helpers in ./model-resolution.ts: primary
 * model id extraction, provider id resolution across transport/backend
 * combinations, and the provider-to-plugin mapping. Runs against the real
 * @elizaos/shared first-run provider catalog and service-routing resolver —
 * those helpers are pure config readers, so no mocking is needed.
 */
import type { ElizaConfig } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
} from "./model-resolution.ts";

describe("resolvePrimaryModel", () => {
  it("returns undefined when no model config exists", () => {
    expect(resolvePrimaryModel({})).toBeUndefined();
    expect(resolvePrimaryModel({ agents: {} })).toBeUndefined();
    expect(resolvePrimaryModel({ agents: { defaults: {} } })).toBeUndefined();
  });

  it("returns the primary model id when configured", () => {
    const config: ElizaConfig = {
      agents: { defaults: { model: { primary: "deepseek-chat" } } },
    };
    expect(resolvePrimaryModel(config)).toBe("deepseek-chat");
  });
});

describe("resolvePreferredProviderId", () => {
  it("returns elizacloud for a cloud-proxy transport onto the cloud backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "cloud-proxy", backend: "elizacloud" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("elizacloud");
  });

  it("returns the direct backend when it is not elizacloud", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("falls back to the model-name hint for a direct transport without a backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", primaryModel: "openai/gpt-4o" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("falls back to the model-name hint for a remote transport without a backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "remote", primaryModel: "anthropic/claude" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("ignores an elizacloud backend on a direct transport and uses the hint", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          transport: "direct",
          backend: "elizacloud",
          primaryModel: "openai/gpt-4o",
        },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("derives the provider from the configured primary model when routing is absent", () => {
    const config: ElizaConfig = {
      serviceRouting: {},
      agents: { defaults: { model: { primary: "anthropic/claude" } } },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolvePreferredProviderId({ serviceRouting: {} })).toBeUndefined();
  });
});

describe("resolvePreferredProviderPluginName", () => {
  it("maps a resolved provider id to its plugin package name", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
    };
    expect(resolvePreferredProviderPluginName(config)).toBe(
      "@elizaos/plugin-anthropic",
    );
  });

  it("returns undefined when no provider is resolved", () => {
    expect(
      resolvePreferredProviderPluginName({ serviceRouting: {} }),
    ).toBeUndefined();
  });
});
