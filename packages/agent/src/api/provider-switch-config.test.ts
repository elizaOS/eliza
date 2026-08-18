/**
 * Coverage for the first-run / provider-switch config mutators in
 * provider-switch-config: subscription-provider selection, the full first-run
 * reset (config + process.env + stored provider credentials), the third-party
 * `OPENAI_BASE_URL` guard, and Cerebras / NEAR AI local-provider wiring.
 * Deterministic: it drives the pure config mutators and asserts against
 * process.env and the in-memory config object; no live provider is contacted.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createIsolatedAccountStoragePolicy,
  loadAccount,
  saveAccount,
} from "@elizaos/auth/account-storage";
import {
  DIRECT_ACCOUNT_PROVIDER_ENV,
  DIRECT_ACCOUNT_PROVIDER_IDS,
} from "@elizaos/auth/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/types.eliza";
import {
  applyFirstRunConnectionConfig,
  applySubscriptionProviderConfig,
  clearPersistedFirstRunConfig,
  clearSubscriptionProviderConfig,
  openAiBaseUrlIsThirdParty,
} from "./provider-switch-config";

const ENV_KEYS_TO_RESTORE = ["ELIZA_HOME", "ELIZA_STATE_DIR"] as const;
const originalEnv = new Map<string, string | undefined>();
let isolatedElizaHome: string | undefined;

function storagePolicy() {
  if (!isolatedElizaHome)
    throw new Error("isolated state root is not initialized");
  return createIsolatedAccountStoragePolicy(isolatedElizaHome);
}

beforeEach(() => {
  for (const key of ENV_KEYS_TO_RESTORE) {
    originalEnv.set(key, process.env[key]);
  }
  isolatedElizaHome = mkdtempSync(
    path.join(tmpdir(), "eliza-provider-switch-"),
  );
  process.env.ELIZA_HOME = isolatedElizaHome;
  process.env.ELIZA_STATE_DIR = isolatedElizaHome;
});

afterEach(() => {
  for (const key of ENV_KEYS_TO_RESTORE) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
  if (isolatedElizaHome) {
    rmSync(isolatedElizaHome, { recursive: true, force: true });
    isolatedElizaHome = undefined;
  }
});

describe("applySubscriptionProviderConfig", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("configures Codex subscriptions for the Codex CLI model provider", async () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("openai-codex");
    expect(config.agents?.defaults?.model?.primary).toBe("codex-cli");
  });

  it("keeps Gemini CLI subscriptions out of runtime model routing", async () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "gemini-subscription");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("gemini-cli");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
  });

  it("keeps coding-plan endpoint subscriptions out of direct API routing", async () => {
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "zai-coding-subscription");

    expect(config.agents?.defaults?.subscriptionProvider).toBe("zai-coding");
    expect(config.agents?.defaults?.model?.primary).toBeUndefined();
  });

  it("clears subscription provider settings without touching direct API env", async () => {
    process.env.OPENAI_API_KEY = "sk-direct-openai-key";
    const config: Partial<ElizaConfig> = {};

    applySubscriptionProviderConfig(config, "openai-codex");
    clearSubscriptionProviderConfig(config);

    expect(config.agents?.defaults?.subscriptionProvider).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBe("sk-direct-openai-key");
  });
});

describe("clearPersistedFirstRunConfig (reset everything)", () => {
  const CLOUD_ENV_KEYS = [
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
    "ELIZAOS_CLOUD_NANO_MODEL",
    "ELIZAOS_CLOUD_MEDIUM_MODEL",
    "ELIZAOS_CLOUD_SMALL_MODEL",
    "ELIZAOS_CLOUD_LARGE_MODEL",
    "ELIZAOS_CLOUD_MEGA_MODEL",
  ] as const;

  const MODEL_ENV_KEYS = [
    "ANTHROPIC_LARGE_MODEL",
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
    "CEREBRAS_MODEL",
    "GROQ_LARGE_MODEL",
    "NEARAI_SMALL_MODEL",
    "NEARAI_LARGE_MODEL",
  ] as const;

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    for (const key of [...CLOUD_ENV_KEYS, ...MODEL_ENV_KEYS]) {
      delete process.env[key];
    }
  });

  function buildFullyOnboardedConfig(): Partial<ElizaConfig> {
    return {
      meta: { firstRunComplete: true },
      agents: { list: [{ id: "agent-1", name: "Eliza" }] },
      cloud: { apiKey: "cloud-secret", enabled: true },
      models: { nano: "n", small: "s", medium: "m", large: "l", mega: "x" },
      messages: { tts: { provider: "elevenlabs" } },
      ui: { selectedVrmIndex: 3 },
      connection: { provider: "openai", apiKey: "sk-live" },
      deploymentTarget: { runtime: "cloud" },
      linkedAccounts: { elizacloud: { status: "linked" } },
      serviceRouting: { llmText: { transport: "cloud-proxy", backend: "x" } },
      env: { vars: { OPENAI_API_KEY: "sk-config" } },
    } as unknown as Partial<ElizaConfig>;
  }

  it("wipes every onboarding-derived slot back to a fresh-install shape", async () => {
    process.env.OPENAI_API_KEY = "sk-config";
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-secret";
    process.env.ELIZAOS_CLOUD_ENABLED = "true";

    const config = buildFullyOnboardedConfig();
    clearPersistedFirstRunConfig(config, storagePolicy());

    expect((config.meta as Record<string, unknown>)?.firstRunComplete).toBe(
      undefined,
    );
    expect(config.agents).toEqual({ list: [] });
    expect(config.cloud).toEqual({});
    expect(config.models).toBeUndefined();
    expect(config.messages).toBeUndefined();
    expect(config.ui).toBeUndefined();
    expect((config as Record<string, unknown>).connection).toBeUndefined();
    expect(config.deploymentTarget).toBeUndefined();
    expect(config.linkedAccounts).toBeUndefined();
    expect(config.serviceRouting).toBeUndefined();
  });

  it("clears provider credentials from both config.env and process.env", async () => {
    process.env.OPENAI_API_KEY = "sk-config";

    const config = buildFullyOnboardedConfig();
    clearPersistedFirstRunConfig(config, storagePolicy());

    expect(config.env).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("deletes subscription and direct account files as one reset transaction", () => {
    const policy = storagePolicy();
    const now = Date.now();
    for (const providerId of ["openai-codex", "cerebras-api"] as const) {
      saveAccount(
        {
          id: `${providerId}-account`,
          providerId,
          label: providerId,
          source: providerId === "openai-codex" ? "oauth" : "api-key",
          credentials: {
            access: "secret",
            refresh: "",
            expires: now + 60_000,
          },
          createdAt: now,
          updatedAt: now,
        },
        policy,
      );
    }

    clearPersistedFirstRunConfig(buildFullyOnboardedConfig(), policy);

    expect(() =>
      loadAccount("openai-codex", "openai-codex-account", policy),
    ).toThrow(
      expect.objectContaining({
        code: "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
      }),
    );
    const currentPolicy = storagePolicy();
    expect(
      loadAccount("openai-codex", "openai-codex-account", currentPolicy),
    ).toBeNull();
    expect(
      loadAccount("cerebras-api", "cerebras-api-account", currentPolicy),
    ).toBeNull();
  });

  it("removes every credential artifact while preserving audit and JWKS state", () => {
    if (!isolatedElizaHome)
      throw new Error("isolated state root is not initialized");
    const authRoot = path.join(isolatedElizaHome, "auth");
    const artifacts = [
      path.join(authRoot, "retired-provider", "retired.json"),
      path.join(authRoot, "_codex-home", "account-a", "auth.json"),
      path.join(authRoot, "_pool-metadata.json"),
      path.join(authRoot, "_pool-metadata.json.interrupted.tmp"),
    ];
    for (const artifact of artifacts) {
      mkdirSync(path.dirname(artifact), { recursive: true });
      writeFileSync(artifact, "credential-material", { mode: 0o600 });
    }
    const preserved = [
      path.join(authRoot, "audit.log"),
      path.join(authRoot, "cloud-jwks.json"),
    ];
    for (const artifact of preserved) {
      writeFileSync(artifact, "non-credential-state", { mode: 0o600 });
    }

    clearPersistedFirstRunConfig(buildFullyOnboardedConfig(), storagePolicy());

    for (const artifact of artifacts) expect(existsSync(artifact)).toBe(false);
    for (const artifact of preserved) expect(existsSync(artifact)).toBe(true);
  });

  it("clears provider-specific default model env vars (no stale model leaks)", () => {
    for (const key of MODEL_ENV_KEYS) process.env[key] = "stale-model";

    clearPersistedFirstRunConfig(buildFullyOnboardedConfig(), storagePolicy());

    for (const key of MODEL_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("strips Eliza Cloud env keys so a fresh boot does not re-link cloud", async () => {
    for (const key of CLOUD_ENV_KEYS) {
      process.env[key] = "stale";
    }

    clearPersistedFirstRunConfig(buildFullyOnboardedConfig(), storagePolicy());

    for (const key of CLOUD_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("is a no-op-safe on an already-empty config", async () => {
    const config: Partial<ElizaConfig> = {};
    expect(() =>
      clearPersistedFirstRunConfig(config, storagePolicy()),
    ).not.toThrow();
    expect(config.agents).toEqual({ list: [] });
  });

  it("leaves config and environment untouched when credential preflight is denied", () => {
    if (!isolatedElizaHome)
      throw new Error("isolated state root is not initialized");
    const outside = mkdtempSync(path.join(tmpdir(), "eliza-reset-outside-"));
    const authRoot = path.join(isolatedElizaHome, "auth");
    mkdirSync(authRoot, { recursive: true });
    symlinkSync(
      outside,
      path.join(authRoot, "openai-codex"),
      process.platform === "win32" ? "junction" : "dir",
    );
    process.env.OPENAI_API_KEY = "must-survive";
    const config = buildFullyOnboardedConfig();
    const before = structuredClone(config);

    try {
      expect(() =>
        clearPersistedFirstRunConfig(config, storagePolicy()),
      ).toThrow(
        expect.objectContaining({ code: "AUTH_CREDENTIAL_PATH_ESCAPE" }),
      );
      expect(config).toEqual(before);
      expect(process.env.OPENAI_API_KEY).toBe("must-survive");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("openAiBaseUrlIsThirdParty", () => {
  // Tests are sequential so they can mutate `process.env.OPENAI_BASE_URL`
  // without cross-test contamination — vitest serializes tests within a
  // single `describe` block.
  const originalBaseUrl = process.env.OPENAI_BASE_URL;

  beforeEach(() => {
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    if (typeof originalBaseUrl === "string") {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("returns false when OPENAI_BASE_URL is unset", async () => {
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false when OPENAI_BASE_URL is whitespace-only", async () => {
    process.env.OPENAI_BASE_URL = "   ";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false when OPENAI_BASE_URL points at api.openai.com (canonical)", async () => {
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns false for api.openai.com with a trailing path / query", async () => {
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1/?tracing=1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });

  it("returns true for the Cerebras host (the case that motivated this guard)", async () => {
    process.env.OPENAI_BASE_URL = "https://api.cerebras.ai/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for Groq", async () => {
    process.env.OPENAI_BASE_URL = "https://api.groq.com/openai/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for OpenRouter", async () => {
    process.env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for Together AI", async () => {
    process.env.OPENAI_BASE_URL = "https://api.together.xyz/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for localhost (vLLM / LM Studio / Ollama gateway)", async () => {
    process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for an arbitrary in-house gateway", async () => {
    process.env.OPENAI_BASE_URL = "https://gateway.acme.internal/openai";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("treats unparseable URLs as third-party (fail-safe)", async () => {
    process.env.OPENAI_BASE_URL = "not://a real:url";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("returns true for openai.com subdomains other than api.openai.com", async () => {
    // Regression guard: this protects against someone pointing at
    // `platform.openai.com` or `dashboard.openai.com` by mistake.
    process.env.OPENAI_BASE_URL = "https://platform.openai.com/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(true);
  });

  it("is case-insensitive on the hostname", async () => {
    process.env.OPENAI_BASE_URL = "https://API.OpenAI.COM/v1";
    expect(openAiBaseUrlIsThirdParty()).toBe(false);
  });
});

describe("Cerebras direct-account wiring", () => {
  it("maps the cerebras-api account to CEREBRAS_API_KEY", async () => {
    expect(DIRECT_ACCOUNT_PROVIDER_IDS).toContain("cerebras-api");
    expect(DIRECT_ACCOUNT_PROVIDER_ENV["cerebras-api"]).toBe(
      "CEREBRAS_API_KEY",
    );
  });
});

describe("applyFirstRunConnectionConfig (Cerebras local provider)", () => {
  const CEREBRAS_ENV = [
    "CEREBRAS_API_KEY",
    "CEREBRAS_MODEL",
    "CEREBRAS_SMALL_MODEL",
    "CEREBRAS_LARGE_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
  ] as const;

  beforeEach(() => {
    for (const key of CEREBRAS_ENV) delete process.env[key];
  });
  afterEach(() => {
    for (const key of CEREBRAS_ENV) delete process.env[key];
  });

  it("sets CEREBRAS_API_KEY + the default Gemma CEREBRAS_MODEL and never strays into OpenAI vars", async () => {
    const config: Partial<ElizaConfig> = {};

    await applyFirstRunConnectionConfig(config, {
      kind: "local-provider",
      provider: "cerebras",
      apiKey: "csk-test-123",
    });

    const vars = (config.env as { vars?: Record<string, string> } | undefined)
      ?.vars;
    expect(vars?.CEREBRAS_API_KEY).toBe("csk-test-123");
    // Without a valid Cerebras model the OpenAI plugin would fall back to
    // gpt-5* ids that 404 on api.cerebras.ai — this is the load-bearing default.
    expect(vars?.CEREBRAS_MODEL).toBe("gemma-4-31b");
    expect(vars?.CEREBRAS_SMALL_MODEL).toBe("gemma-4-31b");
    expect(vars?.CEREBRAS_LARGE_MODEL).toBe("gemma-4-31b");
    // Setting any OPENAI_* var here would knock the plugin out of Cerebras
    // mode (isCerebrasMode requires no OPENAI_API_KEY / OPENAI_BASE_URL).
    expect(vars?.OPENAI_API_KEY).toBeUndefined();
    expect(vars?.OPENAI_BASE_URL).toBeUndefined();
    expect(vars?.OPENAI_SMALL_MODEL).toBeUndefined();
    expect(vars?.OPENAI_LARGE_MODEL).toBeUndefined();
    // Same values land in process.env so a hot-reloaded runtime picks them up.
    expect(process.env.CEREBRAS_API_KEY).toBe("csk-test-123");
    expect(process.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
    // The agent routes its text inference at Cerebras.
    expect(config.serviceRouting?.llmText?.backend).toBe("cerebras");
    expect(config.serviceRouting?.llmText?.transport).toBe("direct");
  });

  it("preserves a legacy model override across both new tiers", async () => {
    process.env.CEREBRAS_MODEL = "qwen-legacy-override";
    const config: Partial<ElizaConfig> = {};

    await applyFirstRunConnectionConfig(config, {
      kind: "local-provider",
      provider: "cerebras",
      apiKey: "csk-test-legacy",
    });

    const vars = (config.env as { vars?: Record<string, string> } | undefined)
      ?.vars;
    expect(vars?.CEREBRAS_SMALL_MODEL).toBe("qwen-legacy-override");
    expect(vars?.CEREBRAS_LARGE_MODEL).toBe("qwen-legacy-override");
    expect(process.env.CEREBRAS_MODEL).toBe("qwen-legacy-override");
  });

  it("clears persisted Cerebras credentials and all model tiers on a full reset", async () => {
    process.env.CEREBRAS_API_KEY = "csk-stale";
    process.env.CEREBRAS_MODEL = "legacy-stale";
    process.env.CEREBRAS_SMALL_MODEL = "small-stale";
    process.env.CEREBRAS_LARGE_MODEL = "large-stale";
    const config: Partial<ElizaConfig> = {
      env: {
        vars: {
          CEREBRAS_API_KEY: "csk-stale",
          CEREBRAS_MODEL: "legacy-stale",
          CEREBRAS_SMALL_MODEL: "small-stale",
          CEREBRAS_LARGE_MODEL: "large-stale",
        },
      },
    } as Partial<ElizaConfig>;

    clearPersistedFirstRunConfig(config, storagePolicy());

    expect(process.env.CEREBRAS_API_KEY).toBeUndefined();
    expect(process.env.CEREBRAS_MODEL).toBeUndefined();
    expect(process.env.CEREBRAS_SMALL_MODEL).toBeUndefined();
    expect(process.env.CEREBRAS_LARGE_MODEL).toBeUndefined();
    const vars = (config.env as { vars?: Record<string, string> } | undefined)
      ?.vars;
    expect(vars?.CEREBRAS_API_KEY).toBeUndefined();
    expect(vars?.CEREBRAS_MODEL).toBeUndefined();
    expect(vars?.CEREBRAS_SMALL_MODEL).toBeUndefined();
    expect(vars?.CEREBRAS_LARGE_MODEL).toBeUndefined();
  });
});

describe("applyFirstRunConnectionConfig (NEAR AI local provider)", () => {
  const NEARAI_ENV = [
    "NEARAI_API_KEY",
    "NEARAI_SMALL_MODEL",
    "NEARAI_LARGE_MODEL",
  ] as const;

  beforeEach(() => {
    for (const key of NEARAI_ENV) delete process.env[key];
  });
  afterEach(() => {
    for (const key of NEARAI_ENV) delete process.env[key];
  });

  it("sets NEAR AI Gemma defaults for both text tiers", async () => {
    const config: Partial<ElizaConfig> = {};

    await applyFirstRunConnectionConfig(config, {
      kind: "local-provider",
      provider: "nearai",
      apiKey: "near-test-123",
    });

    const vars = (config.env as { vars?: Record<string, string> } | undefined)
      ?.vars;
    expect(vars?.NEARAI_API_KEY).toBe("near-test-123");
    expect(vars?.NEARAI_SMALL_MODEL).toBe("google/gemma-4-31B-it");
    expect(vars?.NEARAI_LARGE_MODEL).toBe("google/gemma-4-31B-it");
    expect(process.env.NEARAI_SMALL_MODEL).toBe("google/gemma-4-31B-it");
    expect(process.env.NEARAI_LARGE_MODEL).toBe("google/gemma-4-31B-it");
    expect(config.serviceRouting?.llmText?.backend).toBe("nearai");
    expect(config.serviceRouting?.llmText?.transport).toBe("direct");
  });
});
