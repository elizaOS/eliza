/** Exercises credential scanning, Chromium cookie decryption, and provider validation against a deterministic harness (temp homes, stubbed keychain/sqlite/fetch/spawn probes). */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "../logger";
import {
  readChromiumCookies,
  scanAndValidateProviderCredentials,
  scanProviderCredentials,
} from "./credentials";

vi.mock("../logger", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

interface FixtureCookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  expires_utc: number;
}

const fixtureCookieRowsByBrowser = new Map<string, FixtureCookieRow[]>();
const recordedCookieQueries: Array<{
  browser: string;
  host: unknown;
  names: unknown[];
}> = [];

vi.mock("node:module", () => ({
  createRequire: () => {
    const requireSpecifier = (specifier: string) => {
      if (specifier !== "bun:sqlite") {
        throw new Error(`unexpected require in test harness: ${specifier}`);
      }
      return {
        Database: class {
          browser: string;
          constructor(filename: string) {
            const match = /eliza-cookies-(.+)-\d+\.db$/.exec(filename);
            this.browser = match?.[1] ?? "";
          }
          query(): { all: (...params: unknown[]) => unknown[] } {
            const browser = this.browser;
            return {
              all: (...params: unknown[]) => {
                const [host, ...names] = params;
                recordedCookieQueries.push({
                  browser,
                  host,
                  names,
                });
                const rows = fixtureCookieRowsByBrowser.get(browser) ?? [];
                return rows.filter(
                  (row) =>
                    row.host_key === host &&
                    (names as string[]).includes(row.name),
                );
              },
            };
          }
          close(): void {}
        },
      };
    };
    return requireSpecifier;
  },
}));

type KeychainImpl = (
  service: string,
  account: string,
) => string | undefined | Promise<string | undefined>;

type Platform = typeof process.platform;

let keychainGetPassword: KeychainImpl = () => undefined;
let keychainCalls: Array<{ service: string; account: string }> = [];

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    service: string;
    account: string;
    constructor(service: string, account: string) {
      this.service = service;
      this.account = account;
    }
    async getPassword(): Promise<string | undefined> {
      const value = await keychainGetPassword(this.service, this.account);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    }
  },
}));

const CREDENTIAL_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "NEARAI_API_KEY",
  "ZAI_API_KEY",
  "OLLAMA_BASE_URL",
  "ELIZAOS_CLOUD_API_KEY",
] as const;

const originalPlatform = process.platform;
const originalFetch = globalThis.fetch;
const touchedEnv = new Map<string, string | undefined>();
const tempRoots: string[] = [];
const httpServers: http.Server[] = [];

interface FakeResponse {
  ok: boolean;
  status: number;
}

type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Promise<FakeResponse> | FakeResponse;

function setEnv(name: string, value: string | undefined): void {
  if (!touchedEnv.has(name)) {
    touchedEnv.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function stubFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (input: string, init?: RequestInit) =>
    handler(input, init)) as unknown as typeof fetch;
}

function stubCliProbe(installed: string[]): void {
  vi.stubGlobal("Bun", {
    spawn: (command: string[]) => {
      const exitCode = installed.includes(String(command[1])) ? 0 : 1;
      return { exited: Promise.resolve(exitCode), exitCode };
    },
  });
}

function setProcessPlatform(platform: Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function homeDir(): string {
  return path.join(tempRoots[0], "home");
}

function appSupport(): string {
  return path.join(homeDir(), "Library", "Application Support");
}

function writeHomeFile(relativePath: string, content: string): void {
  const absolute = path.join(homeDir(), relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

async function startOllamaServer(models: string[]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ollama fixture server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function encryptCookieValue(plainText: string, password: string): Buffer {
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0));
  return Buffer.concat([
    Buffer.from("v10", "ascii"),
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
}

const COOKIE_DB_RELATIVE_PATHS: Record<string, string> = {
  Chrome: path.join("Google", "Chrome", "Default", "Cookies"),
  Arc: path.join("Arc", "User Data", "Default", "Cookies"),
};

function installBrowserCookieDb(
  browser: string,
  rows: FixtureCookieRow[],
): void {
  const dbPath = path.join(appSupport(), COOKIE_DB_RELATIVE_PATHS[browser]);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "fixture-cookie-db");
  fixtureCookieRowsByBrowser.set(browser, rows);
}

function useKeychainPasswords(passwords: Record<string, string>): void {
  const base = keychainGetPassword;
  keychainGetPassword = (service, account) => {
    const recorded = base(service, account);
    return typeof recorded === "string" ? recorded : passwords[service];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "credentials-suite-"));
  tempRoots.push(tempRoot);
  fs.mkdirSync(path.join(tempRoot, "home"));
  fs.mkdirSync(path.join(tempRoot, "tmp"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(tempRoot, "home"));
  vi.spyOn(os, "tmpdir").mockReturnValue(path.join(tempRoot, "tmp"));
  keychainCalls = [];
  recordedCookieQueries.length = 0;
  fixtureCookieRowsByBrowser.clear();
  keychainGetPassword = (service, account) => {
    keychainCalls.push({ service, account });
    return undefined;
  };
  for (const name of CREDENTIAL_ENV_VARS) {
    setEnv(name, undefined);
  }
  setProcessPlatform("darwin");
  stubCliProbe([]);
  stubFetch(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  globalThis.fetch = originalFetch;
  setProcessPlatform(originalPlatform);
  for (const [name, value] of touchedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  touchedEnv.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("readChromiumCookies", () => {
  it("returns no cookies on non-macOS without probing the filesystem or keychain", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("value-a", "pw"),
        expires_utc: 1734000000000000,
      },
    ]);
    setProcessPlatform("linux");

    await expect(
      readChromiumCookies("example.com", ["session_a"]),
    ).resolves.toEqual([]);
    expect(keychainCalls).toEqual([]);
  });

  it("returns no cookies and skips the keychain when no browser database exists", async () => {
    await expect(
      readChromiumCookies("example.com", ["session_a"]),
    ).resolves.toEqual([]);
    expect(keychainCalls).toEqual([]);
  });

  it("decrypts v10 cookies for the requested host and names only", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("value-a", "chrome-pw"),
        expires_utc: 1734000000000001,
      },
      {
        host_key: "example.com",
        name: "session_b",
        encrypted_value: encryptCookieValue("value-b", "chrome-pw"),
        expires_utc: 1734000000000002,
      },
      {
        host_key: "other.com",
        name: "session_c",
        encrypted_value: encryptCookieValue("value-c", "chrome-pw"),
        expires_utc: 1734000000000003,
      },
      {
        host_key: "example.com",
        name: "unrelated",
        encrypted_value: encryptCookieValue("value-d", "chrome-pw"),
        expires_utc: 1734000000000004,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    const cookies = await readChromiumCookies("example.com", [
      "session_a",
      "session_b",
    ]);

    expect(cookies).toEqual([
      {
        name: "session_a",
        value: "value-a",
        browser: "Chrome",
        expiresUtc: 1734000000000001,
      },
      {
        name: "session_b",
        value: "value-b",
        browser: "Chrome",
        expiresUtc: 1734000000000002,
      },
    ]);
    expect(keychainCalls).toEqual([
      { service: "Chrome Safe Storage", account: "Chrome" },
    ]);
    expect(recordedCookieQueries).toEqual([
      {
        browser: "Chrome",
        host: "example.com",
        names: ["session_a", "session_b"],
      },
    ]);
  });

  it("uses a later browser when the first one has no database", async () => {
    installBrowserCookieDb("Arc", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("arc-value", "arc-pw"),
        expires_utc: 1734000000000005,
      },
    ]);
    useKeychainPasswords({ "Arc Safe Storage": "arc-pw" });

    const cookies = await readChromiumCookies("example.com", ["session_a"]);

    expect(cookies).toEqual([
      {
        name: "session_a",
        value: "arc-value",
        browser: "Arc",
        expiresUtc: 1734000000000005,
      },
    ]);
  });

  it("skips a browser whose keychain entry is absent and falls through to the next", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("chrome-value", "chrome-pw"),
        expires_utc: 1734000000000006,
      },
    ]);
    installBrowserCookieDb("Arc", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("arc-value", "arc-pw"),
        expires_utc: 1734000000000007,
      },
    ]);
    useKeychainPasswords({ "Arc Safe Storage": "arc-pw" });

    const cookies = await readChromiumCookies("example.com", ["session_a"]);

    expect(cookies.map((cookie) => cookie.browser)).toEqual(["Arc"]);
    expect(keychainCalls.map((call) => call.account)).toEqual([
      "Chrome",
      "Arc",
    ]);
  });

  it("degrades a throwing keychain binding to a skipped browser with a warning", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("chrome-value", "chrome-pw"),
        expires_utc: 1734000000000008,
      },
    ]);
    installBrowserCookieDb("Arc", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("arc-value", "arc-pw"),
        expires_utc: 1734000000000009,
      },
    ]);
    keychainGetPassword = (service) => {
      if (service === "Chrome Safe Storage") {
        throw new Error("keychain locked");
      }
      return "arc-pw";
    };

    const cookies = await readChromiumCookies("example.com", ["session_a"]);

    expect(cookies.map((cookie) => cookie.value)).toEqual(["arc-value"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[credentials] Failed to read Chrome keychain key:",
      expect.objectContaining({ message: "keychain locked" }),
    );
  });

  it("keeps the first browser with matching cookies even when later browsers match too", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("chrome-value", "chrome-pw"),
        expires_utc: 1734000000000010,
      },
    ]);
    installBrowserCookieDb("Arc", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("arc-value", "arc-pw"),
        expires_utc: 1734000000000011,
      },
    ]);
    useKeychainPasswords({
      "Chrome Safe Storage": "chrome-pw",
      "Arc Safe Storage": "arc-pw",
    });

    const cookies = await readChromiumCookies("example.com", ["session_a"]);

    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.browser).toBe("Chrome");
    expect(cookies[0]?.value).toBe("chrome-value");
  });

  it("omits rows whose ciphertext is not decodable", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "too_short",
        encrypted_value: Buffer.from("abc", "ascii"),
        expires_utc: 1,
      },
      {
        host_key: "example.com",
        name: "wrong_version",
        encrypted_value: Buffer.concat([
          Buffer.from("v20", "ascii"),
          encryptCookieValue("x", "chrome-pw").subarray(3),
        ]),
        expires_utc: 2,
      },
      {
        host_key: "example.com",
        name: "malformed_block",
        encrypted_value: Buffer.concat([
          Buffer.from("v10", "ascii"),
          Buffer.from([1, 2, 3, 4, 5]),
        ]),
        expires_utc: 3,
      },
      {
        host_key: "example.com",
        name: "empty_plain_text",
        encrypted_value: encryptCookieValue("", "chrome-pw"),
        expires_utc: 4,
      },
      {
        host_key: "example.com",
        name: "session_ok",
        encrypted_value: encryptCookieValue("kept", "chrome-pw"),
        expires_utc: 5,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    const cookies = await readChromiumCookies("example.com", [
      "too_short",
      "wrong_version",
      "malformed_block",
      "empty_plain_text",
      "session_ok",
    ]);

    expect(cookies).toEqual([
      {
        name: "session_ok",
        value: "kept",
        browser: "Chrome",
        expiresUtc: 5,
      },
    ]);
  });

  it("returns no cookies when the requested name list is empty", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("value-a", "chrome-pw"),
        expires_utc: 6,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    await expect(readChromiumCookies("example.com", [])).resolves.toEqual([]);
    expect(recordedCookieQueries).toEqual([
      { browser: "Chrome", host: "example.com", names: [] },
    ]);
  });

  it("removes its temporary database copy after a successful read", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("value-a", "chrome-pw"),
        expires_utc: 7,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    await readChromiumCookies("example.com", ["session_a"]);

    const leftovers = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("eliza-cookies-"));
    expect(leftovers).toEqual([]);
  });

  it("still returns cookies when temporary cleanup fails", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("value-a", "chrome-pw"),
        expires_utc: 8,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw new Error("EBUSY");
    });

    await expect(
      readChromiumCookies("example.com", ["session_a"]),
    ).resolves.toEqual([
      {
        name: "session_a",
        value: "value-a",
        browser: "Chrome",
        expiresUtc: 8,
      },
    ]);
  });

  it("falls through to later browsers when copying the database fails", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("chrome-value", "chrome-pw"),
        expires_utc: 9,
      },
    ]);
    installBrowserCookieDb("Arc", [
      {
        host_key: "example.com",
        name: "session_a",
        encrypted_value: encryptCookieValue("arc-value", "arc-pw"),
        expires_utc: 10,
      },
    ]);
    useKeychainPasswords({
      "Chrome Safe Storage": "chrome-pw",
      "Arc Safe Storage": "arc-pw",
    });
    const originalCopyFileSync = fs.copyFileSync.bind(fs);
    vi.spyOn(fs, "copyFileSync").mockImplementation(
      (source: fs.PathLike, destination: fs.PathLike) => {
        if (String(source).includes("Chrome")) {
          throw new Error("database locked");
        }
        return originalCopyFileSync(source, destination);
      },
    );

    const cookies = await readChromiumCookies("example.com", ["session_a"]);

    expect(cookies.map((cookie) => cookie.browser)).toEqual(["Arc"]);
  });
});

describe("scanProviderCredentials", () => {
  it("detects nothing with an empty home, no environment, and Ollama down", async () => {
    await expect(scanProviderCredentials()).resolves.toEqual([]);
  });

  it("detects codex api-key credentials and probes the CLI", async () => {
    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({
        OPENAI_API_KEY: "sk-codex-1234567890",
        auth_mode: " api-key ",
      }),
    );
    stubCliProbe(["codex"]);

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "openai",
        source: "codex-auth",
        apiKey: "****7890",
        authMode: "api-key",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("maps non-api-key codex auth modes to the subscription provider", async () => {
    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({
        OPENAI_API_KEY: "sk-codex-abcdef42",
        auth_mode: "chatgpt",
      }),
    );

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "openai-subscription",
        source: "codex-auth",
        apiKey: "****ef42",
        authMode: "chatgpt",
        cliInstalled: false,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("defaults missing or blank codex auth modes to api-key", async () => {
    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({ OPENAI_API_KEY: "sk-codex-default-key" }),
    );

    const providers = await scanProviderCredentials();

    expect(providers[0]?.id).toBe("openai");
    expect(providers[0]?.authMode).toBe("api-key");

    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({
        OPENAI_API_KEY: "sk-codex-blank-mode",
        auth_mode: "   ",
      }),
    );
    const blankMode = await scanProviderCredentials();

    expect(blankMode[0]?.id).toBe("openai");
    expect(blankMode[0]?.authMode).toBe("api-key");
  });

  it("ignores codex files without an API key", async () => {
    writeHomeFile(".codex/auth.json", JSON.stringify({ auth_mode: "chatgpt" }));

    await expect(scanProviderCredentials()).resolves.toEqual([]);
  });

  it("extracts the claude oauth token from direct and deeply nested shapes", async () => {
    stubCliProbe(["claude"]);
    writeHomeFile(
      ".claude/.credentials.json",
      JSON.stringify({
        claudeAiOauth: { accessToken: "  direct-claude-token-7777  " },
      }),
    );

    const direct = await scanProviderCredentials();

    expect(direct).toEqual([
      {
        id: "anthropic-subscription",
        source: "claude-credentials",
        apiKey: "****7777",
        authMode: "oauth",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);

    writeHomeFile(
      ".claude/.credentials.json",
      JSON.stringify({
        legacy: [
          null,
          { note: "skip" },
          { session: { access_token: "nestedtoken9999" } },
        ],
      }),
    );

    const nested = await scanProviderCredentials();

    expect(nested).toEqual([
      {
        id: "anthropic-subscription",
        source: "claude-credentials",
        apiKey: "****9999",
        authMode: "oauth",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("ignores whitespace-only claude oauth tokens", async () => {
    writeHomeFile(
      ".claude/.credentials.json",
      JSON.stringify({ claudeAiOauth: { accessToken: "     " } }),
    );

    await expect(scanProviderCredentials()).resolves.toEqual([]);
  });

  it("picks the first copilot host with a usable token and skips blank ones", async () => {
    writeHomeFile(
      ".config/github-copilot/hosts.json",
      JSON.stringify({
        "github.com": { oauth_token: "    " },
        "gist.github.com": { oauth_token: " copilot-token-0042 " },
      }),
    );
    stubCliProbe(["gh"]);

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "openai-subscription",
        source: "copilot-hosts",
        apiKey: "****0042",
        authMode: "oauth",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("lets codex win over copilot when both map to openai-subscription", async () => {
    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({
        OPENAI_API_KEY: "sk-codex-wins-9999",
        auth_mode: "chatgpt",
      }),
    );
    writeHomeFile(
      ".config/github-copilot/hosts.json",
      JSON.stringify({
        "github.com": { oauth_token: "copilot-token-1111" },
      }),
    );

    const providers = await scanProviderCredentials();

    expect(providers).toHaveLength(1);
    expect(providers[0]?.source).toBe("codex-auth");
    expect(providers[0]?.apiKey).toBe("****9999");
  });

  it("prefers gemini settings over gcloud ADC and falls back only when blank", async () => {
    stubCliProbe(["gemini", "gcloud"]);
    writeHomeFile(
      ".config/gemini/settings.json",
      JSON.stringify({ apiKey: " gemini-settings-key-abcd " }),
    );
    writeHomeFile(
      ".config/gcloud/application_default_credentials.json",
      JSON.stringify({ refresh_token: "adc-refresh-token-7777" }),
    );

    const withSettings = await scanProviderCredentials();

    expect(withSettings).toEqual([
      {
        id: "gemini",
        source: "gemini-cli",
        apiKey: "****abcd",
        authMode: "api-key",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);

    writeHomeFile(".config/gemini/settings.json", JSON.stringify({}));
    const withAdc = await scanProviderCredentials();

    expect(withAdc).toEqual([
      {
        id: "gemini",
        source: "gcloud-adc",
        apiKey: "****7777",
        authMode: "oauth",
        cliInstalled: true,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("reports a running ollama server with singular and plural model counts", async () => {
    globalThis.fetch = originalFetch;
    for (const [models, expectedDetail] of [
      [[], "0 models available"],
      [["m1"], "1 model available"],
      [["m1", "m2"], "2 models available"],
    ] as const) {
      const server = await startOllamaServer([...models]);
      setEnv("OLLAMA_BASE_URL", server.url);
      try {
        const providers = await scanProviderCredentials();

        expect(providers).toEqual([
          {
            id: "ollama",
            source: "local-server",
            authMode: "local",
            apiKey: undefined,
            cliInstalled: true,
            status: "valid",
            statusDetail: expectedDetail,
          },
        ]);
      } finally {
        await server.close();
      }
    }
  });

  it("reports installed-but-stopped ollama and nothing when the CLI is absent", async () => {
    stubCliProbe(["ollama"]);

    const installed = await scanProviderCredentials();

    expect(installed).toEqual([
      {
        id: "ollama",
        source: "cli-installed",
        authMode: "local",
        apiKey: undefined,
        cliInstalled: true,
        status: "unchecked",
        statusDetail: "Ollama installed but not running",
      },
    ]);

    stubCliProbe([]);
    const absent = await scanProviderCredentials();

    expect(absent).toEqual([]);
  });

  it("imports the eliza cloud session from the first hostname that holds privy-session", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "eliza.app",
        name: "privy-session",
        encrypted_value: encryptCookieValue("session-token", "chrome-pw"),
        expires_utc: 11,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "elizacloud",
        source: "browser-session",
        authMode: "oauth",
        apiKey: undefined,
        cliInstalled: false,
        status: "unchecked",
        statusDetail: "Logged in via browser",
      },
    ]);
    expect(keychainCalls).toEqual([
      { service: "Chrome Safe Storage", account: "Chrome" },
    ]);
  });

  it("does not report a cloud session for unrelated cookies on any hostname", async () => {
    installBrowserCookieDb("Chrome", [
      {
        host_key: "example.com",
        name: "unrelated-cookie",
        encrypted_value: encryptCookieValue("value", "chrome-pw"),
        expires_utc: 12,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([]);
    expect(keychainCalls).toHaveLength(3);
  });

  it("scans environment credentials with trimming and first-match gemini aliases", async () => {
    setEnv("OPENAI_API_KEY", " env-openai-9999 ");
    setEnv("GOOGLE_GENERATIVE_AI_API_KEY", "g-gen-0001");
    setEnv("GOOGLE_API_KEY", "g-api-0002");
    setEnv("GROQ_API_KEY", "   ");

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "openai",
        source: "env",
        apiKey: "****9999",
        authMode: "api-key",
        cliInstalled: false,
        status: "unchecked",
        statusDetail: undefined,
      },
      {
        id: "gemini",
        source: "env",
        apiKey: "****0001",
        authMode: "api-key",
        cliInstalled: false,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);
  });

  it("fills the ollama gap from the environment when the server is down", async () => {
    setEnv("OLLAMA_BASE_URL", " http://127.0.0.1:11434 ");

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "ollama",
        source: "env",
        apiKey: "****1434",
        authMode: "local",
        cliInstalled: false,
        status: "unchecked",
      },
    ]);
  });

  it("masks short keys completely and longer keys down to their last four characters", async () => {
    setEnv("XAI_API_KEY", "abcd");

    const shortKey = await scanProviderCredentials();

    expect(shortKey).toEqual([
      {
        id: "grok",
        source: "env",
        apiKey: "****",
        authMode: "api-key",
        cliInstalled: false,
        status: "unchecked",
        statusDetail: undefined,
      },
    ]);

    setEnv("XAI_API_KEY", "abcdefgh");
    const longerKey = await scanProviderCredentials();

    expect(longerKey[0]?.apiKey).toBe("****efgh");
  });

  it("gives file sources priority over browser sessions and environment values", async () => {
    setEnv("OPENAI_API_KEY", "env-openai-key");
    setEnv("ELIZAOS_CLOUD_API_KEY", "env-cloud-key");
    writeHomeFile(
      ".codex/auth.json",
      JSON.stringify({ OPENAI_API_KEY: "sk-codex-file-5555" }),
    );
    installBrowserCookieDb("Chrome", [
      {
        host_key: "eliza.app",
        name: "privy-session",
        encrypted_value: encryptCookieValue("session-token", "chrome-pw"),
        expires_utc: 13,
      },
    ]);
    useKeychainPasswords({ "Chrome Safe Storage": "chrome-pw" });

    const providers = await scanProviderCredentials();

    expect(providers).toEqual([
      {
        id: "openai",
        source: "codex-auth",
        apiKey: "****5555",
        authMode: "api-key",
        cliInstalled: false,
        status: "unchecked",
        statusDetail: undefined,
      },
      {
        id: "elizacloud",
        source: "browser-session",
        authMode: "oauth",
        apiKey: undefined,
        cliInstalled: false,
        status: "unchecked",
        statusDetail: "Logged in via browser",
      },
    ]);
  });
});

describe("scanAndValidateProviderCredentials", () => {
  function recordValidationCalls(
    respondForModelEndpoint: (
      url: string,
    ) => Promise<FakeResponse> | FakeResponse,
  ): Array<{ url: string; headers: Record<string, unknown> }> {
    const calls: Array<{ url: string; headers: Record<string, unknown> }> = [];
    stubFetch(async (url, init) => {
      if (url.includes("/api/tags")) {
        throw new Error("connect ECONNREFUSED");
      }
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, unknown>,
      });
      return respondForModelEndpoint(url);
    });
    return calls;
  }

  it("validates openai with the raw key in the Authorization header and returns a masked valid result", async () => {
    const calls = recordValidationCalls(() => ({ ok: true, status: 200 }));
    setEnv("OPENAI_API_KEY", "sk-live-1234567890");

    const providers = await scanAndValidateProviderCredentials();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.Authorization).toBe("Bearer sk-live-1234567890");
    expect(providers).toEqual([
      {
        id: "openai",
        source: "env",
        apiKey: "****7890",
        authMode: "api-key",
        cliInstalled: false,
        status: "valid",
        statusDetail: undefined,
      },
    ]);
  });

  it("maps rejection statuses onto invalid and error outcomes", async () => {
    const cases = [
      { status: 401, outcome: "invalid", detail: "API key rejected" },
      { status: 403, outcome: "invalid", detail: "API key rejected" },
      { status: 500, outcome: "error", detail: "HTTP 500" },
      { status: 429, outcome: "error", detail: "HTTP 429" },
    ];

    for (const testCase of cases) {
      setEnv("OPENAI_API_KEY", "sk-fixed-masked-9012");
      recordValidationCalls(() => ({
        ok: false,
        status: testCase.status,
      }));

      const providers = await scanAndValidateProviderCredentials();

      expect(providers).toEqual([
        {
          id: "openai",
          source: "env",
          apiKey: "****9012",
          authMode: "api-key",
          cliInstalled: false,
          status: testCase.outcome,
          statusDetail: testCase.detail,
        },
      ]);
      setEnv("OPENAI_API_KEY", undefined);
    }
  });

  it("surfaces thrown fetch errors including non-Error rejections", async () => {
    stubFetch(async (url) => {
      if (url.includes("/api/tags")) {
        throw new Error("connect ECONNREFUSED");
      }
      throw new Error("validation boom");
    });
    setEnv("OPENAI_API_KEY", "sk-throwing-key");

    const thrownError = await scanAndValidateProviderCredentials();

    expect(thrownError[0]?.status).toBe("error");
    expect(thrownError[0]?.statusDetail).toBe("validation boom");

    stubFetch(async (url) => {
      if (url.includes("/api/tags")) {
        throw new Error("connect ECONNREFUSED");
      }
      throw "not-an-error";
    });

    const thrownString = await scanAndValidateProviderCredentials();

    expect(thrownString[0]?.status).toBe("error");
    expect(thrownString[0]?.statusDetail).toBe("Unknown error");
  });

  it("leaves oauth, local, and endpoint-less providers unchecked without network validation", async () => {
    const calls = recordValidationCalls(() => ({ ok: true, status: 200 }));
    writeHomeFile(
      ".claude/.credentials.json",
      JSON.stringify({
        claudeAiOauth: { accessToken: "oauth-claude-token-8888" },
      }),
    );
    setEnv("ELIZAOS_CLOUD_API_KEY", "cloud-key-1234");
    setEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");

    const providers = await scanAndValidateProviderCredentials();

    expect(
      providers.find((provider) => provider.id === "anthropic-subscription"),
    ).toMatchObject({
      status: "unchecked",
      apiKey: "****8888",
      authMode: "oauth",
    });
    expect(
      providers.find((provider) => provider.id === "elizacloud"),
    ).toMatchObject({
      status: "unchecked",
      source: "env",
    });
    expect(
      providers.find((provider) => provider.id === "ollama"),
    ).toMatchObject({
      status: "unchecked",
      source: "env",
    });
    expect(calls).toEqual([]);
  });

  it("validates multiple api-key providers concurrently regardless of completion order", async () => {
    setEnv("OPENAI_API_KEY", "sk-openai-1111");
    setEnv("GROQ_API_KEY", "groq-key-2222");
    setEnv("DEEPSEEK_API_KEY", "deepseek-key-3333");
    const calls: Array<{ url: string; headers: Record<string, unknown> }> = [];
    stubFetch(async (url, init) => {
      if (url.includes("/api/tags")) {
        throw new Error("connect ECONNREFUSED");
      }
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, unknown>,
      });
      if (url === "https://api.openai.com/v1/models") {
        return { ok: false, status: 401 };
      }
      if (url === "https://api.groq.com/openai/v1/models") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ok: true, status: 200 };
      }
      return { ok: false, status: 503 };
    });

    const providers = await scanAndValidateProviderCredentials();

    expect(
      providers.find((provider) => provider.id === "openai"),
    ).toMatchObject({
      status: "invalid",
      statusDetail: "API key rejected",
      apiKey: "****1111",
    });
    expect(providers.find((provider) => provider.id === "groq")).toMatchObject({
      status: "valid",
      apiKey: "****2222",
    });
    expect(
      providers.find((provider) => provider.id === "deepseek"),
    ).toMatchObject({
      status: "error",
      statusDetail: "HTTP 503",
      apiKey: "****3333",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.openai.com/v1/models",
      "https://api.groq.com/openai/v1/models",
      "https://api.deepseek.com/models",
    ]);
    expect(calls.find((call) => call.url.includes("groq"))?.headers).toEqual({
      Authorization: "Bearer groq-key-2222",
    });
  });
});
