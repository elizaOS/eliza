/**
 * Node-side OS secure-store backends for agent secrets: macOS Keychain through
 * the native `@napi-rs/keyring` binding, Linux libsecret (`secret-tool`), and an
 * explicit unavailable backend on platforms with no adapter. macOS deliberately
 * never shells out to `/usr/bin/security`: the system CLI can target a stale
 * default keychain and show a misleading "Keychain Not Found" dialog.
 */
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
  PlatformSecureStoreProtection,
  SecureStoreDeleteResult,
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

/** Write to Linux Secret Service via stdin so the secret never enters argv. */
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

type SecureStoreFailure = Extract<SecureStoreGetResult, { ok: false }>;

function nativeStoreReason(error: unknown): SecureStoreFailure {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("no entry") ||
    normalized.includes("not found") ||
    normalized.includes("could not be found")
  ) {
    return { ok: false, reason: "not_found" };
  }
  if (
    normalized.includes("denied") ||
    normalized.includes("auth") ||
    normalized.includes("user cancel") ||
    normalized.includes("interaction not allowed")
  ) {
    return { ok: false, reason: "denied" };
  }
  return {
    ok: false,
    reason: "error",
    // Never return a native exception verbatim: platform libraries have
    // historically embedded account identifiers in their error messages.
    message: "Native credential store operation failed.",
  };
}

let macKeyringModule: Promise<typeof import("@napi-rs/keyring")> | undefined;

function loadMacKeyring(): Promise<typeof import("@napi-rs/keyring")> {
  macKeyringModule ??= import("@napi-rs/keyring");
  return macKeyringModule;
}

class MacOSKeychainPlatformSecureStore implements PlatformSecureStore {
  readonly backend: PlatformSecureStoreBackend = "macos_keychain";

  async isAvailable(): Promise<boolean> {
    try {
      await loadMacKeyring();
      return true;
    } catch {
      // error-policy:J4 native Keychain binding unavailable (probe)
      return false;
    }
  }

  async get(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreGetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      const { AsyncEntry } = await loadMacKeyring();
      const value = await new AsyncEntry(
        ELIZA_AGENT_VAULT_SERVICE,
        account,
      ).getPassword();
      if (!value) {
        return { ok: false, reason: "not_found" };
      }
      return { ok: true, value };
    } catch (err: unknown) {
      return nativeStoreReason(err);
    }
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      const { AsyncEntry } = await loadMacKeyring();
      await new AsyncEntry(ELIZA_AGENT_VAULT_SERVICE, account).setPassword(
        value,
      );
      return { ok: true };
    } catch (err: unknown) {
      return nativeStoreReason(err);
    }
  }

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    const account = keychainAccountForSecretKind(vaultId, kind);
    try {
      const { AsyncEntry } = await loadMacKeyring();
      await new AsyncEntry(
        ELIZA_AGENT_VAULT_SERVICE,
        account,
      ).deleteCredential();
    } catch (err: unknown) {
      const failure = nativeStoreReason(err);
      if (failure.reason !== "not_found") {
        return failure;
      }
      const verifiedMissing = await this.get(vaultId, kind);
      if (!verifiedMissing.ok && verifiedMissing.reason === "not_found") {
        return { ok: true, deleted: false };
      }
      if (!verifiedMissing.ok) {
        return verifiedMissing;
      }
      return {
        ok: false,
        reason: "error",
        message: "Native credential store deletion could not be verified.",
      };
    }

    const verifiedMissing = await this.get(vaultId, kind);
    if (!verifiedMissing.ok && verifiedMissing.reason === "not_found") {
      return { ok: true, deleted: true };
    }
    if (!verifiedMissing.ok) {
      return verifiedMissing;
    }
    return {
      ok: false,
      reason: "error",
      message: "Native credential store deletion could not be verified.",
    };
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
      const normalized = stderr.trim().toLowerCase();
      if (
        (e.code === 1 && normalized.length === 0) ||
        normalized.includes("not found")
      ) {
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

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    const account = this.account(vaultId, kind);
    try {
      await execFileAsync("secret-tool", [
        "clear",
        "service",
        ELIZA_AGENT_VAULT_SERVICE,
        "account",
        account,
      ]);
    } catch (err: unknown) {
      const verifiedMissing = await this.get(vaultId, kind);
      if (!verifiedMissing.ok && verifiedMissing.reason === "not_found") {
        return { ok: true, deleted: false };
      }
      return nativeStoreReason(err);
    }

    const verifiedMissing = await this.get(vaultId, kind);
    if (!verifiedMissing.ok && verifiedMissing.reason === "not_found") {
      return { ok: true, deleted: true };
    }
    if (!verifiedMissing.ok) {
      return verifiedMissing;
    }
    return {
      ok: false,
      reason: "error",
      message: "Native credential store deletion could not be verified.",
    };
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

  async delete(): Promise<SecureStoreDeleteResult> {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Node-side factory: macOS Keychain, Linux `secret-tool`, or the explicit
 * unavailable backend on platforms without an OS credential-store adapter.
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

/** Non-secret posture for support and the Vault protection UI. */
export async function describeNodePlatformSecureStore(
  store: PlatformSecureStore = createNodePlatformSecureStore(),
): Promise<PlatformSecureStoreProtection> {
  const available = await store.isAvailable();
  if (!available || store.backend === "none") {
    return {
      backend: store.backend,
      available: false,
      synchronized: false,
      scope: "unavailable",
      access: "unavailable",
    };
  }
  return {
    backend: store.backend,
    available: true,
    synchronized: false,
    scope: "host",
    access: store.backend === "macos_keychain" ? "app_only" : "user_session",
  };
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
