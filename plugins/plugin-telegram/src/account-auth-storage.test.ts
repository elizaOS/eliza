import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await vi.importActual("@elizaos/core");
});

import {
  clearTelegramAccountSession,
  loadTelegramAccountSessionString,
  resolveTelegramAccountSessionFile,
  saveTelegramAccountSessionString,
  telegramAccountSessionExists,
} from "./account-auth-service";

let stateDir = "";
const originalStateDir = process.env.ELIZA_STATE_DIR;
const originalDisableKeychain = process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
const originalPassphrase = process.env.ELIZA_VAULT_PASSPHRASE;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-telegram-vault-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = "1";
  process.env.ELIZA_VAULT_PASSPHRASE = "telegram-storage-test-passphrase";
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = originalStateDir;
  if (originalDisableKeychain === undefined)
    delete process.env.ELIZA_VAULT_DISABLE_KEYCHAIN;
  else process.env.ELIZA_VAULT_DISABLE_KEYCHAIN = originalDisableKeychain;
  if (originalPassphrase === undefined)
    delete process.env.ELIZA_VAULT_PASSPHRASE;
  else process.env.ELIZA_VAULT_PASSPHRASE = originalPassphrase;
});

describe("Telegram Personal encrypted session storage", () => {
  it("persists an AES-GCM envelope rather than the StringSession", () => {
    const secret = "telegram-string-session-secret";
    saveTelegramAccountSessionString(secret);

    const filePath = resolveTelegramAccountSessionFile();
    const onDisk = fs.readFileSync(filePath, "utf8");
    expect(filePath).toMatch(/session\.enc$/);
    expect(onDisk).toMatch(/^v1:/);
    expect(onDisk).not.toContain(secret);
    expect(loadTelegramAccountSessionString()).toBe(secret);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("write/read verifies a legacy plaintext migration before deletion", () => {
    const encryptedPath = resolveTelegramAccountSessionFile();
    const legacyPath = path.join(path.dirname(encryptedPath), "session.txt");
    fs.writeFileSync(legacyPath, "legacy-telegram-session", { mode: 0o600 });

    expect(loadTelegramAccountSessionString()).toBe("legacy-telegram-session");
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.readFileSync(encryptedPath, "utf8")).not.toContain(
      "legacy-telegram-session",
    );
  });

  it("disconnect cleanup removes encrypted and legacy session paths", () => {
    saveTelegramAccountSessionString("remove-me");
    const encryptedPath = resolveTelegramAccountSessionFile();
    const legacyPath = path.join(path.dirname(encryptedPath), "session.txt");
    fs.writeFileSync(legacyPath, "legacy", { mode: 0o600 });
    expect(telegramAccountSessionExists()).toBe(true);

    clearTelegramAccountSession();
    expect(fs.existsSync(encryptedPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(telegramAccountSessionExists()).toBe(false);
  });
});
