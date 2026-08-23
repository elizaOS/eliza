/**
 * Behavioral coverage for the first-run connection surface of
 * `first-run-options.ts` that the sibling suites do not exercise: the
 * subscription-selection accessors (`getStoredSubscriptionProvider`,
 * `getSubscriptionProviderFamily`, `requiresAdditionalRuntimeProvider`),
 * stored-id mapping, connection-completeness gates, env/secret readers,
 * persisted-connection normalization, credential persistence planning,
 * compatibility inference, cloud-inference detection, and the runtime
 * provider-option registry. Deterministic in-process tests driving the real
 * exported functions — no mocks, no network, no type-level assertions.
 */
import { describe, expect, it } from "vitest";
import {
  deriveFirstRunCredentialPersistencePlan,
  getProviderOptions,
  getStoredFirstRunProviderId,
  getStoredSubscriptionProvider,
  getSubscriptionProviderFamily,
  hasExplicitCanonicalRuntimeConfig,
  inferCompatibilityFirstRunConnection,
  inferFirstRunConnectionFromConfig,
  isCloudInferenceSelectedInConfig,
  isFirstRunConnectionComplete,
  normalizeFirstRunCredentialInputs,
  normalizePersistedFirstRunConnection,
  readFirstRunEnvSecret,
  readFirstRunEnvString,
  registerProviderOption,
  requiresAdditionalRuntimeProvider,
  resolveDeploymentTargetInConfig,
  resolveLinkedAccountsInConfig,
} from "./first-run-options";

describe("subscription selection accessors", () => {
  it("maps every selection id to its stored subscription provider", () => {
    expect(getStoredSubscriptionProvider("anthropic-subscription")).toBe(
      "anthropic-subscription",
    );
    expect(getStoredSubscriptionProvider("openai-subscription")).toBe(
      "openai-codex",
    );
    expect(getStoredSubscriptionProvider("gemini-subscription")).toBe(
      "gemini-cli",
    );
    expect(getStoredSubscriptionProvider("zai-coding-subscription")).toBe(
      "zai-coding",
    );
    expect(getStoredSubscriptionProvider("kimi-coding-subscription")).toBe(
      "kimi-coding",
    );
    expect(getStoredSubscriptionProvider("deepseek-coding-subscription")).toBe(
      "deepseek-coding",
    );
  });

  it("returns the owning family for each subscription selection", () => {
    expect(getSubscriptionProviderFamily("anthropic-subscription")).toBe(
      "anthropic",
    );
    expect(getSubscriptionProviderFamily("openai-subscription")).toBe("openai");
    expect(getSubscriptionProviderFamily("gemini-subscription")).toBe("gemini");
    expect(getSubscriptionProviderFamily("zai-coding-subscription")).toBe(
      "zai",
    );
    expect(getSubscriptionProviderFamily("kimi-coding-subscription")).toBe(
      "moonshot",
    );
    expect(getSubscriptionProviderFamily("deepseek-coding-subscription")).toBe(
      "deepseek",
    );
  });

  it("flags every coding-plan selection except OpenAI as needing an extra runtime provider", () => {
    expect(requiresAdditionalRuntimeProvider("openai-subscription")).toBe(
      false,
    );
    expect(requiresAdditionalRuntimeProvider("anthropic-subscription")).toBe(
      true,
    );
    expect(requiresAdditionalRuntimeProvider("KIMI-CODING-SUBSCRIPTION")).toBe(
      true,
    );
    expect(requiresAdditionalRuntimeProvider("anthropic")).toBe(false);
    expect(requiresAdditionalRuntimeProvider(null)).toBe(false);
  });
});

describe("stored first-run provider id mapping", () => {
  it("prefers the stored provider id over the catalog id", () => {
    expect(getStoredFirstRunProviderId("zai-coding-subscription")).toBe(
      "zai-coding",
    );
    expect(getStoredFirstRunProviderId("openai-subscription")).toBe(
      "openai-codex",
    );
  });

  it("falls back to the catalog id when no stored provider is configured", () => {
    expect(getStoredFirstRunProviderId("anthropic")).toBe("anthropic");
    expect(getStoredFirstRunProviderId("ollama")).toBe("ollama");
  });

  it("returns null for unknown or non-string inputs", () => {
    expect(getStoredFirstRunProviderId("definitely-not-a-provider")).toBeNull();
    expect(getStoredFirstRunProviderId(42)).toBeNull();
  });
});

describe("isFirstRunConnectionComplete", () => {
  it("treats any local-provider connection as complete", () => {
    expect(
      isFirstRunConnectionComplete({
        kind: "local-provider",
        provider: "ollama",
      }),
    ).toBe(true);
    expect(
      isFirstRunConnectionComplete({
        kind: "local-provider",
        provider: "anthropic",
        apiKey: "sk-ant-x",
      }),
    ).toBe(true);
  });

  it("requires a non-blank remote API base for remote connections", () => {
    expect(
      isFirstRunConnectionComplete({
        kind: "remote-provider",
        remoteApiBase: "https://relay.example.com",
      }),
    ).toBe(true);
    expect(
      isFirstRunConnectionComplete({
        kind: "remote-provider",
        remoteApiBase: "   ",
      }),
    ).toBe(false);
  });

  it("requires both small and large model selections for cloud-managed connections", () => {
    expect(
      isFirstRunConnectionComplete({
        kind: "cloud-managed",
        cloudProvider: "elizacloud",
        smallModel: "small-1",
        largeModel: "large-1",
      }),
    ).toBe(true);
    expect(
      isFirstRunConnectionComplete({
        kind: "cloud-managed",
        cloudProvider: "elizacloud",
        smallModel: "small-1",
      }),
    ).toBe(false);
    expect(
      isFirstRunConnectionComplete({
        kind: "cloud-managed",
        cloudProvider: "elizacloud",
        smallModel: " ",
        largeModel: "large-1",
      }),
    ).toBe(false);
  });

  it("rejects absent connections", () => {
    expect(isFirstRunConnectionComplete(null)).toBe(false);
    expect(isFirstRunConnectionComplete(undefined)).toBe(false);
  });
});

describe("first-run env readers", () => {
  it("reads strings with vars taking precedence over env", () => {
    const config = {
      env: {
        vars: { SHARED_KEY: "from-vars", BLANK_VARS: "   " },
        SHARED_KEY: "from-env",
        ENV_ONLY: "env-value",
        BLANK_ENV: "  ",
      },
    };
    expect(readFirstRunEnvString(config, "SHARED_KEY")).toBe("from-vars");
    expect(readFirstRunEnvString(config, "ENV_ONLY")).toBe("env-value");
    expect(readFirstRunEnvString(config, "BLANK_VARS")).toBeUndefined();
    expect(readFirstRunEnvString(config, "BLANK_ENV")).toBeUndefined();
    expect(readFirstRunEnvString(config, "MISSING_KEY")).toBeUndefined();
  });

  it("tolerates a missing env container", () => {
    expect(readFirstRunEnvString({}, "ANY_KEY")).toBeUndefined();
    expect(readFirstRunEnvString(null, "ANY_KEY")).toBeUndefined();
  });

  it("redacts placeholder secrets and trims real ones", () => {
    const config = {
      env: {
        REAL_KEY: "  sk-live-123  ",
        REDACTED_UPPER: "[REDACTED]",
        REDACTED_MIXED: "  [Redacted]  ",
        NUMERIC_KEY: 42,
      },
    };
    expect(readFirstRunEnvSecret(config, "REAL_KEY")).toBe("sk-live-123");
    expect(readFirstRunEnvSecret(config, "REDACTED_UPPER")).toBeUndefined();
    expect(readFirstRunEnvSecret(config, "REDACTED_MIXED")).toBeUndefined();
    expect(readFirstRunEnvSecret(config, "NUMERIC_KEY")).toBeUndefined();
    expect(readFirstRunEnvSecret(config, "MISSING_KEY")).toBeUndefined();
  });
});

describe("hasExplicitCanonicalRuntimeConfig", () => {
  it("detects each canonical routing key", () => {
    expect(hasExplicitCanonicalRuntimeConfig({})).toBe(false);
    expect(hasExplicitCanonicalRuntimeConfig({ cloud: {} })).toBe(false);
    expect(
      hasExplicitCanonicalRuntimeConfig({
        deploymentTarget: { runtime: "local" },
      }),
    ).toBe(true);
    expect(hasExplicitCanonicalRuntimeConfig({ linkedAccounts: {} })).toBe(
      true,
    );
    expect(hasExplicitCanonicalRuntimeConfig({ serviceRouting: {} })).toBe(
      true,
    );
  });
});

describe("resolveLinkedAccountsInConfig", () => {
  it("returns null when there is nothing to link", () => {
    expect(resolveLinkedAccountsInConfig({})).toBeNull();
    expect(resolveLinkedAccountsInConfig(null)).toBeNull();
  });

  it("marks elizacloud linked from a cloud api key", () => {
    expect(
      resolveLinkedAccountsInConfig({ cloud: { apiKey: "sk-cloud-1" } }),
    ).toEqual({ elizacloud: { status: "linked", source: "api-key" } });
  });

  it("preserves an existing elizacloud status instead of overwriting it", () => {
    expect(
      resolveLinkedAccountsInConfig({
        linkedAccounts: { elizacloud: { status: "linked", source: "oauth" } },
        cloud: { apiKey: "sk-cloud-2" },
      }),
    ).toEqual({ elizacloud: { status: "linked", source: "oauth" } });
  });
});

describe("resolveDeploymentTargetInConfig", () => {
  it("passes an explicit deployment target through", () => {
    expect(
      resolveDeploymentTargetInConfig({
        deploymentTarget: {
          runtime: "remote",
          provider: "remote",
          remoteApiBase: "https://hub.example.com",
        },
      }),
    ).toEqual({
      runtime: "remote",
      provider: "remote",
      remoteApiBase: "https://hub.example.com",
    });
  });

  it("defaults to a local runtime without explicit configuration", () => {
    expect(resolveDeploymentTargetInConfig({})).toEqual({ runtime: "local" });
    expect(resolveDeploymentTargetInConfig(null)).toEqual({ runtime: "local" });
  });
});

describe("normalizePersistedFirstRunConnection", () => {
  it("normalizes a local-provider connection and drops placeholder secrets", () => {
    expect(
      normalizePersistedFirstRunConnection({
        kind: "local-provider",
        provider: "@elizaos/plugin-anthropic",
        apiKey: "  sk-ant-real  ",
        primaryModel: "  claude-sonnet  ",
      }),
    ).toEqual({
      kind: "local-provider",
      provider: "anthropic",
      apiKey: "sk-ant-real",
      primaryModel: "claude-sonnet",
    });
  });

  it("rejects local-provider connections that are not resolvable providers", () => {
    expect(
      normalizePersistedFirstRunConnection({
        kind: "local-provider",
        provider: "elizacloud",
      }),
    ).toBeNull();
    expect(
      normalizePersistedFirstRunConnection({
        kind: "local-provider",
        provider: "not-a-real-provider",
      }),
    ).toBeNull();
  });

  it("requires a remote api base for remote-provider connections", () => {
    expect(
      normalizePersistedFirstRunConnection({
        kind: "remote-provider",
        remoteApiBase: "   ",
      }),
    ).toBeNull();
  });

  it("normalizes remote connections, dropping redacted tokens and elizacloud providers", () => {
    expect(
      normalizePersistedFirstRunConnection({
        kind: "remote-provider",
        remoteApiBase: "https://hub.example.com",
        remoteAccessToken: "[REDACTED]",
        provider: "elizacloud",
        apiKey: "sk-x",
        primaryModel: "m-1",
      }),
    ).toEqual({
      kind: "remote-provider",
      remoteApiBase: "https://hub.example.com",
      remoteAccessToken: undefined,
      provider: undefined,
      apiKey: "sk-x",
      primaryModel: "m-1",
    });
  });

  it("normalizes cloud-managed connections keeping only non-empty model preferences", () => {
    expect(
      normalizePersistedFirstRunConnection({
        kind: "cloud-managed",
        apiKey: "[REDACTED]",
        nanoModel: "",
        smallModel: " small-model ",
        largeModel: "large-model",
      }),
    ).toEqual({
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      smallModel: "small-model",
      largeModel: "large-model",
    });
  });

  it("rejects non-object shapes and unknown kinds", () => {
    expect(normalizePersistedFirstRunConnection(null)).toBeNull();
    expect(normalizePersistedFirstRunConnection([1, 2])).toBeNull();
    expect(normalizePersistedFirstRunConnection("local-provider")).toBeNull();
    expect(
      normalizePersistedFirstRunConnection({ kind: "mystery" }),
    ).toBeNull();
  });
});

describe("normalizeFirstRunCredentialInputs", () => {
  it("keeps trimmed credentials when at least one is usable", () => {
    expect(
      normalizeFirstRunCredentialInputs({
        llmApiKey: "  sk-llm  ",
        cloudApiKey: " sk-cloud ",
      }),
    ).toEqual({ llmApiKey: "sk-llm", cloudApiKey: "sk-cloud" });
    expect(normalizeFirstRunCredentialInputs({ llmApiKey: "sk-only" })).toEqual(
      { llmApiKey: "sk-only" },
    );
  });

  it("returns null without any usable credential", () => {
    expect(normalizeFirstRunCredentialInputs({})).toBeNull();
    expect(normalizeFirstRunCredentialInputs({ llmApiKey: "   " })).toBeNull();
    expect(
      normalizeFirstRunCredentialInputs({ cloudApiKey: "[REDACTED]" }),
    ).toBeNull();
    expect(normalizeFirstRunCredentialInputs(7)).toBeNull();
  });
});

describe("deriveFirstRunCredentialPersistencePlan", () => {
  it("persists the cloud key onto an elizacloud cloud-proxy selection", () => {
    expect(
      deriveFirstRunCredentialPersistencePlan({
        credentialInputs: { cloudApiKey: "ck-1" },
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            smallModel: "s",
            largeModel: "l",
          },
        },
      }),
    ).toEqual({
      llmSelection: {
        backend: "elizacloud",
        transport: "cloud-proxy",
        apiKey: "ck-1",
        smallModel: "s",
        largeModel: "l",
      },
      cloudApiKey: "ck-1",
    });
  });

  it("persists a direct selection with the route backend and primary model", () => {
    expect(
      deriveFirstRunCredentialPersistencePlan({
        credentialInputs: { llmApiKey: "dk-1", cloudApiKey: "ck-2" },
        serviceRouting: {
          llmText: {
            backend: "deepseek",
            transport: "direct",
            primaryModel: "deepseek-chat",
          },
        },
      }),
    ).toEqual({
      llmSelection: {
        backend: "deepseek",
        transport: "direct",
        apiKey: "dk-1",
        primaryModel: "deepseek-chat",
      },
      cloudApiKey: "ck-2",
    });
  });

  it("persists a remote selection using the route's remote api base", () => {
    expect(
      deriveFirstRunCredentialPersistencePlan({
        credentialInputs: { llmApiKey: "rk-1" },
        serviceRouting: {
          llmText: {
            backend: "anthropic",
            transport: "remote",
            remoteApiBase: "https://hub.example.com",
          },
        },
      }),
    ).toEqual({
      llmSelection: {
        backend: "anthropic",
        transport: "remote",
        remoteApiBase: "https://hub.example.com",
        apiKey: "rk-1",
      },
    });
  });

  it("yields no selection when inputs or routes are absent", () => {
    expect(deriveFirstRunCredentialPersistencePlan({})).toEqual({
      llmSelection: null,
    });
    expect(
      deriveFirstRunCredentialPersistencePlan({
        credentialInputs: {},
        serviceRouting: {
          llmText: { backend: "deepseek", transport: "direct" },
        },
      }),
    ).toEqual({ llmSelection: null });
  });
});

describe("inferCompatibilityFirstRunConnection", () => {
  it("prefers a legacy remote base and decorates it with ambient signals", () => {
    expect(
      inferCompatibilityFirstRunConnection({
        cloud: {
          remoteApiBase: " https://legacy.example.com ",
          remoteAccessToken: "token-1",
        },
        env: { OPENAI_API_KEY: "sk-openai-1" },
        agents: { defaults: { model: { primary: "gpt-4o" } } },
      }),
    ).toEqual({
      kind: "remote-provider",
      remoteApiBase: "https://legacy.example.com",
      remoteAccessToken: "token-1",
      provider: "openai",
      apiKey: "sk-openai-1",
      primaryModel: "gpt-4o",
    });
  });

  it("infers a cloud-managed connection from opt-in plus model selections", () => {
    expect(
      inferCompatibilityFirstRunConnection({
        cloud: { enabled: true },
        models: { nano: "nano-1", small: "small-1", large: "large-1" },
      }),
    ).toEqual({
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      nanoModel: "nano-1",
      smallModel: "small-1",
      largeModel: "large-1",
    });
  });

  it("falls back to the first signaled local provider when cloud is opted out", () => {
    expect(
      inferCompatibilityFirstRunConnection({
        cloud: { enabled: false },
        models: { small: "small-1" },
        env: { GROQ_API_KEY: "gsk_test" },
      }),
    ).toEqual({
      kind: "local-provider",
      provider: "groq",
      apiKey: "gsk_test",
    });
  });

  it("returns null for an unconfigured environment", () => {
    expect(inferCompatibilityFirstRunConnection({})).toBeNull();
  });
});

describe("inferFirstRunConnectionFromConfig", () => {
  it("derives a local-provider connection from canonical direct routing", () => {
    expect(
      inferFirstRunConnectionFromConfig({
        serviceRouting: {
          llmText: {
            backend: "ollama",
            transport: "direct",
            primaryModel: "llama3",
          },
        },
      }),
    ).toEqual({
      kind: "local-provider",
      provider: "ollama",
      primaryModel: "llama3",
    });
  });

  it("derives a cloud-managed connection from canonical cloud-proxy routing", () => {
    expect(
      inferFirstRunConnectionFromConfig({
        serviceRouting: {
          llmText: {
            backend: "elizacloud",
            transport: "cloud-proxy",
            smallModel: "small-1",
            largeModel: "large-1",
          },
        },
      }),
    ).toEqual({
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      smallModel: "small-1",
      largeModel: "large-1",
    });
  });
});

describe("isCloudInferenceSelectedInConfig", () => {
  it("is true only for an elizacloud cloud-proxy text route", () => {
    expect(
      isCloudInferenceSelectedInConfig({
        serviceRouting: {
          llmText: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      }),
    ).toBe(true);
  });

  it("is false for direct routing, ambient keys, and empty configs", () => {
    expect(isCloudInferenceSelectedInConfig({})).toBe(false);
    expect(
      isCloudInferenceSelectedInConfig({ env: { ANTHROPIC_API_KEY: "sk-a" } }),
    ).toBe(false);
    expect(
      isCloudInferenceSelectedInConfig({
        serviceRouting: {
          llmText: { backend: "ollama", transport: "direct" },
        },
      }),
    ).toBe(false);
  });
});

describe("provider option registry", () => {
  it("merges runtime registrations over the hardcoded catalog by id", () => {
    const baseline = getProviderOptions();
    const baselineLength = baseline.length;
    const baselineAnthropic = baseline.find((o) => o.id === "anthropic");
    expect(baselineAnthropic?.name).toBe("Anthropic");

    registerProviderOption({
      id: "acme-test-provider",
      name: "Acme Test Provider",
      envKey: "ACME_TEST_KEY",
      pluginName: "@elizaos/plugin-acme-test",
      keyPrefix: "acme-",
      description: "Registered at test time.",
      family: "acme-test-provider",
      authMode: "api-key",
      group: "local",
      order: 900,
    });

    const merged = getProviderOptions();
    expect(merged.length).toBe(baselineLength + 1);
    expect(merged.find((o) => o.id === "acme-test-provider")?.name).toBe(
      "Acme Test Provider",
    );
    expect(merged.find((o) => o.id === "anthropic")?.name).toBe("Anthropic");
  });

  it("overrides a prior registration with the same id instead of appending", () => {
    const before = getProviderOptions().length;

    registerProviderOption({
      id: "acme-test-provider",
      name: "Acme Test Provider v2",
      envKey: null,
      pluginName: "@elizaos/plugin-acme-test",
      keyPrefix: null,
      description: "Overwritten registration.",
      family: "acme-test-provider",
      authMode: "local",
      group: "local",
      order: 901,
    });

    const merged = getProviderOptions();
    expect(merged.length).toBe(before);
    expect(merged.find((o) => o.id === "acme-test-provider")?.name).toBe(
      "Acme Test Provider v2",
    );
    expect(merged.find((o) => o.id === "acme-test-provider")?.order).toBe(901);
  });
});
