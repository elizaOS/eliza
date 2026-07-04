/** Unit tests for OAuth token resolution in the credential store; uses real temp dirs and env-var manipulation, no live API. */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, getClaudeOAuthToken } from "../utils/credential-store.js";

describe("Anthropic credential store", () => {
  let stateDir: string;
  const originalStateDir = process.env.ELIZA_STATE_DIR;
  const originalNamespace = process.env.ELIZA_NAMESPACE;
  const originalEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const originalAnthropicEnvToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    stateDir = join(tmpdir(), `anthropic-credentials-${Date.now()}`);
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_NAMESPACE = "eliza";
    process.env.HOME = stateDir;
    process.env.USERPROFILE = stateDir;
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
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
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

  it("throws CREDENTIALS_CORRUPT when ~/.claude/.credentials.json is unparseable, not a silent null", () => {
    // No env token and no app-managed creds: resolution reaches the file store.
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    const configDir = join(stateDir, "claude-config");
    mkdirSync(configDir, { recursive: true });
    // A file that EXISTS but is corrupt must surface — never downgrade to "no
    // credentials", which would look identical to an absent file.
    writeFileSync(join(configDir, ".credentials.json"), "{ this is not valid json ");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    clearTokenCache();

    try {
      getClaudeOAuthToken();
      expect.unreachable("a corrupt credential file must throw, not return null");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(ElizaError);
      expect((thrown as ElizaError).code).toBe("CREDENTIALS_CORRUPT");
    }
  });

  it("returns the honest 'not authenticated' error when the credential file is simply absent", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    const configDir = join(stateDir, "claude-config-absent");
    mkdirSync(configDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir; // dir exists, .credentials.json does not
    clearTokenCache();

    // Absent (ENOENT) is not corrupt: the file reader returns null, and the
    // caller raises the standard "could not read OAuth token" guidance error
    // (a plain Error), NOT a CREDENTIALS_CORRUPT ElizaError.
    try {
      getClaudeOAuthToken();
      expect.unreachable("no credentials means the caller must throw its guidance error");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as ElizaError).code).not.toBe("CREDENTIALS_CORRUPT");
      expect((thrown as Error).message).toContain("OAuth token");
    }
  });
});
