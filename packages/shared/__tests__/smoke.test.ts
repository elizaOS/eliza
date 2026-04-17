import { describe, expect, it } from "vitest";

describe("@elizaos/shared", () => {
  it("exports the package entry point", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
  });

  describe("isTruthyEnvValue", () => {
    it("returns true for standard truthy strings", async () => {
      const { isTruthyEnvValue } = await import("../src/env-utils.impl.ts");
      for (const val of ["1", "true", "yes", "y", "on", "enabled"]) {
        expect(isTruthyEnvValue(val)).toBe(true);
      }
    });

    it("is case-insensitive", async () => {
      const { isTruthyEnvValue } = await import("../src/env-utils.impl.ts");
      expect(isTruthyEnvValue("TRUE")).toBe(true);
      expect(isTruthyEnvValue("Yes")).toBe(true);
      expect(isTruthyEnvValue("ON")).toBe(true);
    });

    it("trims whitespace", async () => {
      const { isTruthyEnvValue } = await import("../src/env-utils.impl.ts");
      expect(isTruthyEnvValue("  true  ")).toBe(true);
      expect(isTruthyEnvValue(" 1 ")).toBe(true);
    });

    it("returns false for falsy values", async () => {
      const { isTruthyEnvValue } = await import("../src/env-utils.impl.ts");
      expect(isTruthyEnvValue("0")).toBe(false);
      expect(isTruthyEnvValue("false")).toBe(false);
      expect(isTruthyEnvValue("no")).toBe(false);
      expect(isTruthyEnvValue("")).toBe(false);
      expect(isTruthyEnvValue(undefined)).toBe(false);
      expect(isTruthyEnvValue(null)).toBe(false);
    });
  });

  describe("sanitizeSpeechText", () => {
    it("strips markdown code blocks", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Hello ```code block``` world");
      expect(result).not.toContain("```");
      expect(result).toContain("Hello");
      expect(result).toContain("world");
    });

    it("strips URLs", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Visit https://example.com for details");
      expect(result).not.toContain("https://example.com");
      expect(result).toContain("Visit");
    });

    it("strips thinking tags", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Hello <think>internal reasoning</think> world");
      expect(result).not.toContain("internal reasoning");
      expect(result).toContain("Hello");
      expect(result).toContain("world");
    });

    it("strips non-speech directions like asterisk actions", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Hello *waves hand* world");
      expect(result).not.toContain("waves hand");
    });

    it("collapses whitespace", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Hello    world   foo");
      expect(result).toBe("Hello world foo");
    });

    it("normalizes unicode punctuation", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("Hello\u2014world");
      expect(result).toContain(",");
    });

    it("returns empty string for empty input after stripping", async () => {
      const { sanitizeSpeechText } = await import("../src/index.ts");
      const result = sanitizeSpeechText("   ");
      expect(result).toBe("");
    });
  });

  describe("normalizeConnectorSource", () => {
    it("normalizes known connector aliases", async () => {
      const { normalizeConnectorSource } = await import("../src/index.ts");
      expect(normalizeConnectorSource("discord")).toBe("discord");
      expect(normalizeConnectorSource("discord-local")).toBe("discord");
      expect(normalizeConnectorSource("telegram-account")).toBe("telegram");
      expect(normalizeConnectorSource("telegramaccount")).toBe("telegram");
      expect(normalizeConnectorSource("bluebubbles")).toBe("imessage");
    });

    it("is case-insensitive and trims whitespace", async () => {
      const { normalizeConnectorSource } = await import("../src/index.ts");
      expect(normalizeConnectorSource("Discord")).toBe("discord");
      expect(normalizeConnectorSource("  TELEGRAM  ")).toBe("telegram");
    });

    it("returns empty string for null/undefined/empty", async () => {
      const { normalizeConnectorSource } = await import("../src/index.ts");
      expect(normalizeConnectorSource(null)).toBe("");
      expect(normalizeConnectorSource(undefined)).toBe("");
      expect(normalizeConnectorSource("")).toBe("");
      expect(normalizeConnectorSource("   ")).toBe("");
    });

    it("passes through unknown sources as-is (lowercased)", async () => {
      const { normalizeConnectorSource } = await import("../src/index.ts");
      expect(normalizeConnectorSource("matrix")).toBe("matrix");
    });
  });

  describe("getConnectorSourceAliases", () => {
    it("returns all aliases for a known connector", async () => {
      const { getConnectorSourceAliases } = await import("../src/index.ts");
      const aliases = getConnectorSourceAliases("discord");
      expect(aliases).toContain("discord");
      expect(aliases).toContain("discord-local");
    });

    it("returns the source itself for unknown connectors", async () => {
      const { getConnectorSourceAliases } = await import("../src/index.ts");
      const aliases = getConnectorSourceAliases("custom-connector");
      expect(aliases).toEqual(["custom-connector"]);
    });

    it("returns empty array for null/undefined/empty", async () => {
      const { getConnectorSourceAliases } = await import("../src/index.ts");
      expect(getConnectorSourceAliases(null)).toEqual([]);
      expect(getConnectorSourceAliases(undefined)).toEqual([]);
    });
  });

  describe("expandConnectorSourceFilter", () => {
    it("expands a set of sources into all aliases", async () => {
      const { expandConnectorSourceFilter } = await import("../src/index.ts");
      const expanded = expandConnectorSourceFilter(["discord", "telegram"]);
      expect(expanded).toBeInstanceOf(Set);
      expect(expanded.has("discord")).toBe(true);
      expect(expanded.has("discord-local")).toBe(true);
      expect(expanded.has("telegram")).toBe(true);
      expect(expanded.has("telegram-account")).toBe(true);
    });

    it("handles null/undefined input", async () => {
      const { expandConnectorSourceFilter } = await import("../src/index.ts");
      expect(expandConnectorSourceFilter(null)).toEqual(new Set());
      expect(expandConnectorSourceFilter(undefined)).toEqual(new Set());
    });
  });

  describe("registerConnectorSourceAliases", () => {
    it("registers runtime aliases for a new connector", async () => {
      const {
        registerConnectorSourceAliases,
        normalizeConnectorSource,
        getConnectorSourceAliases,
      } = await import("../src/index.ts");
      registerConnectorSourceAliases("matrix", ["matrix", "element", "riot"]);
      expect(normalizeConnectorSource("element")).toBe("matrix");
      expect(normalizeConnectorSource("riot")).toBe("matrix");
      const aliases = getConnectorSourceAliases("matrix");
      expect(aliases).toContain("element");
      expect(aliases).toContain("riot");
    });
  });

  describe("runtime-env utilities", () => {
    it("resolves default ports when no env is set", async () => {
      const { resolveRuntimePorts, DEFAULT_DESKTOP_API_PORT, DEFAULT_DESKTOP_UI_PORT } =
        await import("../src/index.ts");
      const ports = resolveRuntimePorts({});
      expect(ports.desktopApiPort).toBe(DEFAULT_DESKTOP_API_PORT);
      expect(ports.desktopUiPort).toBe(DEFAULT_DESKTOP_UI_PORT);
    });

    it("resolves custom ports from env", async () => {
      const { resolveRuntimePorts } = await import("../src/index.ts");
      const ports = resolveRuntimePorts({ ELIZA_API_PORT: "9999", ELIZA_UI_PORT: "8888" });
      expect(ports.desktopApiPort).toBe(9999);
      expect(ports.desktopUiPort).toBe(8888);
    });

    it("ignores invalid port values", async () => {
      const { resolveRuntimePorts, DEFAULT_DESKTOP_API_PORT } = await import("../src/index.ts");
      const ports = resolveRuntimePorts({ ELIZA_API_PORT: "not-a-number" });
      expect(ports.desktopApiPort).toBe(DEFAULT_DESKTOP_API_PORT);
    });

    it("isLoopbackBindHost identifies loopback addresses", async () => {
      const { isLoopbackBindHost } = await import("../src/index.ts");
      expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
      expect(isLoopbackBindHost("localhost")).toBe(true);
      expect(isLoopbackBindHost("::1")).toBe(true);
      expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
      expect(isLoopbackBindHost("192.168.1.1")).toBe(false);
    });

    it("isWildcardBindHost identifies wildcard addresses", async () => {
      const { isWildcardBindHost } = await import("../src/index.ts");
      expect(isWildcardBindHost("0.0.0.0")).toBe(true);
      expect(isWildcardBindHost("::")).toBe(true);
      expect(isWildcardBindHost("127.0.0.1")).toBe(false);
    });

    it("stripOptionalHostPort strips port from host:port", async () => {
      const { stripOptionalHostPort } = await import("../src/index.ts");
      expect(stripOptionalHostPort("localhost:3000")).toBe("localhost");
      expect(stripOptionalHostPort("http://example.com:8080")).toBe("example.com");
      expect(stripOptionalHostPort("")).toBe("");
    });

    it("resolveApiSecurityConfig returns defaults for empty env", async () => {
      const { resolveApiSecurityConfig } = await import("../src/index.ts");
      const config = resolveApiSecurityConfig({});
      expect(config.bindHost).toBe("127.0.0.1");
      expect(config.token).toBeNull();
      expect(config.isLoopbackBind).toBe(true);
      expect(config.isWildcardBind).toBe(false);
      expect(config.allowedOrigins).toEqual([]);
      expect(config.allowedHosts).toEqual([]);
    });

    it("resolveApiSecurityConfig reads ELIZA_API_TOKEN", async () => {
      const { resolveApiSecurityConfig } = await import("../src/index.ts");
      const config = resolveApiSecurityConfig({ ELIZA_API_TOKEN: "test-token-123" });
      expect(config.token).toBe("test-token-123");
    });

    it("resolveApiSecurityConfig parses comma-separated origins", async () => {
      const { resolveApiSecurityConfig } = await import("../src/index.ts");
      const config = resolveApiSecurityConfig({
        ELIZA_ALLOWED_ORIGINS: "http://localhost:3000,http://example.com",
      });
      expect(config.allowedOrigins).toEqual(["http://localhost:3000", "http://example.com"]);
    });
  });

  describe("settings-debug utilities", () => {
    it("isElizaSettingsDebugEnabled returns false when env is empty", async () => {
      const { isElizaSettingsDebugEnabled } = await import("../src/index.ts");
      expect(isElizaSettingsDebugEnabled({ env: {} })).toBe(false);
    });

    it("isElizaSettingsDebugEnabled returns true when ELIZA_SETTINGS_DEBUG=1", async () => {
      const { isElizaSettingsDebugEnabled } = await import("../src/index.ts");
      expect(isElizaSettingsDebugEnabled({ env: { ELIZA_SETTINGS_DEBUG: "1" } })).toBe(true);
    });

    it("sanitizeForSettingsDebug masks sensitive keys", async () => {
      const { sanitizeForSettingsDebug } = await import("../src/index.ts");
      const result = sanitizeForSettingsDebug({
        name: "test",
        apikey: "sk-1234567890abcdef",
        password: "supersecret123",
      }) as Record<string, unknown>;
      expect(result.name).toBe("test");
      // Sensitive string values are masked (showing partial chars and length), not passed through
      expect(result.apikey).not.toBe("sk-1234567890abcdef");
      expect(typeof result.apikey).toBe("string");
      expect((result.apikey as string)).toContain("chars");
      expect(result.password).not.toBe("supersecret123");
    });

    it("sanitizeForSettingsDebug handles null/undefined/primitives", async () => {
      const { sanitizeForSettingsDebug } = await import("../src/index.ts");
      expect(sanitizeForSettingsDebug(null)).toBeNull();
      expect(sanitizeForSettingsDebug(undefined)).toBeUndefined();
      expect(sanitizeForSettingsDebug(42)).toBe(42);
      expect(sanitizeForSettingsDebug(true)).toBe(true);
    });

    it("settingsDebugCloudSummary returns compact cloud info", async () => {
      const { settingsDebugCloudSummary } = await import("../src/index.ts");
      const summary = settingsDebugCloudSummary({
        enabled: true,
        inferenceMode: "cloud",
        services: ["llm"],
        baseUrl: "https://api.example.com",
        apiKey: "sk-test-key-12345",
      });
      expect(summary.enabled).toBe(true);
      expect(summary.hasApiKey).toBe(true);
      expect(summary).not.toHaveProperty("apiKey");
    });

    it("settingsDebugCloudSummary handles null input", async () => {
      const { settingsDebugCloudSummary } = await import("../src/index.ts");
      expect(settingsDebugCloudSummary(null)).toEqual({ cloud: null });
      expect(settingsDebugCloudSummary(undefined)).toEqual({ cloud: null });
    });
  });

  describe("restart module", () => {
    it("exports RESTART_EXIT_CODE as 75", async () => {
      const { RESTART_EXIT_CODE } = await import("../src/index.ts");
      expect(RESTART_EXIT_CODE).toBe(75);
    });

    it("setRestartHandler and requestRestart work together", async () => {
      const { setRestartHandler, requestRestart } = await import("../src/index.ts");
      let capturedReason: string | undefined;
      setRestartHandler((reason) => {
        capturedReason = reason;
      });
      requestRestart("test-reason");
      expect(capturedReason).toBe("test-reason");
      // Reset to no-op
      setRestartHandler(() => {});
    });
  });

  describe("migrateLegacyRuntimeConfig export", () => {
    it("is a function", async () => {
      const { migrateLegacyRuntimeConfig } = await import("../src/index.ts");
      expect(typeof migrateLegacyRuntimeConfig).toBe("function");
    });
  });
});
