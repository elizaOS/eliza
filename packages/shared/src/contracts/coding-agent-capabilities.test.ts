/**
 * Proves the pure account-to-coding-backend contract, including negative
 * coverage for enrolled inference providers that have no spawn implementation.
 */

import { LINKED_ACCOUNT_PROVIDER_IDS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_BACKEND_PREFLIGHTS,
  CODING_AGENT_BACKEND_PROVIDERS,
  CODING_AGENT_BACKENDS,
  CODING_PROVIDER_DESCRIPTOR_VERSION,
  CODING_PROVIDER_DESCRIPTORS,
  CODING_PROVIDER_SUPPORT_MATRIX,
  codingAgentBackendForProvider,
  codingAgentSpawnCapabilityForProvider,
} from "./coding-agent-capabilities.js";

describe("coding-agent capability mapping", () => {
  it("maps every advertised account capability to one canonical backend", () => {
    const mappedProviders = LINKED_ACCOUNT_PROVIDER_IDS.filter(
      (providerId) =>
        codingAgentSpawnCapabilityForProvider(providerId).available,
    );

    expect(mappedProviders).toEqual(["anthropic-subscription", "openai-codex"]);
    for (const providerId of mappedProviders) {
      const backend = codingAgentBackendForProvider(providerId);
      expect(CODING_AGENT_BACKENDS).toContain(backend);
      if (!backend) throw new Error(`missing backend for ${providerId}`);
      expect(CODING_AGENT_BACKEND_PROVIDERS[backend]).toContain(providerId);
    }
  });

  it.each([
    "gemini-cli",
    "zai-coding",
    "kimi-coding",
    "deepseek-coding",
    "deepseek-api",
    "zai-api",
    "moonshot-api",
    "anthropic-api",
    "openai-api",
    "cerebras-api",
  ] as const)("keeps %s enrollment separate from spawn availability", (id) => {
    const capability = codingAgentSpawnCapabilityForProvider(id);
    expect(capability.available).toBe(false);
    expect(capability.backend).toBeUndefined();
    expect(capability.unavailableReason).toBeTruthy();
  });

  it("declares a preflight backend for every credential route", () => {
    expect(CODING_AGENT_BACKEND_PREFLIGHTS).toEqual({
      elizaos: {
        requiredRuntime: "eliza-code-acp",
        discoveryPolicy: "bundled-or-configured-command",
        commandConfigKey: "ELIZA_ELIZAOS_ACP_COMMAND",
        commandResolution: "literal",
        defaultCommand: "eliza-code-acp",
      },
      "pi-agent": {
        requiredRuntime: "pi-agent",
        discoveryPolicy: "bundled-or-configured-command",
        commandConfigKey: "ELIZA_PI_AGENT_ACP_COMMAND",
        commandResolution: "literal",
        defaultCommand: "pi-agent",
      },
      claude: {
        requiredRuntime: "claude-acp",
        discoveryPolicy: "configured-command-or-path",
        commandConfigKey: "ELIZA_CLAUDE_ACP_COMMAND",
        commandResolution: "literal",
        defaultCommand: "npx -y @agentclientprotocol/claude-agent-acp@0.34.0",
      },
      codex: {
        requiredRuntime: "codex-acp",
        discoveryPolicy: "configured-command-or-path",
        commandConfigKey: "ELIZA_CODEX_ACP_COMMAND",
        commandResolution: "managed-codex",
      },
      kimi: {
        requiredRuntime: "kimi-cli",
        discoveryPolicy: "configured-command-or-path",
        commandConfigKey: "ELIZA_KIMI_ACP_COMMAND",
        commandResolution: "literal",
        defaultCommand: "kimi acp",
      },
      grok: {
        requiredRuntime: "grok-build-cli",
        discoveryPolicy: "configured-command-or-path",
        commandConfigKey: "ELIZA_GROK_ACP_COMMAND",
        commandResolution: "literal",
        defaultCommand: "grok agent stdio",
      },
    });
    for (const backend of CODING_AGENT_BACKENDS) {
      const providers = CODING_AGENT_BACKEND_PROVIDERS[backend];
      if (providers.length === 0) continue;
      expect(CODING_AGENT_BACKENDS).toContain(backend);
      expect(
        typeof CODING_AGENT_BACKEND_PREFLIGHTS[backend].requiredRuntime,
      ).toBe("string");
      expect(
        typeof CODING_AGENT_BACKEND_PREFLIGHTS[backend].discoveryPolicy,
      ).toBe("string");
    }
  });

  it("describes every linked-account catalog provider exactly once", () => {
    const descriptorIds = Object.keys(CODING_PROVIDER_DESCRIPTORS);
    expect(descriptorIds).toEqual([...LINKED_ACCOUNT_PROVIDER_IDS]);
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length);
    for (const [providerId, descriptor] of Object.entries(
      CODING_PROVIDER_DESCRIPTORS,
    )) {
      expect(descriptor.version).toBe(CODING_PROVIDER_DESCRIPTOR_VERSION);
      expect(descriptor.providerId).toBe(providerId);
      expect(descriptor.accountKind).toMatch(/^(subscription|api-key)$/);
      expect(descriptor.authMode).toMatch(
        /^(oauth|direct-api-key|coding-plan-key|external-cli|unavailable)$/,
      );
      expect(descriptor.billingMode).toMatch(
        /^(subscription-coding-plan|subscription-coding-cli|usage)$/,
      );
      expect(typeof descriptor.enrollmentSupport).toBe("boolean");
      expect(typeof descriptor.inferenceSupport).toBe("boolean");
      expect(typeof descriptor.spawnSupport).toBe("boolean");
      expect(descriptor.spawnSupport).toBe(descriptor.backend !== null);
      if (descriptor.spawnSupport) {
        if (!descriptor.backend) {
          throw new Error(`missing backend for ${providerId}`);
        }
        expect(descriptor.requiredRuntime).toBe(
          CODING_AGENT_BACKEND_PREFLIGHTS[descriptor.backend].requiredRuntime,
        );
        expect(descriptor.discoveryPolicy).toBe(
          CODING_AGENT_BACKEND_PREFLIGHTS[descriptor.backend].discoveryPolicy,
        );
        expect(descriptor.unsupportedReason).toBeNull();
      } else {
        expect(descriptor.requiredRuntime).toBeNull();
        expect(descriptor.discoveryPolicy).toBe("none");
        expect(descriptor.unsupportedReason).toBeTruthy();
      }
    }
    for (const providerId of ["zai-coding", "kimi-coding"] as const) {
      expect(CODING_PROVIDER_DESCRIPTORS[providerId]).toMatchObject({
        authMode: "coding-plan-key",
        billingMode: "subscription-coding-plan",
        inferenceSupport: true,
        spawnSupport: false,
      });
    }
  });

  it("rejects provider-to-backend ambiguity and descriptor drift", () => {
    const routedProviders = Object.values(
      CODING_AGENT_BACKEND_PROVIDERS,
    ).flat();
    expect(new Set(routedProviders).size).toBe(routedProviders.length);
    for (const providerId of routedProviders) {
      const descriptor = CODING_PROVIDER_DESCRIPTORS[providerId];
      expect(descriptor.spawnSupport).toBe(true);
      expect(descriptor.backend).toBe(
        codingAgentBackendForProvider(providerId),
      );
    }
    const descriptorProviders = Object.values(CODING_PROVIDER_DESCRIPTORS)
      .filter((descriptor) => descriptor.spawnSupport)
      .map((descriptor) => descriptor.providerId)
      .sort();
    expect(descriptorProviders).toEqual([...routedProviders].sort());
  });

  it("fails closed for an unknown provider", () => {
    expect(codingAgentBackendForProvider("unknown-provider")).toBeUndefined();
    expect(codingAgentSpawnCapabilityForProvider("unknown-provider")).toEqual({
      available: false,
      unavailableReason:
        "No supported coding-agent spawn backend consumes this account provider.",
    });
  });

  it("emits a deterministic versioned provider support matrix", () => {
    expect(CODING_PROVIDER_SUPPORT_MATRIX).toEqual({
      version: CODING_PROVIDER_DESCRIPTOR_VERSION,
      providers: Object.values(CODING_PROVIDER_DESCRIPTORS),
    });
    expect(JSON.parse(JSON.stringify(CODING_PROVIDER_SUPPORT_MATRIX))).toEqual(
      CODING_PROVIDER_SUPPORT_MATRIX,
    );
  });
});
