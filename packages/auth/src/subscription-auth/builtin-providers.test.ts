/**
 * Exercises built-in external credential discovery through the real registry
 * with isolated on-disk Codex auth files and no provider or network mocks.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getSubscriptionAuthProvider,
  resetSubscriptionAuthProviders,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBuiltinSubscriptionAuthProviders } from "./builtin-providers.ts";

const homedirMock = vi.hoisted(() => vi.fn<() => string>());

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    default: { ...actual, homedir: homedirMock },
    homedir: homedirMock,
  };
});

function writeCodexAuth(home: string, contents: string): void {
  const directory = path.join(home, ".codex");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "auth.json"), contents, {
    mode: 0o600,
  });
}

function discoverCodexCredential() {
  ensureBuiltinSubscriptionAuthProviders();
  return getSubscriptionAuthProvider(
    "openai-codex",
  )?.detectExternalCredentials?.();
}

describe("built-in Codex CLI credential discovery", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.cwd(), ".auth-builtin-test-"));
    homedirMock.mockReturnValue(home);
    resetSubscriptionAuthProviders();
  });

  afterEach(() => {
    resetSubscriptionAuthProviders();
    homedirMock.mockReset();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["malformed JSON", "{"],
    ["missing token block", JSON.stringify({ auth_mode: "chatgpt" })],
    [
      "non-string access token",
      JSON.stringify({ tokens: { access_token: 42 } }),
    ],
    ["empty access token", JSON.stringify({ tokens: { access_token: " " } })],
  ])("surfaces a present %s login as invalid", (_name, contents) => {
    writeCodexAuth(home, contents);

    expect(discoverCodexCredential()).toMatchObject({
      accountId: "codex-cli",
      source: "codex-cli",
      configured: true,
      valid: false,
      expiresAt: null,
    });
  });

  it("surfaces a non-empty subscription token as valid", () => {
    writeCodexAuth(
      home,
      JSON.stringify({ tokens: { access_token: "chatgpt-oauth-token" } }),
    );

    expect(discoverCodexCredential()).toMatchObject({
      configured: true,
      valid: true,
    });
  });

  it("omits an absent auth file", () => {
    expect(discoverCodexCredential()).toBeNull();
  });

  it("omits a valid direct API-key-only login", () => {
    writeCodexAuth(
      home,
      JSON.stringify({ auth_mode: "api-key", OPENAI_API_KEY: "sk-fixture" }),
    );

    expect(discoverCodexCredential()).toBeNull();
  });
});
