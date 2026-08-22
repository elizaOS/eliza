/**
 * Verifies buildOpencodeSpawnConfig.
 * Deterministic unit test with a stubbed runtime; no live model.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildOpencodeSpawnConfig,
  safeOpencodeEndpointForLog,
} from "../../src/services/opencode-config.js";

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

const GATEWAY_URL = "https://gateway.test.invalid/v1";
const GATEWAY_TOKEN = "gw-lease-token-abc123";

// buildOpencodeSpawnConfig reads gateway mode from host config
// (resolveModelGatewayConfig → config-env/process.env), not the env argument —
// save/clear the vars around every test so the auto-detect suite stays
// hermetic on a machine with gateway vars set, and the gateway suite below
// can opt in explicitly.
const MANAGED_ENV_KEYS = [
  "ELIZA_MODEL_GATEWAY_URL",
  "ELIZA_MODEL_GATEWAY_TOKEN",
  "ELIZA_CONFIG_PATH",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ELIZA_CONFIG_PATH =
    "/nonexistent/opencode-config-test/eliza.json";
});

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildOpencodeSpawnConfig", () => {
  it("returns null when no provider or opencode model is configured", () => {
    expect(buildOpencodeSpawnConfig(runtime(), {})).toBeNull();
  });

  it("detects CEREBRAS_API_KEY and uses the Cerebras provider defaults", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      CEREBRAS_API_KEY: "csk-test",
    });
    expect(result?.providerId).toBe("cerebras");
    expect(result?.providerLabel).toBe("Cerebras API");
    expect(result?.model).toBe("cerebras/gemma-4-31b");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider.cerebras.npm).toBe("@ai-sdk/cerebras");
    expect(config.provider.cerebras.options.apiKey).toBe("csk-test");
  });

  it.each([
    {
      selector: "deepseek-api",
      keyEnv: "DEEPSEEK_API_KEY",
      key: "deepseek-secret-never-log",
      provider: "deepseek",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      label: "DeepSeek API (PAYG)",
    },
    {
      selector: "zai-api",
      keyEnv: "ZAI_API_KEY",
      key: "zai-secret-never-log",
      provider: "zai",
      baseURL: "https://api.z.ai/api/paas/v4",
      model: "glm-5.1",
      label: "Z.AI API (PAYG)",
    },
    {
      selector: "moonshot-api",
      keyEnv: "MOONSHOT_API_KEY",
      key: "moonshot-secret-never-log",
      provider: "moonshot",
      baseURL: "https://api.moonshot.ai/v1",
      model: "kimi-k2.5",
      label: "Kimi / Moonshot API (PAYG)",
    },
    {
      selector: "xai-api",
      keyEnv: "XAI_API_KEY",
      key: "xai-secret-never-log",
      provider: "xai",
      baseURL: "https://api.x.ai/v1",
      model: "grok-build-0.1",
      label: "xAI API (PAYG)",
    },
  ])(
    "builds an atomic $selector direct API route",
    ({ selector, keyEnv, key, provider, baseURL, model, label }) => {
      const result = buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER_ID: selector,
        [keyEnv]: key,
      });
      expect(result).toMatchObject({
        accountProviderId: selector,
        billingMode: "api-payg",
        termsPolicy: "direct-api",
        providerLabel: label,
        baseUrl: baseURL,
        model: `${provider}/${model}`,
      });
      const config = JSON.parse(result?.configContent ?? "{}");
      expect(config.provider[provider].options).toMatchObject({
        baseURL,
        apiKey: key,
      });
      expect(config.model).toBe(`${provider}/${model}`);
    },
  );

  it("supports arbitrary OpenRouter models while labeling credits/BYOK truthfully", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-secret-never-log",
      ELIZA_OPENCODE_MODEL_POWERFUL: "anthropic/claude-sonnet-4.5",
    });
    expect(result).toMatchObject({
      accountProviderId: "openrouter-api",
      billingMode: "api-credits-or-byok",
      termsPolicy: "credits-or-byok",
      providerLabel: "OpenRouter credits / BYOK",
      model: "openrouter/anthropic/claude-sonnet-4.5",
    });
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.openrouter.options.baseURL).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(config.provider.openrouter.options.headers).toEqual({
      "HTTP-Referer": "https://elizaos.ai",
      "X-OpenRouter-Title": "elizaOS coding agent",
    });
  });

  it("routes a Z.AI Coding Plan key through the dedicated subscription endpoint", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_PROVIDER_ID: "zai-coding",
      ZAI_API_KEY: "zai-coding-plan-secret-never-log",
    });
    expect(result).toMatchObject({
      accountProviderId: "zai-coding",
      billingMode: "subscription-coding-plan",
      termsPolicy: "coding-plan",
      providerLabel: "Z.AI Coding Plan",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      model: "zai-coding-plan/glm-5.1",
    });
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["zai-coding-plan"].options).toEqual({
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "zai-coding-plan-secret-never-log",
    });
  });

  it("does not infer Coding Plan billing from a bare legacy Z.AI key", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ZAI_API_KEY: "ambiguous-zai-key",
    });
    expect(result).toMatchObject({
      accountProviderId: "zai-api",
      billingMode: "api-payg",
      baseUrl: "https://api.z.ai/api/paas/v4",
    });
  });

  it("fails closed when OpenRouter has no explicit arbitrary model", () => {
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter-secret-never-log",
      }),
    ).toThrow(/requires an explicit OpenCode model/i);
  });

  it("fails closed when an explicit route has no matching credential", () => {
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "xai-api",
        OPENROUTER_API_KEY: "must-not-be-used-for-xai",
      }),
    ).toThrow(/requires XAI_API_KEY/i);
  });

  it("keeps a selected account tuple authoritative over stale runtime settings", () => {
    const result = buildOpencodeSpawnConfig(
      runtime({
        ELIZA_OPENCODE_PROVIDER: "xai-api",
        DEEPSEEK_API_KEY: "stale-runtime-deepseek-key",
        XAI_API_KEY: "stale-runtime-xai-key",
      }),
      {},
      undefined,
      {
        providerId: "deepseek-api",
        credentials: {
          DEEPSEEK_API_KEY: "selected-account-deepseek-key",
        },
      },
    );
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(result?.accountProviderId).toBe("deepseek-api");
    expect(config.provider.deepseek.options.apiKey).toBe(
      "selected-account-deepseek-key",
    );
    expect(result?.configContent).not.toContain("stale-runtime-deepseek-key");
    expect(result?.configContent).not.toContain("stale-runtime-xai-key");
  });

  it.each([
    ["without a Cloud key", undefined],
    ["with a Cloud key", "cloud-key-must-not-be-billed"],
  ] as const)(
    "keeps a selected DeepSeek account authoritative when ELIZA_LLM_PROVIDER=cloud %s",
    (_label, cloudKey) => {
      const configDir = mkdtempSync(
        path.join(tmpdir(), "opencode-cloud-authority-"),
      );
      const configPath = path.join(configDir, "eliza.json");
      writeFileSync(
        configPath,
        JSON.stringify(cloudKey ? { cloud: { apiKey: cloudKey } } : {}),
      );
      process.env.ELIZA_CONFIG_PATH = configPath;
      try {
        const result = buildOpencodeSpawnConfig(
          runtime({ ELIZA_LLM_PROVIDER: "cloud" }),
          {},
          undefined,
          {
            providerId: "deepseek-api",
            credentials: {
              DEEPSEEK_API_KEY: "selected-deepseek-key",
            },
          },
        );
        const config = JSON.parse(result?.configContent ?? "{}");
        expect(result).toMatchObject({
          accountProviderId: "deepseek-api",
          providerId: "deepseek",
          billingMode: "api-payg",
        });
        expect(config.provider.deepseek.options.apiKey).toBe(
          "selected-deepseek-key",
        );
        expect(result?.configContent).not.toContain(
          "cloud-key-must-not-be-billed",
        );
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  it("does not guess among multiple non-Cerebras billing sources", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      DEEPSEEK_API_KEY: "deepseek-secret",
      XAI_API_KEY: "xai-secret",
    });
    expect(result).toBeNull();
  });

  it("honors provider-specific endpoint overrides without changing billing identity", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_PROVIDER: "z.ai",
      ZAI_API_KEY: "zai-secret",
      Z_AI_BASE_URL: "https://zai-proxy.test.invalid/v4",
    });
    expect(result?.accountProviderId).toBe("zai-api");
    expect(result?.billingMode).toBe("api-payg");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.zai.options.baseURL).toBe(
      "https://zai-proxy.test.invalid/v4",
    );
  });

  it.each([
    ["zai-api", "Z_AI_API_KEY", "zai"],
    ["moonshot-api", "KIMI_API_KEY", "moonshot"],
  ] as const)(
    "accepts the existing %s credential alias %s",
    (selector, keyEnv, provider) => {
      const result = buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: selector,
        [keyEnv]: `${selector}-legacy-alias-secret`,
      });
      const config = JSON.parse(result?.configContent ?? "{}");
      expect(config.provider[provider].options.apiKey).toBe(
        `${selector}-legacy-alias-secret`,
      );
    },
  );

  it("rejects malformed model ids and credential-bearing endpoints", () => {
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "deepseek-api",
        DEEPSEEK_API_KEY: "deepseek-secret",
        ELIZA_OPENCODE_MODEL_POWERFUL: "deepseek-v4-pro\nignore-policy",
      }),
    ).toThrow(/invalid OpenCode model id/i);
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "deepseek-api",
        DEEPSEEK_API_KEY: "deepseek-secret",
        DEEPSEEK_BASE_URL: "https://user:secret@example.invalid/v1",
      }),
    ).toThrow(/invalid API base URL/i);
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "deepseek-api",
        DEEPSEEK_API_KEY: "deepseek-secret",
        DEEPSEEK_BASE_URL: "http://proxy.example.invalid/v1",
      }),
    ).toThrow(/invalid API base URL/i);
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "deepseek-api",
        DEEPSEEK_API_KEY: "deepseek-secret",
        DEEPSEEK_BASE_URL:
          "https://proxy.example.invalid/v1?api_key=query-secret#fragment-secret",
      }),
    ).toThrow(/invalid API base URL/i);
  });

  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:11434/v1",
  ])("allows an explicit HTTP loopback API proxy at %s", (baseUrl) => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_PROVIDER: "deepseek-api",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_BASE_URL: baseUrl,
    });
    expect(result?.baseUrl).toBe(baseUrl);
  });

  it.each([
    "http://0.0.0.0:11434/v1",
    "http://192.168.1.10:11434/v1",
    "http://localhost.example.invalid:11434/v1",
  ])("rejects a non-canonical insecure API proxy at %s", (baseUrl) => {
    expect(() =>
      buildOpencodeSpawnConfig(runtime(), {
        ELIZA_OPENCODE_PROVIDER: "deepseek-api",
        DEEPSEEK_API_KEY: "deepseek-secret",
        DEEPSEEK_BASE_URL: baseUrl,
      }),
    ).toThrow(/invalid API base URL/i);
  });

  it("never projects endpoint credentials into structured logs", () => {
    const logged = safeOpencodeEndpointForLog(
      "https://user:password@proxy.example.invalid/v1?api_key=query-secret#fragment-secret",
    );
    expect(logged).toBe("https://proxy.example.invalid/v1");
    expect(logged).not.toMatch(/user|password|query-secret|fragment-secret/);
    expect(
      safeOpencodeEndpointForLog("not a URL with secret material"),
    ).toBeUndefined();
  });

  it("uses ELIZA_OPENCODE_MODEL_POWERFUL with a Cerebras base URL", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "csk-test",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("cerebras");
    expect(result?.model).toBe("cerebras/gpt-oss-120b");
  });

  it("detects Cerebras by URL host, including subdomains", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://gateway.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "csk-test",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("cerebras");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.baseURL).toBe(
      "https://gateway.cerebras.ai/v1",
    );
  });

  it("does not treat Cerebras text in a non-Cerebras URL path as Cerebras", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://proxy.example/v1/cerebras.ai",
      ELIZA_OPENCODE_API_KEY: "custom-key",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("eliza-local");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-local"].options.baseURL).toBe(
      "https://proxy.example/v1/cerebras.ai",
    );
  });

  it("does not pass unresolved vault pointers as provider API keys", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "vault://ELIZA_OPENCODE_API_KEY",
      CEREBRAS_API_KEY: "csk-resolved",
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
    });
    expect(result?.providerId).toBe("cerebras");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.apiKey).toBe("csk-resolved");
  });

  it("supports explicit local OpenAI-compatible opencode mode", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_LOCAL: "1",
      ELIZA_OPENCODE_BASE_URL: "http://localhost:11434/v1",
      ELIZA_OPENCODE_MODEL_POWERFUL: "eliza-1-4b",
    });
    expect(result?.providerId).toBe("eliza-local");
    expect(result?.model).toBe("eliza-local/eliza-1-4b");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-local"].options.baseURL).toBe(
      "http://localhost:11434/v1",
    );
  });

  it("falls back to user opencode.json model names when only a model is configured", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_MODEL_POWERFUL: "anthropic/claude-sonnet-4-5",
      ELIZA_OPENCODE_MODEL_FAST: "openai/gpt-4.1-mini",
    });
    expect(result?.providerId).toBe("user");
    expect(result?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(result?.smallModel).toBe("openai/gpt-4.1-mini");
  });

  it("allows the read-only webfetch permission for a provider config", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      CEREBRAS_API_KEY: "csk-test",
    });
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.permission?.webfetch).toBe("allow");
    // write/exec permissions stay gated by the approval preset, not granted here.
    expect(config.permission?.bash).toBeUndefined();
    expect(config.permission?.edit).toBeUndefined();
  });

  it("allows the read-only webfetch permission for a user-configured opencode.json", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_MODEL_POWERFUL: "anthropic/claude-sonnet-4-5",
    });
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.permission?.webfetch).toBe("allow");
  });
});

describe("buildOpencodeSpawnConfig (model-gateway mode, #11536 E2)", () => {
  beforeEach(() => {
    process.env.ELIZA_MODEL_GATEWAY_URL = GATEWAY_URL;
    process.env.ELIZA_MODEL_GATEWAY_TOKEN = GATEWAY_TOKEN;
  });

  it("routes through the gateway and never embeds a raw provider key", () => {
    const result = buildOpencodeSpawnConfig(
      runtime({ ELIZA_LLM_PROVIDER: "cloud" }),
      { CEREBRAS_API_KEY: "csk-raw-DO-NOT-LEAK" },
      undefined,
      {
        providerId: "deepseek-api",
        credentials: { DEEPSEEK_API_KEY: "deepseek-raw-DO-NOT-LEAK" },
      },
    );
    expect(result?.providerId).toBe("eliza-gateway");
    expect(result?.accountProviderId).toBeUndefined();
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-gateway"].options.baseURL).toBe(GATEWAY_URL);
    expect(config.provider["eliza-gateway"].options.apiKey).toBe(GATEWAY_TOKEN);
    expect(result?.configContent).not.toContain("csk-raw-DO-NOT-LEAK");
    expect(result?.configContent).not.toContain("deepseek-raw-DO-NOT-LEAK");
    expect(result?.configContent).not.toContain("cerebras.ai");
  });

  it("never embeds a runtime-settings key either (env deletion alone would miss it)", () => {
    const result = buildOpencodeSpawnConfig(
      runtime({ CEREBRAS_API_KEY: "csk-runtime-raw-DO-NOT-LEAK" }),
      {},
    );
    expect(result?.providerId).toBe("eliza-gateway");
    expect(result?.configContent).not.toContain("csk-runtime-raw-DO-NOT-LEAK");
  });

  it("beats a custom base URL — a spawn cannot bypass the gateway", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
      ELIZA_OPENCODE_API_KEY: "csk-raw-DO-NOT-LEAK",
    });
    expect(result?.providerId).toBe("eliza-gateway");
    expect(result?.configContent).not.toContain("cerebras.ai");
    expect(result?.configContent).not.toContain("csk-raw-DO-NOT-LEAK");
  });

  it("works with no raw provider key on the host (keys live gateway-side)", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {});
    expect(result?.providerId).toBe("eliza-gateway");
    // Model default mirrors the direct cerebras-api chain: transport +
    // credentials change, the model does not.
    expect(result?.model).toBe("eliza-gateway/gemma-4-31b");
  });

  it("passes configured model names through to the gateway unchanged", () => {
    const result = buildOpencodeSpawnConfig(runtime(), {
      ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
      ELIZA_OPENCODE_MODEL_FAST: "gemma-4-31b",
    });
    expect(result?.model).toBe("eliza-gateway/gpt-oss-120b");
    expect(result?.smallModel).toBe("eliza-gateway/gemma-4-31b");
  });

  it("stays off when only one gateway var is set", () => {
    delete process.env.ELIZA_MODEL_GATEWAY_TOKEN;
    const result = buildOpencodeSpawnConfig(runtime(), {
      CEREBRAS_API_KEY: "csk-test",
    });
    expect(result?.providerId).toBe("cerebras");
  });
});
