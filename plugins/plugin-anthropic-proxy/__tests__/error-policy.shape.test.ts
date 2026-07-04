/**
 * Failure-path tests for the #12182 error-handling policy (#12795): a
 * malformed/incomplete credentials file must become a typed LoadResult
 * failure (never a fabricated credential), and an invalid fingerprint config
 * must surface as startError + documented off-mode degrade (never a silently
 * fabricated config). Deterministic: temp files + env overrides, no live API.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProxyService } from "../src/services/proxy-service.js";
import { loadCredentials } from "../src/utils/credentials-loader.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length) {
    await cleanup.pop()?.();
  }
});

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anthropic-proxy-errpolicy-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("credentials loader failure surfaces", () => {
  it("returns a typed failure for a malformed credentials file, never a fabricated credential", () => {
    const dir = tempDir();
    const credsPath = join(dir, "credentials.json");
    writeFileSync(credsPath, "{ not json ");

    const result = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, () =>
      loadCredentials({ credentialsPath: credsPath })
    );
    expect(result.creds).toBeNull();
    expect(result.error).toMatch(/failed to read/);
    expect(result.error).toContain(credsPath);
  });

  it("returns a typed failure when the file parses but has no accessToken", () => {
    const dir = tempDir();
    const credsPath = join(dir, "credentials.json");
    writeFileSync(credsPath, JSON.stringify({ claudeAiOauth: { subscriptionType: "max" } }));

    const result = withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, () =>
      loadCredentials({ credentialsPath: credsPath })
    );
    expect(result.creds).toBeNull();
    expect(result.error).toMatch(/missing claudeAiOauth\.accessToken/);
  });
});

describe("service config failure surfaces", () => {
  it("degrades to off with an observable startError when the fingerprint config is invalid JSON", async () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, "{ definitely not json");

    const service = await withEnv(
      {
        CLAUDE_MAX_PROXY_MODE: "inline",
        CLAUDE_MAX_PROXY_CONFIG_PATH: configPath,
        CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-not-real",
      },
      () => AnthropicProxyService.start({} as unknown as never)
    );
    cleanup.push(() => service.stop());

    expect(service.getEffectiveMode()).toBe("off");
    expect(service.getStartError()).toMatch(/Invalid anthropic proxy config/);
    const status = await service.getStatus();
    expect(status.startError).toMatch(/Invalid anthropic proxy config/);
  });

  it("degrades to off with an observable startError when the config schema is wrong", async () => {
    const dir = tempDir();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ replacements: "not-an-array" }));

    const service = await withEnv(
      {
        CLAUDE_MAX_PROXY_MODE: "inline",
        CLAUDE_MAX_PROXY_CONFIG_PATH: configPath,
        CLAUDE_CODE_OAUTH_TOKEN: "test-oauth-token-not-real",
      },
      () => AnthropicProxyService.start({} as unknown as never)
    );
    cleanup.push(() => service.stop());

    expect(service.getEffectiveMode()).toBe("off");
    expect(service.getStartError()).toMatch(/Invalid anthropic proxy config/);
  });
});
