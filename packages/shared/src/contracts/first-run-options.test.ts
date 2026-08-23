/**
 * Unit tests for first-run options and provider normalization helpers.
 */

import { describe, expect, it } from "vitest";
import {
  type FirstRunCloudManagedConnection,
  type FirstRunLocalProviderConnection,
  type FirstRunRemoteProviderConnection,
  getFirstRunProviderFamily,
  getFirstRunProviderOption,
  isCloudManagedConnection,
  isLocalProviderConnection,
  isRemoteProviderConnection,
  isSubscriptionProviderSelectionId,
  normalizeFirstRunProviderId,
  normalizeSubscriptionProviderSelectionId,
  type ProviderOption,
  sortFirstRunProviders,
  stripFirstRunConnectionSecrets,
} from "./first-run-options.js";

describe("first-run options and provider normalizers", () => {
  it("validates subscription provider selection IDs", () => {
    expect(isSubscriptionProviderSelectionId("anthropic-subscription")).toBe(
      true,
    );
    expect(isSubscriptionProviderSelectionId("openai-subscription")).toBe(true);
    expect(isSubscriptionProviderSelectionId("gemini-subscription")).toBe(true);
    expect(isSubscriptionProviderSelectionId("unknown-provider-xyz")).toBe(
      false,
    );
    expect(isSubscriptionProviderSelectionId("")).toBe(false);
  });

  it("normalizes subscription provider selection IDs", () => {
    expect(
      normalizeSubscriptionProviderSelectionId("anthropic-subscription"),
    ).toBe("anthropic-subscription");
    expect(
      normalizeSubscriptionProviderSelectionId("OPENAI-SUBSCRIPTION"),
    ).toBe("openai-subscription");
    expect(
      normalizeSubscriptionProviderSelectionId("non-existent-provider"),
    ).toBeNull();
  });

  it("normalizes first-run provider IDs and handles casing, aliases, and whitespace", () => {
    expect(normalizeFirstRunProviderId("anthropic")).toBe("anthropic");
    expect(normalizeFirstRunProviderId(" OpenAI ")).toBe("openai");
    expect(normalizeFirstRunProviderId("google")).toBe("gemini");
    expect(normalizeFirstRunProviderId("ollama")).toBe("ollama");
  });

  it("retrieves provider options and families by provider ID", () => {
    const anthropicOption = getFirstRunProviderOption("anthropic");
    expect(anthropicOption).toBeDefined();
    expect(anthropicOption?.id).toBe("anthropic");

    expect(getFirstRunProviderFamily("anthropic")).toBe("anthropic");
    expect(getFirstRunProviderFamily("ollama")).toBe("ollama");
    expect(getFirstRunProviderFamily("elizacloud")).toBe("elizacloud");
  });

  it("identifies cloud, remote, and local connection types", () => {
    const cloudConn: FirstRunCloudManagedConnection = {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
    };
    const remoteConn: FirstRunRemoteProviderConnection = {
      kind: "remote-provider",
      provider: "anthropic",
      apiKey: "sk-ant-test",
      remoteApiBase: "https://api.anthropic.com",
    };
    const localConn: FirstRunLocalProviderConnection = {
      kind: "local-provider",
      provider: "ollama",
    };

    expect(isCloudManagedConnection(cloudConn)).toBe(true);
    expect(isCloudManagedConnection(remoteConn)).toBe(false);

    expect(isRemoteProviderConnection(remoteConn)).toBe(true);
    expect(isRemoteProviderConnection(localConn)).toBe(false);

    expect(isLocalProviderConnection(localConn)).toBe(true);
    expect(isLocalProviderConnection(remoteConn)).toBe(false);
  });

  it("sorts provider options in deterministic catalog order (recommended first, then order)", () => {
    const providers: Partial<ProviderOption>[] = [
      { id: "ollama", order: 140, recommended: false },
      { id: "anthropic", order: 50, recommended: false },
      { id: "elizacloud", order: 10, recommended: true },
    ];

    const sorted = sortFirstRunProviders(providers as ProviderOption[]);
    expect(sorted.map((p) => p.id)).toEqual([
      "elizacloud",
      "anthropic",
      "ollama",
    ]);
  });

  it("strips connection secrets safely from connection records", () => {
    const connection: FirstRunRemoteProviderConnection = {
      kind: "remote-provider",
      provider: "anthropic",
      apiKey: "sk-ant-secret-12345",
      primaryModel: "claude-3-5-sonnet-20241022",
      remoteApiBase: "https://api.anthropic.com",
    };

    const stripped = stripFirstRunConnectionSecrets(connection);
    expect(stripped.kind).toBe("remote-provider");
    if (stripped.kind === "remote-provider") {
      expect(stripped.provider).toBe("anthropic");
      expect(stripped.primaryModel).toBe("claude-3-5-sonnet-20241022");
      expect(stripped.remoteApiBase).toBe("https://api.anthropic.com");
    }
    expect("apiKey" in stripped).toBe(false);
  });
});
