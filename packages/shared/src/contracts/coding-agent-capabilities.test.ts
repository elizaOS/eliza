/**
 * Proves the pure account-to-coding-backend contract, including negative
 * coverage for enrolled inference providers that have no spawn implementation.
 */

import { LINKED_ACCOUNT_PROVIDER_IDS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_BACKEND_PROVIDERS,
  CODING_AGENT_BACKENDS,
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
    for (const [backend, providers] of Object.entries(
      CODING_AGENT_BACKEND_PROVIDERS,
    )) {
      if (providers.length === 0) continue;
      expect(CODING_AGENT_BACKENDS).toContain(backend);
    }
  });
});
