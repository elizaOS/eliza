import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, getClaudeOAuthToken } from "../utils/credential-store.js";

describe("Anthropic credential store", () => {
  let stateDir: string;
  const originalStateDir = process.env.ELIZA_STATE_DIR;
  const originalNamespace = process.env.ELIZA_NAMESPACE;
  const originalEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalAnthropicEnvToken = process.env.ANTHROPIC_OAUTH_TOKEN;

  beforeEach(() => {
    stateDir = join(tmpdir(), `anthropic-credentials-${Date.now()}`);
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_NAMESPACE = "eliza";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-env-token";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    clearTokenCache();
  });

  afterEach(() => {
    clearTokenCache();
    if (originalStateDir === undefined) {
      delete process.env.ELIZA_STATE_DIR;
    } else {
      process.env.ELIZA_STATE_DIR = originalStateDir;
    }
    if (originalNamespace === undefined) {
      delete process.env.ELIZA_NAMESPACE;
    } else {
      process.env.ELIZA_NAMESPACE = originalNamespace;
    }
    if (originalEnvToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnvToken;
    }
    if (originalAnthropicEnvToken === undefined) {
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicEnvToken;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("prefers refreshed app-managed subscription credentials over stale env tokens", () => {
    const credentialsDir = join(stateDir, "auth", "anthropic-subscription");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, "default.json"),
      JSON.stringify({
        credentials: {
          access: "fresh-app-token",
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60 * 1000,
        },
      })
    );

    expect(getClaudeOAuthToken().accessToken).toBe("fresh-app-token");
  });
});
