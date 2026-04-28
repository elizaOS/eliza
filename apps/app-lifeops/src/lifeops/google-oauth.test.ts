import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStoredGoogleToken } from "./google-oauth.js";
import {
  encryptTokenPayload,
  isEncryptedTokenEnvelope,
} from "./token-encryption.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-google-oauth-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SAMPLE_TOKEN = {
  provider: "google" as const,
  agentId: "agent-1",
  side: "owner" as const,
  mode: "local" as const,
  clientId: "client-id",
  redirectUri: "http://localhost/cb",
  accessToken: "ya29.fake",
  refreshToken: "1//refresh-fake",
  tokenType: "Bearer",
  grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  expiresAt: 1700000000000,
  refreshTokenExpiresAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function envForTmp(key: Buffer | null): NodeJS.ProcessEnv {
  return {
    ELIZA_OAUTH_DIR: tmpDir,
    ...(key ? { ELIZA_TOKEN_ENCRYPTION_KEY: key.toString("base64") } : {}),
  } as NodeJS.ProcessEnv;
}

describe("Google OAuth token storage", () => {
  it("decrypts an encrypted token envelope on read", () => {
    const key = crypto.randomBytes(32);
    const env = envForTmp(key);
    const tokenRef = path.join("agent-1", "owner", "local.json");
    const filePath = path.join(tmpDir, "lifeops", "google", tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const envelope = encryptTokenPayload(JSON.stringify(SAMPLE_TOKEN), key);
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), {
      mode: 0o600,
    });
    const restored = readStoredGoogleToken(tokenRef, env);
    expect(restored).not.toBeNull();
    expect(restored?.accessToken).toBe(SAMPLE_TOKEN.accessToken);
    expect(restored?.refreshToken).toBe(SAMPLE_TOKEN.refreshToken);
  });

  it("reads legacy plaintext tokens (no `__enc` envelope)", () => {
    const env = envForTmp(crypto.randomBytes(32));
    const tokenRef = path.join("agent-1", "owner", "local.json");
    const filePath = path.join(tmpDir, "lifeops", "google", tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, JSON.stringify(SAMPLE_TOKEN, null, 2), {
      mode: 0o600,
    });
    const restored = readStoredGoogleToken(tokenRef, env);
    expect(restored?.accessToken).toBe(SAMPLE_TOKEN.accessToken);
  });

  it("returns null when the token file does not exist", () => {
    const env = envForTmp(crypto.randomBytes(32));
    expect(
      readStoredGoogleToken(path.join("agent-1", "owner", "local.json"), env),
    ).toBeNull();
  });

  it("treats the encrypted envelope as opaque on disk", () => {
    const key = crypto.randomBytes(32);
    const tokenRef = path.join("agent-1", "owner", "local.json");
    const filePath = path.join(tmpDir, "lifeops", "google", tokenRef);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const envelope = encryptTokenPayload(JSON.stringify(SAMPLE_TOKEN), key);
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), {
      mode: 0o600,
    });
    const onDisk = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(isEncryptedTokenEnvelope(onDisk)).toBe(true);
    const text = fs.readFileSync(filePath, "utf8");
    expect(text).not.toContain(SAMPLE_TOKEN.accessToken);
    expect(text).not.toContain(SAMPLE_TOKEN.refreshToken);
  });
});
