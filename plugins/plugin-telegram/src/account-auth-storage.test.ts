/** Exercises encrypted Telegram session persistence and agent/account AAD isolation using the real filesystem and vault crypto. */
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

  it("verifies the staged and final encrypted records before reporting success", () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    try {
      saveTelegramAccountSessionString("verified-session");

      const encryptedReads = readSpy.mock.calls.filter(
        ([filePath]) =>
          typeof filePath === "string" &&
          (filePath.includes("session.enc.tmp-") ||
            filePath.endsWith("session.enc")),
      );
      expect(
        encryptedReads.some(([filePath]) => String(filePath).includes(".tmp-")),
      ).toBe(true);
      expect(
        encryptedReads.some(([filePath]) =>
          String(filePath).endsWith("session.enc"),
        ),
      ).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
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

it("isolates encrypted sessions by agent and account and rejects copied ciphertext", () => {
  const first = { agentId: "agent-a", accountId: "me:personal" };
  const second = { agentId: "agent-b", accountId: "me:personal" };
  const anotherAccount = { agentId: "agent-a", accountId: "other:personal" };
  saveTelegramAccountSessionString("first-owner-session", first);
  saveTelegramAccountSessionString("second-owner-session", second);
  expect(loadTelegramAccountSessionString(first)).toBe("first-owner-session");
  expect(loadTelegramAccountSessionString(second)).toBe("second-owner-session");
  expect(loadTelegramAccountSessionString(anotherAccount)).toBe("");
  fs.copyFileSync(
    resolveTelegramAccountSessionFile(first),
    resolveTelegramAccountSessionFile(anotherAccount),
  );
  expect(() => loadTelegramAccountSessionString(anotherAccount)).toThrow();
  clearTelegramAccountSession(first);
  expect(telegramAccountSessionExists(first)).toBe(false);
  expect(loadTelegramAccountSessionString(second)).toBe("second-owner-session");
});
