import { describe, expect, it, vi, beforeEach } from "vitest";
import { logger } from "@elizaos/core";

const configMock = vi.hoisted(() => ({
  getAuthMode: vi.fn(),
  getApiKeyOptional: vi.fn(),
  isBrowser: vi.fn(),
}));
vi.mock("./utils/config", () => ({
  getAuthMode: configMock.getAuthMode,
  getApiKeyOptional: configMock.getApiKeyOptional,
  isBrowser: configMock.isBrowser,
}));

const credMock = vi.hoisted(() => ({
  getClaudeOAuthToken: vi.fn(),
  getClaudeOAuthMeta: vi.fn(),
}));
vi.mock("./utils/credential-store", () => ({
  getClaudeOAuthToken: credMock.getClaudeOAuthToken,
  getClaudeOAuthMeta: credMock.getClaudeOAuthMeta,
}));

import { initializeAnthropic } from "./init.ts";

// initializeAnthropic fires a detached async IIFE whose body is fully
// synchronous — one macrotask flush is enough to observe its side effects.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  configMock.getAuthMode.mockReturnValue("apikey");
  configMock.getApiKeyOptional.mockReturnValue(undefined);
  configMock.isBrowser.mockReturnValue(false);
  credMock.getClaudeOAuthToken.mockReturnValue({
    expiresAt: 1750000000000,
  });
  credMock.getClaudeOAuthMeta.mockReturnValue(null);
});

describe("initializeAnthropic", () => {
  it("sets the AI_SDK_LOG_WARNINGS default on module load", () => {
    expect(
      (globalThis as typeof globalThis & { AI_SDK_LOG_WARNINGS?: boolean })
        .AI_SDK_LOG_WARNINGS
    ).toBe(false);
  });

  it("logs a warning when no API key is set in a non-browser environment", async () => {
    initializeAnthropic({}, {} as never);
    await flush();
    const warn = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("stays silent when no key is set in a browser environment", async () => {
    configMock.isBrowser.mockReturnValue(true);
    initializeAnthropic({}, {} as never);
    await flush();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs success when an API key is configured", async () => {
    configMock.getApiKeyOptional.mockReturnValue("sk-ant-123");
    initializeAnthropic({}, {} as never);
    await flush();
    expect(
      logger.log.mock.calls.some((c) =>
        String(c[0]).includes("API key configured successfully")
      )
    ).toBe(true);
  });

  it("preflights the claude CLI and logs the CLI mode", async () => {
    configMock.getAuthMode.mockReturnValue("cli");
    (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {
      spawnSync: () => ({ exitCode: 0 }),
    };
    initializeAnthropic({}, {} as never);
    await flush();
    expect(
      logger.log.mock.calls.some((c) =>
        String(c[0]).includes("CLI mode")
      )
    ).toBe(true);
    delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  });

  it("warns when the claude CLI preflight fails (missing binary)", async () => {
    configMock.getAuthMode.mockReturnValue("cli");
    (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {
      spawnSync: () => ({ exitCode: 127 }),
    };
    initializeAnthropic({}, {} as never);
    await flush();
    const warn = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("claude` command not found");
    delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  });

  it("warns when the claude CLI preflight throws", async () => {
    configMock.getAuthMode.mockReturnValue("cli");
    (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {
      spawnSync: () => {
        throw new Error("spawn ENOENT");
      },
    };
    initializeAnthropic({}, {} as never);
    await flush();
    const warn = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("claude` command not found");
    delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  });

  it("logs OAuth subscription details when meta is present", async () => {
    configMock.getAuthMode.mockReturnValue("oauth");
    credMock.getClaudeOAuthMeta.mockReturnValue({
      subscriptionType: "pro",
      rateLimitTier: "tier-2",
    });
    initializeAnthropic({}, {} as never);
    await flush();
    const logged = logger.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("OAuth configured");
    expect(logged).toContain("pro");
  });

  it("falls back to the env-var notice when no OAuth meta exists", async () => {
    configMock.getAuthMode.mockReturnValue("oauth");
    initializeAnthropic({}, {} as never);
    await flush();
    expect(
      logger.log.mock.calls.some((c) =>
        String(c[0]).includes("CLAUDE_CODE_OAUTH_TOKEN")
      )
    ).toBe(true);
  });

  it("warns without crashing when the OAuth token store is broken", async () => {
    configMock.getAuthMode.mockReturnValue("oauth");
    credMock.getClaudeOAuthToken.mockImplementation(() => {
      throw new Error("token store corrupted");
    });
    initializeAnthropic({}, {} as never);
    await flush();
    const warn = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("OAuth credential issue");
    expect(warn).toContain("token store corrupted");
  });
});
