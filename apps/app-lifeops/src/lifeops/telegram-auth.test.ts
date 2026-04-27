import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEncryptedTokenEnvelope } from "./token-encryption.js";

type MockTelegramAccount = {
  id: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
};

type MockTelegramSnapshot = {
  status: "idle" | "waiting_for_telegram_code" | "connected";
  phone: string | null;
  error: string | null;
  isCodeViaApp: boolean;
  account: MockTelegramAccount | null;
};

type MockTelegramCredentials = {
  apiId: number;
  apiHash: string;
};

type MockTelegramConnectorConfig = {
  phone: string;
  appId: string;
  appHash: string;
  deviceModel: string;
  systemVersion: string;
  enabled: true;
};

vi.mock(
  "../../../../plugins/plugin-telegram/src/account-auth-service.ts",
  () => {
    class TelegramAccountAuthSession {
      private snapshot: MockTelegramSnapshot = {
        status: "waiting_for_telegram_code",
        phone: null,
        error: null,
        isCodeViaApp: true,
        account: null,
      };
      private connectorConfig: MockTelegramConnectorConfig | null = null;

      async start(options: {
        phone: string;
        credentials: MockTelegramCredentials | null;
      }): Promise<MockTelegramSnapshot> {
        const apiId = options.credentials?.apiId ?? 12345;
        const apiHash = options.credentials?.apiHash ?? "hash-123";
        this.connectorConfig = {
          phone: options.phone,
          appId: String(apiId),
          appHash: apiHash,
          deviceModel: "Test Device",
          systemVersion: "Test OS",
          enabled: true,
        };
        this.snapshot = {
          status: "waiting_for_telegram_code",
          phone: options.phone,
          error: null,
          isCodeViaApp: true,
          account: null,
        };
        return this.getSnapshot();
      }

      async submit(): Promise<MockTelegramSnapshot> {
        this.snapshot = {
          status: "connected",
          phone: this.snapshot.phone,
          error: null,
          isCodeViaApp: false,
          account: {
            id: "telegram-user-1",
            username: "carol",
            firstName: "Carol",
            lastName: null,
            phone: this.snapshot.phone,
          },
        };
        return this.getSnapshot();
      }

      async stop(): Promise<void> {
        this.snapshot = {
          status: "idle",
          phone: null,
          error: null,
          isCodeViaApp: false,
          account: null,
        };
        this.connectorConfig = null;
      }

      getSnapshot(): MockTelegramSnapshot {
        return {
          ...this.snapshot,
          account: this.snapshot.account ? { ...this.snapshot.account } : null,
        };
      }

      getResolvedConnectorConfig(): MockTelegramConnectorConfig | null {
        return this.connectorConfig ? { ...this.connectorConfig } : null;
      }
    }

    return { TelegramAccountAuthSession };
  },
);

const ENV_KEYS = [
  "ELIZA_OAUTH_DIR",
  "ELIZA_STATE_DIR",
  "ELIZA_TOKEN_ENCRYPTION_KEY",
  "ELIZA_TELEGRAM_API_ID",
  "ELIZA_TELEGRAM_API_HASH",
  "TELEGRAM_ACCOUNT_APP_ID",
  "TELEGRAM_ACCOUNT_APP_HASH",
] as const;

let tmpDir: string;
let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function telegramRoot(): string {
  return path.join(tmpDir, "lifeops", "telegram");
}

function telegramTokenPath(tokenRef: string): string {
  return path.join(telegramRoot(), tokenRef);
}

const LEGACY_TOKEN = {
  provider: "telegram" as const,
  agentId: "agent-legacy",
  side: "owner" as const,
  sessionString: "persisted",
  apiId: 12345,
  apiHash: "legacy-hash",
  phone: "+15550001111",
  identity: {
    id: "legacy-user",
    username: "legacy",
    firstName: "Legacy",
  },
  connectorConfig: {
    phone: "+15550001111",
    appId: "12345",
    appHash: "legacy-hash",
    deviceModel: "Legacy Device",
    systemVersion: "Legacy OS",
    enabled: true as const,
  },
  createdAt: "2026-04-17T00:00:00.000Z",
  updatedAt: "2026-04-17T00:00:00.000Z",
};

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-telegram-auth-"));
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }
  process.env.ELIZA_OAUTH_DIR = tmpDir;
  process.env.ELIZA_STATE_DIR = path.join(tmpDir, "state");
  process.env.ELIZA_TOKEN_ENCRYPTION_KEY = crypto
    .randomBytes(32)
    .toString("base64");
  process.env.ELIZA_TELEGRAM_API_ID = "12345";
  process.env.ELIZA_TELEGRAM_API_HASH = "hash-123";
  delete process.env.TELEGRAM_ACCOUNT_APP_ID;
  delete process.env.TELEGRAM_ACCOUNT_APP_HASH;
});

afterEach(() => {
  vi.resetModules();
  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Telegram auth storage", () => {
  it("writes pending auth session files as encrypted envelopes and restores them", async () => {
    const { startTelegramAuth } = await import("./telegram-auth.js");

    const session = await startTelegramAuth({
      agentId: "agent-1",
      side: "owner",
      phone: "+15551234567",
      apiId: 12345,
      apiHash: "hash-123",
    });

    const filePath = path.join(
      telegramRoot(),
      "pending",
      `${session.sessionId}.json`,
    );
    const text = fs.readFileSync(filePath, "utf8");
    expect(isEncryptedTokenEnvelope(JSON.parse(text))).toBe(true);
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain("hash-123");

    vi.resetModules();
    const reloaded = await import("./telegram-auth.js");
    const restored = reloaded.getTelegramAuthStatus(session.sessionId);
    expect(restored?.agentId).toBe("agent-1");
    expect(restored?.side).toBe("owner");
    expect(restored?.phone).toBe("+15551234567");

    await reloaded.cancelTelegramAuth(session.sessionId);
    expect(reloaded.getTelegramAuthStatus(session.sessionId)).toBeNull();
  });

  it("writes connector tokens as encrypted envelopes and reads them back", async () => {
    const {
      buildTelegramTokenRef,
      cancelTelegramAuth,
      readStoredTelegramToken,
      startTelegramAuth,
      submitTelegramAuthCode,
    } = await import("./telegram-auth.js");

    const session = await startTelegramAuth({
      agentId: "agent-1",
      side: "owner",
      phone: "+15551234567",
      apiId: 12345,
      apiHash: "hash-123",
    });

    const result = await submitTelegramAuthCode(session.sessionId, "12345");
    expect(result.state).toBe("connected");

    const tokenRef = buildTelegramTokenRef("agent-1", "owner");
    const text = fs.readFileSync(telegramTokenPath(tokenRef), "utf8");
    expect(isEncryptedTokenEnvelope(JSON.parse(text))).toBe(true);
    expect(text).not.toContain("+15551234567");
    expect(text).not.toContain("hash-123");
    expect(text).not.toContain("telegram-user-1");

    const restored = readStoredTelegramToken(tokenRef);
    expect(restored?.apiId).toBe(12345);
    expect(restored?.apiHash).toBe("hash-123");
    expect(restored?.identity.id).toBe("telegram-user-1");

    await cancelTelegramAuth(session.sessionId);
  });

  it("reads legacy plaintext connector tokens", async () => {
    const { readStoredTelegramToken } = await import("./telegram-auth.js");
    const tokenRef = path.join("agent-legacy", "owner", "local.json");
    const filePath = telegramTokenPath(tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(LEGACY_TOKEN, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    const restored = readStoredTelegramToken(tokenRef);
    expect(restored?.apiHash).toBe("legacy-hash");
    expect(restored?.phone).toBe("+15550001111");
  });

  it("finds a single stored token for a side when the current agent has no token", async () => {
    const { findStoredTelegramTokenForSide } = await import(
      "./telegram-auth.js"
    );
    const tokenRef = path.join("agent-legacy", "owner", "local.json");
    const filePath = telegramTokenPath(tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(LEGACY_TOKEN, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    const candidate = findStoredTelegramTokenForSide("agent-current", "owner");

    expect(candidate?.agentId).toBe("agent-legacy");
    expect(candidate?.tokenRef).toBe(tokenRef);
    expect(candidate?.token.phone).toBe("+15550001111");
  });

  it("does not guess between multiple stored tokens for the same side", async () => {
    const { findStoredTelegramTokenForSide } = await import(
      "./telegram-auth.js"
    );
    for (const agentId of ["agent-one", "agent-two"]) {
      const tokenRef = path.join(agentId, "owner", "local.json");
      const filePath = telegramTokenPath(tokenRef);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ ...LEGACY_TOKEN, agentId }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    }

    expect(findStoredTelegramTokenForSide("agent-current", "owner")).toBeNull();
  });

  it("uses Telegram account env credentials when LifeOps-specific aliases are absent", async () => {
    const { hasManagedTelegramCredentials } = await import(
      "./telegram-auth.js"
    );
    delete process.env.ELIZA_TELEGRAM_API_ID;
    delete process.env.ELIZA_TELEGRAM_API_HASH;
    process.env.TELEGRAM_ACCOUNT_APP_ID = "67890";
    process.env.TELEGRAM_ACCOUNT_APP_HASH = "account-hash";

    expect(hasManagedTelegramCredentials()).toBe(true);
  });

  it("rejects malformed connector tokens instead of treating auth as valid", async () => {
    const { readStoredTelegramToken } = await import("./telegram-auth.js");
    const tokenRef = path.join("agent-bad", "owner", "local.json");
    const filePath = telegramTokenPath(tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          provider: "telegram",
          agentId: "agent-bad",
          side: "owner",
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    expect(readStoredTelegramToken(tokenRef)).toBeNull();
  });

  it("reads legacy plaintext pending auth session files", async () => {
    const sessionId = "legacy-session";
    const filePath = path.join(telegramRoot(), "pending", `${sessionId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          sessionId,
          agentId: "agent-legacy",
          side: "agent",
          phone: "+15550002222",
          apiId: 12345,
          apiHash: "legacy-hash",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: "utf8", mode: 0o600 },
    );

    const { getTelegramAuthStatus } = await import("./telegram-auth.js");
    const restored = getTelegramAuthStatus(sessionId);
    expect(restored?.agentId).toBe("agent-legacy");
    expect(restored?.side).toBe("agent");
    expect(restored?.phone).toBe("+15550002222");
  });
});
