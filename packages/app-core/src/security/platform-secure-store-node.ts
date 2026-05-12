import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  ELIZA_AGENT_VAULT_SERVICE,
  keychainAccountForSecretKind,
} from "./agent-vault-id";
import type {
  PlatformSecureStore,
  PlatformSecureStoreBackend,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "./platform-secure-store";

const execFileAsync = promisify(execFile);

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

/**
 * Write a password to the macOS Keychain via stdin to avoid argv exposure.
 * The `security add-generic-password` command reads from stdin when `-w`
 * is the last argument with no value. It prompts twice (password + retype),
 * so we write the value twice separated by a newline.
 */
function keychainSetViaStdin(args: string[], password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(new Error(stderr.trim() || `security exited ${code}`), {
          stderr,
          code,
        }),
      );
    });
    // Swallow EPIPE if security exits before reading stdin (e.g. arg error).
    // Without this, Node emits an unhandled error and may crash the process.
    child.stdin.on("error", () => {});
    // Write password twice (password + retype) then close stdin
    child.stdin.write(`${password}\n${password}\n`, () => {
      child.stdin.end();
    });
  });
}

function secretToolStoreWithStdin(
  args: string[],
  secretLine: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        Object.assign(
          new Error(stderr.trim() || `secret-tool exited ${code}`),
          {
            stderr,
            code,
          },
        ),
      );
    });
    const line = secretLine.endsWith("\n") ? secretLine : `${secretLine}\n`;
    child.stdin.write(line, "utf8");
    child.stdin.end();
  });
}

/**
 * Check if `secret-tool` is available on PATH without spawning a shell.
 * Iterates PATH entries directly and checks for the executable.
 */
function secretToolOnPathSync(): boolean {
  if (process.platform === "win32") return false;
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "secret-tool");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // not in this dir
    }
  }
  return false;
}

async function secretToolOnPath(): Promise<boolean> {
  return secretToolOnPathSync();
}

function macErrReason(
  stderr: string,
  code: number | null,
): SecureStoreGetResult {
  const s = stderr.toLowerCase();
  if (
    s.includes("could not be found") ||
    s.includes("the specified item could not be found")
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (s.includes("user canceled") || s.includes("user cancelled")) {
    return { ok: false, reason: "denied" };
  }
  return {
    ok: false,
    reason: code === 44 || code === 45 ? "denied" : "error",
    message: stderr.trim().slice(0, 300),
  };
}

class MacOSKeychainPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "macos_keychain";

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("security", ["-h"], { encoding: "utf8" });
      return true;
    } catch {
      return false;
    }
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      const { stdout, stderr: _stderr } = await execFileAsync(
        "security",
        [
          "find-generic-password",
          "-s",
          ELIZA_AGENT_VAULT_SERVICE,
          "-a",
          account,
          "-w",
        ],
        { encoding: "utf8" },
      );
      const value = stdout.trim();
      if (!value) {
        return { ok: false, reason: "not_found" };
      }
      return { ok: true, value };
    } catch (err: unknown) {
      const e = err as { stderr?: string; code?: number };
      return macErrReason(String(e.stderr ?? err), e.code ?? null);
    }
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      // Pass password via stdin instead of argv to avoid exposure via `ps`.
      // The `-w` flag (last, with no value) triggers stdin read mode.
      await keychainSetViaStdin(
        [
          "add-generic-password",
          "-s",
          ELIZA_AGENT_VAULT_SERVICE,
          "-a",
          account,
          "-U",
          "-w",
        ],
        value,
      );
      return { ok: true };
    } catch (err: unknown) {
      const stderr = String((err as { stderr?: string }).stderr ?? err);
      return {
        ok: false,
        reason: "error",
        message: stderr.trim().slice(0, 300),
      };
    }
  }

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      await execFileAsync("security", [
        "delete-generic-password",
        "-s",
        ELIZA_AGENT_VAULT_SERVICE,
        "-a",
        account,
      ]);
    } catch {
      // ignore — item may not exist
    }
  }
}

/** Linux: `secret-tool` from libsecret (GNOME Keyring / KWallet Secret Service). */
class LinuxSecretToolPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "linux_secret_service";

  async isAvailable(): Promise<boolean> {
    return secretToolOnPath();
  }

  private account(vaultId: string, kind: SecureStoreSecretKind): string {
    return keychainAccountForSecretKind(vaultId, kind);
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const account = this.account(vaultId, kind);
    try {
      const { stdout } = await execFileAsync(
        "secret-tool",
        ["lookup", "service", ELIZA_AGENT_VAULT_SERVICE, "account", account],
        { encoding: "utf8" },
      );
      const value = stdout.trim();
      if (!value) return { ok: false, reason: "not_found" };
      return { ok: true, value };
    } catch (err: unknown) {
      const e = err as { stderr?: string; code?: number };
      const stderr = String(e.stderr ?? "");
      if (e.code === 1 || stderr.includes("not found")) {
        return { ok: false, reason: "not_found" };
      }
      return {
        ok: false,
        reason: "error",
        message: stderr.trim().slice(0, 300),
      };
    }
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = this.account(vaultId, kind);
    try {
      await secretToolStoreWithStdin(
        [
          "store",
          "--label=Eliza agent wallet",
          "service",
          ELIZA_AGENT_VAULT_SERVICE,
          "account",
          account,
        ],
        value,
      );
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { stderr?: string };
      return {
        ok: false,
        reason: "error",
        message: String(e.stderr ?? err)
          .trim()
          .slice(0, 300),
      };
    }
  }

  async delete(vaultId: string, kind: SecureStoreSecretKind): Promise<void> {
    const account = this.account(vaultId, kind);
    try {
      await execFileAsync("secret-tool", [
        "clear",
        "service",
        ELIZA_AGENT_VAULT_SERVICE,
        "account",
        account,
      ]);
    } catch {
      // ignore
    }
  }
}

class NonePlatformSecureStore implements PlatformSecureStore {
  constructor(readonly backend: PlatformSecureStoreBackend = "none") {}

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async get(): Promise<SecureStoreGetResult> {
    return { ok: false, reason: "unavailable" };
  }

  async set(): Promise<SecureStoreSetResult> {
    return { ok: false, reason: "unavailable" };
  }

  async delete(): Promise<void> {}
}

/**
 * Node-side factory: macOS Keychain, Linux `secret-tool`, or unavailable placeholder.
 * Windows Credential Manager is not wired yet (`none`).
 */
export function createNodePlatformSecureStore(): PlatformSecureStore {
  if (isDarwin()) {
    return new MacOSKeychainPlatformSecureStore();
  }
  if (isLinux()) {
    return new LinuxSecretToolPlatformSecureStore();
  }
  return new NonePlatformSecureStore();
}

const WALLET_OS_STORE_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const WALLET_OS_STORE_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

export function isNodePlatformSecureStoreDefaultAvailable(): boolean {
  if (isDarwin()) return true;
  if (isLinux()) return secretToolOnPathSync();
  return false;
}

/**
 * Explicit override: `ELIZA_WALLET_OS_STORE=0|false|off|no` disables this path.
 * When unset, default on for supported local secure stores.
 */
export function isWalletOsStoreReadEnabled(): boolean {
  const raw = process.env.ELIZA_WALLET_OS_STORE?.trim().toLowerCase();
  if (raw) {
    if (WALLET_OS_STORE_TRUE_VALUES.has(raw)) return true;
    if (WALLET_OS_STORE_FALSE_VALUES.has(raw)) return false;
  }
  return isNodePlatformSecureStoreDefaultAvailable();
}
