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

    expect(mappedProviders).toEqual([
      "anthropic-subscription",
      "openai-codex",
      "anthropic-api",
      "openai-api",
      "cerebras-api",
    ]);
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
  ] as const)("keeps %s enrollment separate from spawn availability", (id) => {
    const capability = codingAgentSpawnCapabilityForProvider(id);
    expect(capability.available).toBe(false);
    expect(capability.backend).toBeUndefined();
    expect(capability.unavailableReason).toBeTruthy();
  });

  it("declares a preflight backend for every credential route", () => {
    for (const backend of CODING_AGENT_BACKENDS) {
      const providers = CODING_AGENT_BACKEND_PROVIDERS[backend];
      if (providers.length === 0) continue;
      expect(CODING_AGENT_BACKENDS).toContain(backend);
      expect(CODING_AGENT_BACKEND_PREFLIGHTS[backend]).toMatchObject({
        requiredRuntime: expect.any(String),
        discoveryPolicy: expect.any(String),
      });
    }
  });

  it("describes every linked-account catalog provider exactly once", () => {
    const descriptorIds = Object.keys(CODING_PROVIDER_DESCRIPTORS);
    expect(descriptorIds).toEqual([...LINKED_ACCOUNT_PROVIDER_IDS]);
    expect(new Set(descriptorIds).size).toBe(descriptorIds.length);
    for (const [providerId, descriptor] of Object.entries(
      CODING_PROVIDER_DESCRIPTORS,
    )) {
      expect(descriptor).toMatchObject({
        version: CODING_PROVIDER_DESCRIPTOR_VERSION,
        providerId,
        accountKind: expect.stringMatching(/^(subscription|api-key)$/),
        authMode: expect.stringMatching(
          /^(oauth|api-key|external-cli|unavailable)$/,
        ),
        billingMode: expect.stringMatching(/^(subscription|usage)$/),
        inferenceSupport: expect.any(Boolean),
        spawnSupport: expect.any(Boolean),
      });
      expect(descriptor.spawnSupport).toBe(descriptor.backend !== null);
      if (descriptor.spawnSupport) {
        expect(descriptor.requiredRuntime).toBeTruthy();
        expect(descriptor.discoveryPolicy).not.toBe("none");
        expect(descriptor.unsupportedReason).toBeNull();
      } else {
        expect(descriptor.requiredRuntime).toBeNull();
        expect(descriptor.discoveryPolicy).toBe("none");
        expect(descriptor.unsupportedReason).toBeTruthy();
      }
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
