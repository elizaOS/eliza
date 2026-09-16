/**
 * Exercises Claude Code credential-file parsing through the public subscription
 * status and deferred-detection entry points with real temporary files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger, resetSubscriptionAuthProviders } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "./anthropic";
import {
  applySubscriptionCredentialsDeferred,
  getSubscriptionStatus,
} from "./credentials";

vi.mock("./anthropic.ts", () => ({
  refreshAnthropicToken: vi.fn(),
}));

const tempHomes: string[] = [];

function useClaudeCredentialRaw(raw: string): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-claude-auth-"));
  tempHomes.push(home);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), raw, {
    mode: 0o600,
  });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ELIZA_HOME", home);
  vi.stubEnv("ELIZA_STATE_DIR", home);
  vi.stubEnv("ELIZA_DISABLE_SUBSCRIPTION_CREDENTIALS", "0");
}

function useClaudeCredentialDocument(document: unknown): void {
  useClaudeCredentialRaw(JSON.stringify(document));
}

function useClaudeCredentialFixture(
  claudeAiOauth: Record<string, unknown>,
): void {
  useClaudeCredentialDocument({ claudeAiOauth });
}

function anthropicStatusRows() {
  return getSubscriptionStatus().filter(
    (row) => row.provider === "anthropic-subscription" && row.configured,
  );
}

describe("Claude Code credential boundary", () => {
  beforeEach(() => {
    resetSubscriptionAuthProviders();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetSubscriptionAuthProviders();
    for (const home of tempHomes.splice(0)) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["null document", null],
    ["array document", []],
    ["array OAuth payload", { claudeAiOauth: [] }],
  ])("rejects a malformed %s", async (_case, document) => {
    useClaudeCredentialDocument(document);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    expect(anthropicStatusRows()).toEqual([]);
    await applySubscriptionCredentialsDeferred();

    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ["missing access token", {}],
    ["numeric access token", { accessToken: 42 }],
    ["empty access token", { accessToken: "" }],
    ["whitespace access token", { accessToken: "   " }],
    ["string expiry", { accessToken: "access", expiresAt: "not-a-timestamp" }],
    ["negative expiry", { accessToken: "access", expiresAt: -1 }],
    ["object expiry", { accessToken: "access", expiresAt: {} }],
    [
      "numeric refresh token",
      { accessToken: "access", refreshToken: 42, expiresAt: Date.now() - 1 },
    ],
    [
      "shadowed snake_case access token",
      {
        accessToken: "access",
        access_token: 42,
        expiresAt: Date.now() + 60_000,
      },
    ],
    [
      "shadowed snake_case refresh token",
      {
        accessToken: "access",
        refreshToken: "refresh",
        refresh_token: 42,
        expiresAt: Date.now() + 60_000,
      },
    ],
    [
      "shadowed snake_case expiry",
      {
        accessToken: "access",
        expiresAt: Date.now() + 60_000,
        expires_at: "bad",
      },
    ],
  ])("rejects a blob with a malformed %s", async (_case, oauth) => {
    useClaudeCredentialFixture(oauth);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    expect(anthropicStatusRows()).toEqual([]);
    await applySubscriptionCredentialsDeferred();

    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("rejects an overflowing JSON expiry", async () => {
    useClaudeCredentialRaw(
      '{"claudeAiOauth":{"accessToken":"access","expiresAt":1e400}}',
    );
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    expect(anthropicStatusRows()).toEqual([]);
    await applySubscriptionCredentialsDeferred();

    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("preserves a future camelCase expiry", async () => {
    const expiresAt = Date.now() + 60_000;
    useClaudeCredentialFixture({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt,
    });

    expect(anthropicStatusRows()).toMatchObject([
      { valid: true, expiresAt, source: "claude-code-cli" },
    ]);
    const beforeDiscovery = anthropicStatusRows();
    await applySubscriptionCredentialsDeferred();
    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(anthropicStatusRows()).toEqual(beforeDiscovery);
  });

  it("keeps an absent expiry as an explicit unknown expiry", async () => {
    useClaudeCredentialFixture({ accessToken: "access" });

    expect(anthropicStatusRows()).toMatchObject([
      { valid: true, expiresAt: null, source: "claude-code-cli" },
    ]);
    const beforeDiscovery = anthropicStatusRows();
    await applySubscriptionCredentialsDeferred();
    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(anthropicStatusRows()).toEqual(beforeDiscovery);
  });

  it("accepts explicit null refresh and expiry fields", async () => {
    useClaudeCredentialFixture({
      accessToken: "access",
      refreshToken: null,
      expiresAt: null,
    });

    expect(anthropicStatusRows()).toMatchObject([
      { valid: true, expiresAt: null, source: "claude-code-cli" },
    ]);
    const beforeDiscovery = anthropicStatusRows();
    await applySubscriptionCredentialsDeferred();
    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(anthropicStatusRows()).toEqual(beforeDiscovery);
  });

  it("reports an expired snake_case credential without refreshing it", async () => {
    const expiresAt = Date.now() - 60_000;
    useClaudeCredentialFixture({
      access_token: "access",
      refresh_token: "refresh",
      expires_at: expiresAt,
    });
    expect(anthropicStatusRows()).toMatchObject([
      { valid: false, expiresAt, source: "claude-code-cli" },
    ]);
    const beforeDiscovery = anthropicStatusRows();
    await applySubscriptionCredentialsDeferred();

    expect(refreshAnthropicToken).not.toHaveBeenCalled();
    expect(anthropicStatusRows()).toEqual(beforeDiscovery);
  });
});
