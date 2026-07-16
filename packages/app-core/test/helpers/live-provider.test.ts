/** Exercises live provider behavior with deterministic app-core test fixtures. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("selectLiveProvider", () => {
  beforeEach(() => {
    for (const key of [
      "CEREBRAS_API_KEY",
      "ELIZA_E2E_CEREBRAS_API_KEY",
      "GROQ_API_KEY",
      "ELIZA_E2E_GROQ_API_KEY",
      "OPENAI_API_KEY",
      "ELIZA_E2E_OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ELIZA_E2E_ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "ELIZA_E2E_GOOGLE_GENERATIVE_AI_API_KEY",
      "OPENROUTER_API_KEY",
      "ELIZA_E2E_OPENROUTER_API_KEY",
      "ELIZA_PROVIDER",
      "ELIZA_LIVE_PROVIDER_CONFIG_PATH",
      "ELIZA_LIVE_PROVIDER_STATE_DIR",
      "ELIZA_STATE_DIR",
      "ELIZA_NAMESPACE",
      "XDG_STATE_HOME",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@elizaos/vault");
    vi.unstubAllEnvs();
  });

  it("rejects groq-shaped keys for openai provider selection", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });

  it("does not treat Eliza Cloud keys as direct OpenAI provider credentials", async () => {
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud_test_key");
    vi.stubEnv("ELIZA_CLOUD_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");

    const { availableProviderNames, selectLiveProvider } = await import(
      "./live-provider.ts"
    );

    expect(selectLiveProvider("openai")).toBeNull();
    expect(availableProviderNames()).not.toContain("openai");
  });

  it("still selects groq when both env vars exist but openai is misconfigured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "gsk_test_invalid_for_openai");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_valid_for_groq");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.name).toBe("groq");
  });

  it("accepts ELIZA_E2E_GROQ_API_KEY alias and propagates it under GROQ_API_KEY", async () => {
    // Credentialed CI lanes may expose the scoped alias while the runtime
    // plugin consumes the canonical provider key.
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_GROQ_API_KEY", "gsk_test_valid_for_groq");

    const { selectLiveProvider, availableProviderNames } = await import(
      "./live-provider.ts"
    );

    const provider = selectLiveProvider();
    expect(provider?.name).toBe("groq");
    expect(provider?.apiKey).toBe("gsk_test_valid_for_groq");
    expect(provider?.env.GROQ_API_KEY).toBe("gsk_test_valid_for_groq");
    expect(availableProviderNames()).toContain("groq");
  });

  it("prefers canonical GROQ_API_KEY over alias when both are set", async () => {
    vi.stubEnv("GROQ_API_KEY", "gsk_canonical");
    vi.stubEnv("ELIZA_E2E_GROQ_API_KEY", "gsk_alias");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.apiKey).toBe("gsk_canonical");
  });

  it("selects cerebras when explicitly selected with ELIZA_PROVIDER", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "csk_test_cerebras_key");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");

    const { selectLiveProvider } = await import("./live-provider.ts");

    const provider = selectLiveProvider();
    expect(provider?.name).toBe("cerebras");
    expect(provider?.baseUrl).toBe("https://api.cerebras.ai/v1");
    expect(provider?.largeModel).toBe("gemma-4-31b");
    expect(provider?.smallModel).toBe("gemma-4-31b");
    expect(provider?.env.ELIZA_PROVIDER).toBe("cerebras");
    expect(provider?.env.CEREBRAS_MODEL).toBe("gemma-4-31b");
    expect(provider?.env.OPENAI_SMALL_MODEL).toBe("gemma-4-31b");
    expect(provider?.env.OPENAI_LARGE_MODEL).toBe("gemma-4-31b");
  });

  it("resolves Cerebras vault references in the async selector", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "vault://providers.cerebras.api-key");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");

    const get = vi.fn(async (key: string) => {
      expect(key).toBe("providers.cerebras.api-key");
      return "csk_resolved_cerebras_key";
    });
    const close = vi.fn(async () => {});
    vi.doMock("@elizaos/vault", () => ({
      createVault: vi.fn(() => ({ get, close })),
    }));

    const { selectLiveProviderAsync } = await import("./live-provider.ts");

    const provider = await selectLiveProviderAsync();
    expect(provider?.name).toBe("cerebras");
    expect(provider?.apiKey).toBe("csk_resolved_cerebras_key");
    expect(provider?.env.CEREBRAS_API_KEY).toBe("csk_resolved_cerebras_key");
    expect(provider?.env.OPENAI_API_KEY).toBe("csk_resolved_cerebras_key");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("loads a vault-referenced Cerebras key from local eliza.json in the async selector", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "eliza-live-provider-"));
    await writeFile(
      path.join(stateDir, "eliza.json"),
      JSON.stringify({
        env: {
          vars: {
            CEREBRAS_API_KEY: "vault://CEREBRAS_API_KEY",
          },
        },
      }),
      "utf8",
    );
    vi.stubEnv("ELIZA_LIVE_PROVIDER_STATE_DIR", stateDir);
    vi.stubEnv("ELIZA_PROVIDER", "cerebras");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    const createVault = vi.fn(() => ({
      get: vi.fn(async (key: string) => {
        expect(key).toBe("CEREBRAS_API_KEY");
        return "csk_local_config_cerebras_key";
      }),
      close: vi.fn(async () => {}),
    }));
    vi.doMock("@elizaos/vault", () => ({ createVault }));

    try {
      const { selectLiveProviderAsync } = await import("./live-provider.ts");

      const provider = await selectLiveProviderAsync();
      expect(provider?.name).toBe("cerebras");
      expect(provider?.apiKey).toBe("csk_local_config_cerebras_key");
      expect(createVault).toHaveBeenCalledWith({ workDir: stateDir });
    } finally {
      await rm(stateDir, { force: true, recursive: true });
    }
  });

  it("uses the first-class Cerebras first-run provider id", async () => {
    const { getFirstRunProviderForLiveProvider } = await import(
      "./live-provider.ts"
    );

    expect(getFirstRunProviderForLiveProvider({ name: "cerebras" })).toBe(
      "cerebras",
    );
    expect(
      getFirstRunProviderForLiveProvider({ name: "local-llama-cpp" }),
    ).toBe("openai");
  });

  it("prefers groq over a bare cerebras eval key unless cerebras is explicitly selected", async () => {
    vi.stubEnv("CEREBRAS_API_KEY", "csk_test_cerebras_key");
    vi.stubEnv("GROQ_API_KEY", "gsk_test_groq_key");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider()?.name).toBe("groq");
  });

  it("rejects csk-prefixed keys for openai provider selection", async () => {
    vi.stubEnv("OPENAI_API_KEY", "csk_test_cerebras_key_in_wrong_slot");
    vi.stubEnv("ELIZA_E2E_OPENAI_API_KEY", "");
    vi.stubEnv("CEREBRAS_API_KEY", "");

    const { selectLiveProvider } = await import("./live-provider.ts");

    expect(selectLiveProvider("openai")).toBeNull();
  });
});
