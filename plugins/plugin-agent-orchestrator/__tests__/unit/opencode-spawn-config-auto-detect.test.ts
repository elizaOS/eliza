import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpencodeSpawnConfig } from "../../src/services/opencode-config.js";

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
    expect(result?.providerLabel).toBe("Cerebras");
    expect(result?.model).toBe("cerebras/gemma-4-31b");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider.cerebras.options.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider.cerebras.npm).toBe("@ai-sdk/cerebras");
    expect(config.provider.cerebras.options.apiKey).toBe("csk-test");
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
    const result = buildOpencodeSpawnConfig(runtime(), {
      CEREBRAS_API_KEY: "csk-raw-DO-NOT-LEAK",
    });
    expect(result?.providerId).toBe("eliza-gateway");
    const config = JSON.parse(result?.configContent ?? "{}");
    expect(config.provider["eliza-gateway"].options.baseURL).toBe(GATEWAY_URL);
    expect(config.provider["eliza-gateway"].options.apiKey).toBe(GATEWAY_TOKEN);
    expect(result?.configContent).not.toContain("csk-raw-DO-NOT-LEAK");
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
