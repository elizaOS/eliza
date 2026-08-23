/**
 * Behavioral unit tests for the helpers defined in `eliza.ts` that have no
 * same-named coverage file: vision/wallet settings, Groq OpenAI-compat
 * normalization, x402 env projection, PGlite lock/recovery classification,
 * stale pid cleanup, connector env mirroring, shutdown, and the chat log
 * relay. Drives the real module. Deterministic — no live runtime, network, or
 * database.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntime, LogEntry } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  applyConnectorSecretsToEnv,
  applyX402ConfigToEnv,
  autoResolveDiscordAppId,
  buildRuntimeSettings,
  cleanStalePglitePid,
  configureLocalEmbeddingEnvEarlyIfNeeded,
  getPgliteRecoveryAction,
  isFatalPgliteStartupError,
  isRecoverablePgliteInitError,
  logToChatListener,
  normalizeOpenAiCompatibleProviderConfig,
  type ResolvedPlugin,
  resolveRuntimeProviderName,
  resolveVisionModeSetting,
  resolveWalletRuntimeSettings,
  shutdownRuntime,
} from "./eliza.ts";
import { PGLITE_ERROR_CODES, PgliteInitError } from "./pglite-error-compat.ts";

const WALLET_ENV_KEYS = [
  "SOLANA_PUBLIC_KEY",
  "WALLET_PUBLIC_KEY",
  "SOLANA_PRIVATE_KEY",
  "SOLANA_RPC_URL",
  "SOLANA_NO_ACTIONS",
  "STEWARD_SOLANA_ADDRESS",
  "ELIZA_MANAGED_SOLANA_ADDRESS",
  "WALLET_SOURCE_SOLANA",
] as const;

const CONNECTOR_ENV_KEYS = [
  "DISCORD_API_TOKEN",
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_SYNC_PROFILE",
  "TELEGRAM_BOT_TOKEN",
  "WHATSAPP_AUTH_DIR",
  "WHATSAPP_ALLOW_FROM",
  "WHATSAPP_GROUP_ALLOW_FROM",
  "WHATSAPP_DM_POLICY",
] as const;

const X402_ENV_KEYS = [
  "X402_ENABLED",
  "X402_API_KEY",
  "X402_BASE_URL",
] as const;

const EMBEDDING_ENV_KEYS = [
  "NODE_ENV",
  "EMBEDDING_PROVIDER",
  "LOCAL_EMBEDDING_MODEL",
] as const;

let savedEnv: Record<string, string | undefined>;

function snapshotEnv(keys: readonly string[]): void {
  savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
}

function restoreEnv(keys: readonly string[]): void {
  for (const key of keys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function emptyConfig(): ElizaConfig {
  return {} as ElizaConfig;
}

function pidPath(dir: string): string {
  return path.join(dir, "postmaster.pid");
}

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "eliza-pglite-"));
}

describe("resolveVisionModeSetting", () => {
  it("prefers a trimmed VISION_MODE env value over config", () => {
    const config = { features: { vision: true } } as ElizaConfig;
    expect(
      resolveVisionModeSetting(config, { VISION_MODE: "  CAMERA  " }),
    ).toBe("CAMERA");
  });

  it("returns OFF when vision is enabled and no env mode is set", () => {
    const config = { features: { vision: true } } as ElizaConfig;
    expect(resolveVisionModeSetting(config, {})).toBe("OFF");
  });

  it("returns undefined when vision is not enabled and env is blank", () => {
    expect(resolveVisionModeSetting(emptyConfig(), {})).toBeUndefined();
    expect(
      resolveVisionModeSetting(emptyConfig(), { VISION_MODE: "   " }),
    ).toBeUndefined();
    expect(
      resolveVisionModeSetting({ features: { vision: false } } as ElizaConfig, {
        VISION_MODE: "",
      }),
    ).toBeUndefined();
  });
});

describe("resolveWalletRuntimeSettings", () => {
  beforeEach(() => {
    snapshotEnv(WALLET_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(WALLET_ENV_KEYS);
  });

  it("returns an empty map when no wallet fields are present", () => {
    expect(resolveWalletRuntimeSettings(emptyConfig(), {})).toEqual({});
  });

  it("projects RPC and no-actions without a public key", () => {
    expect(
      resolveWalletRuntimeSettings(emptyConfig(), {
        SOLANA_RPC_URL: " https://rpc.example ",
        SOLANA_NO_ACTIONS: " 1 ",
      }),
    ).toEqual({
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_NO_ACTIONS: "1",
    });
  });

  it("prefers SOLANA_PUBLIC_KEY over WALLET_PUBLIC_KEY and config vars", () => {
    const config = {
      env: {
        vars: {
          SOLANA_PUBLIC_KEY: "config-vars-key",
          WALLET_PUBLIC_KEY: "config-wallet-key",
        },
        SOLANA_PUBLIC_KEY: "config-env-key",
      },
    } as ElizaConfig;
    expect(
      resolveWalletRuntimeSettings(config, {
        SOLANA_PUBLIC_KEY: " env-solana ",
        WALLET_PUBLIC_KEY: "env-wallet",
      }),
    ).toEqual({
      SOLANA_PUBLIC_KEY: "env-solana",
      WALLET_PUBLIC_KEY: "env-solana",
    });
  });

  it("falls back to WALLET_PUBLIC_KEY then config.env.vars", () => {
    expect(
      resolveWalletRuntimeSettings(emptyConfig(), {
        WALLET_PUBLIC_KEY: "wallet-only",
      }),
    ).toEqual({
      SOLANA_PUBLIC_KEY: "wallet-only",
      WALLET_PUBLIC_KEY: "wallet-only",
    });

    expect(
      resolveWalletRuntimeSettings(
        {
          env: { vars: { WALLET_PUBLIC_KEY: "from-vars" } },
        } as ElizaConfig,
        {},
      ),
    ).toEqual({
      SOLANA_PUBLIC_KEY: "from-vars",
      WALLET_PUBLIC_KEY: "from-vars",
    });
  });

  it("ignores whitespace-only keys and a non-object config.env.vars bag", () => {
    expect(
      resolveWalletRuntimeSettings(
        {
          env: { vars: "not-an-object", SOLANA_PUBLIC_KEY: "   " },
        } as unknown as ElizaConfig,
        { SOLANA_PUBLIC_KEY: "  " },
      ),
    ).toEqual({});
  });
});

describe("buildRuntimeSettings", () => {
  beforeEach(() => {
    snapshotEnv(WALLET_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(WALLET_ENV_KEYS);
  });

  it("includes wallet settings projected from the supplied env", () => {
    const settings = buildRuntimeSettings(emptyConfig(), {
      env: { SOLANA_PUBLIC_KEY: "boot-wallet", SECRET_SALT: "salt" },
    });
    expect(settings.SOLANA_PUBLIC_KEY).toBe("boot-wallet");
    expect(settings.WALLET_PUBLIC_KEY).toBe("boot-wallet");
  });
});

describe("resolveRuntimeProviderName", () => {
  const plugins = [
    {
      name: "@elizaos/plugin-openai",
      plugin: { name: " openai " },
    },
    {
      name: "@elizaos/plugin-blank",
      plugin: { name: "   " },
    },
  ] as unknown as readonly ResolvedPlugin[];

  it("returns undefined for a missing package name, empty queue, or unknown plugin", () => {
    expect(resolveRuntimeProviderName(plugins, undefined)).toBeUndefined();
    expect(resolveRuntimeProviderName(plugins, "")).toBeUndefined();
    expect(
      resolveRuntimeProviderName([], "@elizaos/plugin-openai"),
    ).toBeUndefined();
    expect(
      resolveRuntimeProviderName(plugins, "@elizaos/plugin-missing"),
    ).toBeUndefined();
  });

  it("trims the resolved plugin name and treats blank names as missing", () => {
    expect(resolveRuntimeProviderName(plugins, "@elizaos/plugin-openai")).toBe(
      "openai",
    );
    expect(
      resolveRuntimeProviderName(plugins, "@elizaos/plugin-blank"),
    ).toBeUndefined();
  });
});

describe("applyX402ConfigToEnv", () => {
  beforeEach(() => {
    snapshotEnv(X402_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(X402_ENV_KEYS);
  });

  it("is a no-op when x402 is missing or disabled", () => {
    applyX402ConfigToEnv(emptyConfig());
    applyX402ConfigToEnv({
      x402: { enabled: false, apiKey: "k" },
    } as ElizaConfig);
    expect(process.env.X402_ENABLED).toBeUndefined();
    expect(process.env.X402_API_KEY).toBeUndefined();
  });

  it("sets missing x402 env from config and does not overwrite existing values", () => {
    process.env.X402_ENABLED = "already";
    process.env.X402_API_KEY = "existing-key";
    applyX402ConfigToEnv({
      x402: {
        enabled: true,
        apiKey: "config-key",
        baseUrl: "https://x402.example",
      },
    } as ElizaConfig);
    expect(process.env.X402_ENABLED).toBe("already");
    expect(process.env.X402_API_KEY).toBe("existing-key");
    expect(process.env.X402_BASE_URL).toBe("https://x402.example");
  });

  it("enables x402 and copies apiKey when env is empty", () => {
    applyX402ConfigToEnv({
      x402: { enabled: true, apiKey: "fresh-key" },
    } as ElizaConfig);
    expect(process.env.X402_ENABLED).toBe("true");
    expect(process.env.X402_API_KEY).toBe("fresh-key");
    expect(process.env.X402_BASE_URL).toBeUndefined();
  });
});

describe("applyConnectorSecretsToEnv", () => {
  beforeEach(() => {
    snapshotEnv(CONNECTOR_ENV_KEYS);
  });

  afterEach(() => {
    restoreEnv(CONNECTOR_ENV_KEYS);
  });

  it("skips missing, non-object, unknown, and vault-ref connector entries", () => {
    applyConnectorSecretsToEnv({
      connectors: {
        telegram: null,
        slack: "token",
        unknownChannel: { token: "nope" },
        discord: { token: "vault://connectors.discord.token" },
      },
    } as unknown as ElizaConfig);
    expect(process.env.DISCORD_API_TOKEN).toBeUndefined();
    expect(process.env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(process.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("mirrors discord botToken to both env names and stringifies numbers/booleans", () => {
    applyConnectorSecretsToEnv({
      connectors: {
        discord: { botToken: "bot-token", syncProfile: true },
        telegram: { botToken: 1234 },
      },
    } as ElizaConfig);
    expect(process.env.DISCORD_API_TOKEN).toBe("bot-token");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("bot-token");
    expect(process.env.DISCORD_SYNC_PROFILE).toBe("true");
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("1234");
  });

  it("joins WhatsApp allow-lists and takes the first enabled account authDir", () => {
    applyConnectorSecretsToEnv({
      connectors: {
        whatsapp: {
          allowFrom: ["  +1555  ", "", "  +1666 "],
          groupAllowFrom: ["   "],
          dmPolicy: "allowlist",
          accounts: {
            disabled: { enabled: false, authDir: "/tmp/disabled" },
            empty: "skip",
            live: { authDir: "  /tmp/whatsapp-live  " },
          },
        },
      },
    } as ElizaConfig);
    expect(process.env.WHATSAPP_ALLOW_FROM).toBe("+1555,+1666");
    expect(process.env.WHATSAPP_GROUP_ALLOW_FROM).toBeUndefined();
    expect(process.env.WHATSAPP_DM_POLICY).toBe("allowlist");
    expect(process.env.WHATSAPP_AUTH_DIR).toBe("/tmp/whatsapp-live");
  });

  it("falls back to config.channels when connectors is absent", () => {
    applyConnectorSecretsToEnv({
      channels: { telegram: { botToken: "legacy-token" } },
    } as ElizaConfig);
    expect(process.env.TELEGRAM_BOT_TOKEN).toBe("legacy-token");
  });
});

describe("normalizeOpenAiCompatibleProviderConfig", () => {
  it("returns false when cloud inference is enabled", () => {
    const config = {
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig;
    const env: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_API_KEY: "gsk_cloud",
    };
    expect(normalizeOpenAiCompatibleProviderConfig(config, env)).toBe(false);
    expect(env.OPENAI_BASE_URL).toBe("https://api.groq.com/openai/v1");
  });

  it("returns false without a Groq base URL or Groq-shaped key", () => {
    expect(normalizeOpenAiCompatibleProviderConfig(emptyConfig(), {})).toBe(
      false,
    );
    expect(
      normalizeOpenAiCompatibleProviderConfig(emptyConfig(), {
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "sk-openai",
      }),
    ).toBe(false);
    expect(
      normalizeOpenAiCompatibleProviderConfig(emptyConfig(), {
        OPENAI_BASE_URL: "https://groq.com/openai/v1",
        GROQ_API_KEY: "gsk_key",
      }),
    ).toBe(false);
    expect(
      normalizeOpenAiCompatibleProviderConfig(emptyConfig(), {
        OPENAI_BASE_URL: "https://api.groq.com/openai/v1",
        OPENAI_API_KEY: "sk-openai",
      }),
    ).toBe(false);
    expect(
      normalizeOpenAiCompatibleProviderConfig(emptyConfig(), {
        OPENAI_BASE_URL: "not a url",
        GROQ_API_KEY: "gsk_key",
      }),
    ).toBe(false);
  });

  it("rewrites Groq-through-OpenAI shims onto the Groq plugin", () => {
    const config = {
      env: { OPENAI_BASE_URL: "https://api.groq.com/openai/v1" },
      agents: { defaults: { model: { primary: "openai" } } },
    } as ElizaConfig;
    const env: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: "https://api.groq.com/openai/v1",
      OPENAI_API_KEY: "gsk_inherited",
      OPENAI_SMALL_MODEL: "gpt-4o",
      OPENAI_LARGE_MODEL: "llama-3.3-70b",
    };
    expect(normalizeOpenAiCompatibleProviderConfig(config, env)).toBe(true);
    expect(env.GROQ_API_KEY).toBe("gsk_inherited");
    expect(env.GROQ_SMALL_MODEL).toBe("openai/gpt-oss-120b");
    expect(env.GROQ_LARGE_MODEL).toBe("llama-3.3-70b");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(config.agents?.defaults?.model?.primary).toBe("groq");
  });

  it("keeps a distinct OpenAI key and existing Groq model pins", () => {
    const config = emptyConfig();
    const env: NodeJS.ProcessEnv = {
      OPENAI_BASE_URL: "https://inference.groq.com/openai/v1",
      OPENAI_API_KEY: "sk-keep",
      GROQ_API_KEY: "gsk_direct",
      GROQ_SMALL_MODEL: "pinned-small",
      GROQ_LARGE_MODEL: "pinned-large",
    };
    expect(normalizeOpenAiCompatibleProviderConfig(config, env)).toBe(true);
    expect(env.OPENAI_API_KEY).toBe("sk-keep");
    expect(env.GROQ_API_KEY).toBe("gsk_direct");
    expect(env.GROQ_SMALL_MODEL).toBe("pinned-small");
    expect(env.GROQ_LARGE_MODEL).toBe("pinned-large");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("PGlite error classification", () => {
  it("treats coded init errors as recoverable and fatal", () => {
    for (const code of [
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
    ]) {
      const err = new PgliteInitError(code, "coded");
      expect(isRecoverablePgliteInitError(err)).toBe(true);
      expect(isFatalPgliteStartupError(err)).toBe(true);
    }
  });

  it("walks cause chains, objects, and strings for recoverable storage signals", () => {
    expect(isRecoverablePgliteInitError(null)).toBe(false);
    expect(isRecoverablePgliteInitError(undefined)).toBe(false);
    expect(isRecoverablePgliteInitError({})).toBe(false);
    expect(isRecoverablePgliteInitError(new Error("unrelated"))).toBe(false);
    expect(isFatalPgliteStartupError(new Error("unrelated"))).toBe(false);

    expect(
      isRecoverablePgliteInitError(
        new Error("Failed query: create schema if not exists migrations"),
      ),
    ).toBe(true);
    expect(
      isRecoverablePgliteInitError(
        new Error("wrapper", {
          cause: new Error("pglite aborted(). build with -sASSERTIONS"),
        }),
      ),
    ).toBe(true);
    expect(isRecoverablePgliteInitError("sqlite database is locked")).toBe(
      true,
    );
    expect(
      isRecoverablePgliteInitError({
        message: "database disk image is malformed",
      }),
    ).toBe(true);
    expect(
      isRecoverablePgliteInitError(
        new Error("aborted(). build with -sASSERTIONS without engine name"),
      ),
    ).toBe(false);

    const circular: { message: string; cause?: unknown } = {
      message: "pglite checksum mismatch",
    };
    circular.cause = circular;
    expect(isRecoverablePgliteInitError(circular)).toBe(true);
  });

  it("reads a nested PgliteInitError code from cause", () => {
    const nested = new Error("wrap", {
      cause: new PgliteInitError(PGLITE_ERROR_CODES.ACTIVE_LOCK, "dir in use"),
    });
    expect(isFatalPgliteStartupError(nested)).toBe(true);
    expect(getPgliteRecoveryAction(nested, "/tmp/unused")).toBe(
      "fail-active-lock",
    );
  });
});

describe("getPgliteRecoveryAction and cleanStalePglitePid", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns none for a non-recoverable error", () => {
    expect(getPgliteRecoveryAction(new Error("nope"), dataDir)).toBe("none");
  });

  it("fails closed on coded corrupt/manual-reset errors", () => {
    expect(
      getPgliteRecoveryAction(
        new PgliteInitError(PGLITE_ERROR_CODES.CORRUPT_DATA, "bad"),
        dataDir,
      ),
    ).toBe("fail-manual-reset");
    expect(
      getPgliteRecoveryAction(
        new PgliteInitError(PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED, "reset"),
        dataDir,
      ),
    ).toBe("fail-manual-reset");
  });

  it("retries after clearing a stale or malformed pid on a lock error", () => {
    writeFileSync(pidPath(dataDir), "2147483647\n");
    expect(
      getPgliteRecoveryAction(new Error("PGlite database is locked"), dataDir),
    ).toBe("retry-without-reset");
    expect(existsSync(pidPath(dataDir))).toBe(false);

    writeFileSync(pidPath(dataDir), "not-a-pid\n");
    expect(
      getPgliteRecoveryAction(
        new Error("sqlite lock file already exists"),
        dataDir,
      ),
    ).toBe("retry-without-reset");
    expect(existsSync(pidPath(dataDir))).toBe(false);
  });

  it("fails as an active lock when the pid process is running", () => {
    writeFileSync(pidPath(dataDir), `${process.pid}\n`);
    expect(
      getPgliteRecoveryAction(new Error("PGlite database is locked"), dataDir),
    ).toBe("fail-active-lock");
    expect(readFileSync(pidPath(dataDir), "utf8")).toContain(
      String(process.pid),
    );
  });

  it("fails as an active lock when the pid file cannot be read", () => {
    mkdirSync(pidPath(dataDir));
    expect(
      getPgliteRecoveryAction(
        new Error("PGlite lock file already exists"),
        dataDir,
      ),
    ).toBe("fail-active-lock");
  });

  it("fails manual-reset when a recoverable error has no pid file", () => {
    expect(
      getPgliteRecoveryAction(
        new Error("database disk image is malformed"),
        dataDir,
      ),
    ).toBe("fail-manual-reset");
  });

  it("removes stale and malformed pid files and leaves a live pid intact", () => {
    writeFileSync(pidPath(dataDir), "2147483647\n");
    cleanStalePglitePid(dataDir);
    expect(existsSync(pidPath(dataDir))).toBe(false);

    writeFileSync(pidPath(dataDir), "0\n");
    cleanStalePglitePid(dataDir);
    expect(existsSync(pidPath(dataDir))).toBe(false);

    writeFileSync(pidPath(dataDir), `${process.pid}\n`);
    cleanStalePglitePid(dataDir);
    expect(existsSync(pidPath(dataDir))).toBe(true);

    expect(() =>
      cleanStalePglitePid(path.join(dataDir, "missing")),
    ).not.toThrow();
  });
});

describe("shutdownRuntime", () => {
  it("returns without throwing when the runtime is missing", async () => {
    await expect(shutdownRuntime(null, "unit-null")).resolves.toBeUndefined();
    await expect(
      shutdownRuntime(undefined, "unit-undefined"),
    ).resolves.toBeUndefined();
  });

  it("stops the runtime then closes the adapter", async () => {
    const calls: string[] = [];
    const runtime = {
      stop: async (options?: { fast?: boolean }) => {
        calls.push(options?.fast ? "stop-fast" : "stop");
      },
      adapter: {
        close: async () => {
          calls.push("close");
        },
      },
    } as unknown as AgentRuntime;

    await shutdownRuntime(runtime, "unit-stop");
    expect(calls).toEqual(["stop", "close"]);

    calls.length = 0;
    await shutdownRuntime(runtime, "unit-fast", { fast: true });
    expect(calls).toEqual(["stop-fast", "close"]);
  });

  it("still closes the adapter when stop fails, then rethrows the first error", async () => {
    const calls: string[] = [];
    const runtime = {
      stop: async () => {
        calls.push("stop");
        throw new Error("stop-failed");
      },
      adapter: {
        close: async () => {
          calls.push("close");
        },
      },
    } as unknown as AgentRuntime;

    await expect(shutdownRuntime(runtime, "unit-stop-fail")).rejects.toThrow(
      "stop-failed",
    );
    expect(calls).toEqual(["stop", "close"]);
  });

  it("rethrows adapter close failure after a successful stop", async () => {
    const runtime = {
      stop: async () => undefined,
      adapter: {
        close: async () => {
          throw new Error("close-failed");
        },
      },
    } as unknown as AgentRuntime;

    await expect(shutdownRuntime(runtime, "unit-close-fail")).rejects.toThrow(
      "close-failed",
    );
  });
});

describe("logToChatListener", () => {
  it("is a no-op without a room override", async () => {
    const sent: unknown[] = [];
    const runtime = {
      sendMessageToTarget: async (...args: unknown[]) => {
        sent.push(args);
        return { id: "should-not-send" };
      },
    };

    logToChatListener({ time: 1, msg: "plain" });
    logToChatListener({
      time: 1,
      msg: "room only",
      roomId: "room-1",
    } as LogEntry);
    logToChatListener({
      time: 1,
      msg: "no override",
      roomId: "room-1",
      runtime: { ...runtime, logLevelOverrides: new Map() },
    } as unknown as LogEntry);

    await Promise.resolve();
    expect(sent).toEqual([]);
  });

  it("relays an overridden room log with the mapped level name", async () => {
    const sent: Array<{ text: string }> = [];
    const runtime = {
      logLevelOverrides: new Map([["room-9", "debug"]]),
      sendMessageToTarget: async (
        _target: unknown,
        content: { text: string },
      ) => {
        sent.push(content);
        return { id: "delivered-log" };
      },
    };
    logToChatListener({
      time: 1,
      level: 50,
      msg: "boom",
      roomId: "room-9",
      runtime,
    } as unknown as LogEntry);

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      {
        text: "```\n[ERROR] boom\n```",
        source: "system",
        isLog: "true",
      },
    ]);
  });

  it("maps unknown levels to LOG and swallows unconfirmed delivery", async () => {
    const sent: number[] = [];
    const runtime = {
      logLevelOverrides: new Map([["room-2", "on"]]),
      sendMessageToTarget: async () => {
        sent.push(1);
        return undefined;
      },
    };
    expect(() =>
      logToChatListener({
        time: 1,
        level: 99,
        msg: "mystery",
        roomId: "room-2",
        runtime,
      } as unknown as LogEntry),
    ).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([1]);
  });
});

describe("autoResolveDiscordAppId", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    snapshotEnv([
      "DISCORD_APPLICATION_ID",
      "DISCORD_API_TOKEN",
      "DISCORD_BOT_TOKEN",
    ]);
    globalThis.fetch = (async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    restoreEnv([
      "DISCORD_APPLICATION_ID",
      "DISCORD_API_TOKEN",
      "DISCORD_BOT_TOKEN",
    ]);
    globalThis.fetch = originalFetch;
  });

  it("returns without fetching when the application id is already set", async () => {
    process.env.DISCORD_APPLICATION_ID = "already";
    process.env.DISCORD_API_TOKEN = "token";
    await expect(autoResolveDiscordAppId()).resolves.toBeUndefined();
    expect(process.env.DISCORD_APPLICATION_ID).toBe("already");
  });

  it("returns without fetching when no discord token is available", async () => {
    await expect(autoResolveDiscordAppId()).resolves.toBeUndefined();
    expect(process.env.DISCORD_APPLICATION_ID).toBeUndefined();
  });
});

describe("configureLocalEmbeddingEnvEarlyIfNeeded", () => {
  beforeEach(() => {
    snapshotEnv(EMBEDDING_ENV_KEYS);
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    restoreEnv(EMBEDDING_ENV_KEYS);
  });

  it("is a no-op under NODE_ENV=test so the test harness cannot force local embeddings", async () => {
    await expect(
      configureLocalEmbeddingEnvEarlyIfNeeded(emptyConfig()),
    ).resolves.toBeUndefined();
    expect(process.env.EMBEDDING_PROVIDER).toBeUndefined();
    expect(process.env.LOCAL_EMBEDDING_MODEL).toBeUndefined();
  });
});
