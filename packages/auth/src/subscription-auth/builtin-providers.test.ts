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

  it("reports an unreadable auth file as present-but-invalid, not absent", () => {
    // A credential file the user cannot read is the sharpest "present but
    // broken" case there is. Collapsing it into `absent` hides the Codex row
    // entirely, so the user sees nothing rather than something to fix.
    const directory = path.join(home, ".codex");
    fs.mkdirSync(directory, { recursive: true });
    const authPath = path.join(directory, "auth.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({ tokens: { access_token: "t" } }),
    );
    fs.chmodSync(authPath, 0o000);
    // Root ignores the mode bits, so only assert where the chmod actually bites.
    let readable = true;
    try {
      fs.readFileSync(authPath, "utf-8");
    } catch {
      readable = false;
    }
    if (readable) return;

    expect(discoverCodexCredential()).toMatchObject({
      source: "codex-cli",
      configured: true,
      valid: false,
    });
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

  it.each(["apikey", "api-key"])(
    "omits a valid direct API-key-only login using %s auth mode",
    (authMode) => {
      writeCodexAuth(
        home,
        JSON.stringify({
          auth_mode: authMode,
          OPENAI_API_KEY: "sk-fixture",
        }),
      );

      expect(discoverCodexCredential()).toBeNull();
    },
  );
});

describe("built-in Gemini CLI credential discovery", () => {
  beforeEach(() => {
    resetSubscriptionAuthProviders();
  });

  afterEach(() => {
    resetSubscriptionAuthProviders();
  });

  it("reports Gemini CLI as configured when the binary is present on PATH", () => {
    const tempBin = fs.mkdtempSync(
      path.join(process.cwd(), ".gemini-bin-test-"),
    );
    const originalPath = process.env.PATH;
    try {
      const geminiScript = path.join(tempBin, "gemini");
      fs.writeFileSync(geminiScript, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.PATH = `${tempBin}:${originalPath ?? ""}`;

      ensureBuiltinSubscriptionAuthProviders();
      const detected =
        getSubscriptionAuthProvider(
          "gemini-cli",
        )?.detectExternalCredentials?.();

      expect(detected).toEqual({
        accountId: "gemini-cli",
        label: "Gemini CLI",
        source: "gemini-cli",
        configured: true,
        valid: true,
        expiresAt: null,
      });
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempBin, { recursive: true, force: true });
    }
  });

  it("reports Gemini CLI as unconfigured when the binary is absent from PATH", () => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-path-for-gemini-test";

      ensureBuiltinSubscriptionAuthProviders();
      const detected =
        getSubscriptionAuthProvider(
          "gemini-cli",
        )?.detectExternalCredentials?.();

      expect(detected).toEqual({
        accountId: "gemini-cli",
        label: "Gemini CLI",
        source: null,
        configured: false,
        valid: false,
        expiresAt: null,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("built-in DeepSeek Coding Plan provider descriptor", () => {
  beforeEach(() => {
    resetSubscriptionAuthProviders();
  });

  afterEach(() => {
    resetSubscriptionAuthProviders();
  });

  it("surfaces a static unavailable credential record", () => {
    ensureBuiltinSubscriptionAuthProviders();
    const descriptor = getSubscriptionAuthProvider("deepseek-coding");

    expect(descriptor).toBeDefined();
    expect(descriptor?.id).toBe("deepseek-coding");
    expect(descriptor?.detectExternalCredentials?.()).toEqual({
      accountId: "deepseek-coding",
      label: "DeepSeek Coding Plan",
      source: "unavailable",
      configured: false,
      valid: false,
      expiresAt: null,
    });
  });
});

describe("ensureBuiltinSubscriptionAuthProviders registration idempotency", () => {
  beforeEach(() => {
    resetSubscriptionAuthProviders();
  });

  afterEach(() => {
    resetSubscriptionAuthProviders();
  });

  it("registers all three built-in providers and does not overwrite custom registrations", () => {
    expect(getSubscriptionAuthProvider("openai-codex")).toBeUndefined();
    expect(getSubscriptionAuthProvider("gemini-cli")).toBeUndefined();
    expect(getSubscriptionAuthProvider("deepseek-coding")).toBeUndefined();

    ensureBuiltinSubscriptionAuthProviders();

    expect(getSubscriptionAuthProvider("openai-codex")).toBeDefined();
    expect(getSubscriptionAuthProvider("gemini-cli")).toBeDefined();
    expect(getSubscriptionAuthProvider("deepseek-coding")).toBeDefined();

    // Calling again does not throw or mutate registry state
    ensureBuiltinSubscriptionAuthProviders();
    expect(getSubscriptionAuthProvider("openai-codex")?.id).toBe(
      "openai-codex",
    );
  });
});
