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
const LINUX_SECRET_WIRE_PREFIX = "eliza-v1:";

type NativeKeyringLoader = () => Promise<typeof import("@napi-rs/keyring")>;
type SecretToolCommandRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string; stderr?: string }>;
type SecretToolStoreRunner = (
  args: string[],
  secretLine: string,
) => Promise<void>;

interface NodePlatformSecureStoreOptions {
  platform?: NodeJS.Platform;
  loadNativeKeyring?: NativeKeyringLoader;
  runSecretTool?: SecretToolCommandRunner;
  storeSecretTool?: SecretToolStoreRunner;
  secretToolAvailable?: () => Promise<boolean>;
  secretServiceReachable?: () => boolean;
}

async function runSecretTool(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr?: string }> {
  const result = await execFileAsync(executable, args, { encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function encodeLinuxSecret(value: string): string {
  return `${LINUX_SECRET_WIRE_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
}

function decodeLinuxSecret(value: string): SecureStoreGetResult {
  if (!value.startsWith(LINUX_SECRET_WIRE_PREFIX)) {
    return value.length > 0
      ? { ok: true, value }
      : { ok: false, reason: "not_found" };
  }
  try {
    const encoded = value.slice(LINUX_SECRET_WIRE_PREFIX.length);
    const bytes = Buffer.from(encoded, "base64url");
    // Buffer's decoder is permissive, so exact re-encoding prevents corrupted
    // or attacker-edited payloads from becoming a different credential.
    if (bytes.toString("base64url") !== encoded) {
      return {
        ok: false,
        reason: "error",
        message: "Stored credential is corrupt.",
      };
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: decoded };
  } catch {
    // error-policy:J3 persisted Secret Service data is untrusted input.
    return {
      ok: false,
      reason: "error",
      message: "Stored credential is corrupt.",
    };
  }
}

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function isLinux(): boolean {
  return process.platform === "linux";
}

function isWindows(): boolean {
  return process.platform === "win32";
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
    // error-policy:J5 an early child exit can make stdin emit EPIPE; the same
    // failure is observed and rejected by the close/error handlers above.
    child.stdin.on("error", () => {});
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

function linuxSecretServiceSessionReachable(): boolean {
  if ((process.env.DBUS_SESSION_BUS_ADDRESS ?? "").trim().length > 0) {
    return true;
  }
  const runtimeDir = (process.env.XDG_RUNTIME_DIR ?? "").trim();
  return runtimeDir.length > 0 && fs.existsSync(path.join(runtimeDir, "bus"));
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

interface NativeKeyringEntry {
  deleteCredential(): Promise<void>;
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
}

type NativeKeyringEntryConstructor = new (
  service: string,
  account: string,
) => NativeKeyringEntry;

interface NativeKeyringModule {
  AsyncEntry: NativeKeyringEntryConstructor;
}

function isNativeKeyringModule(value: unknown): value is NativeKeyringModule {
  if (typeof value !== "object" || value === null) return false;
  return "AsyncEntry" in value && typeof value.AsyncEntry === "function";
}

export function resolveBundledKeyringPath(options: {
  arch: string;
  entrypoint: string | undefined;
  platform: string;
}): string | null {
  if (!options.entrypoint) return null;
  const runtimeDir = path.dirname(options.entrypoint);
  const prefix = `keyring.${options.platform}-${options.arch}`;
  try {
    const matches = fs
      .readdirSync(runtimeDir)
      .filter(
        (fileName) =>
          fileName.startsWith(prefix) && path.extname(fileName) === ".node",
      )
      .sort();
    if (matches.length !== 1) return null;
    return path.join(runtimeDir, matches[0]);
  } catch {
    // error-policy:J3 the packaged runtime directory may not exist.
    return null;
  }
}

function loadBundledNativeKeyring(): NativeKeyringModule {
  const bindingPath = resolveBundledKeyringPath({
    arch: process.arch,
    entrypoint: process.argv[1],
    platform: process.platform,
  });
  if (!bindingPath) {
    throw new Error("Bundled native Keychain binding was not found.");
  }

  const nativeModule: { exports: unknown } = { exports: {} };
  process.dlopen(nativeModule, bindingPath);
  if (!isNativeKeyringModule(nativeModule.exports)) {
    throw new Error("Bundled native Keychain binding has invalid exports.");
  }
  return nativeModule.exports;
}

let nativeKeyringModule: Promise<NativeKeyringModule> | undefined;

async function importNativeKeyring(): Promise<NativeKeyringModule> {
  try {
    const imported: unknown = await import("@napi-rs/keyring");
    if (!isNativeKeyringModule(imported)) {
      throw new Error("Native Keychain package has invalid exports.");
    }
    return imported;
  } catch (importError) {
    // error-policy:J2 Bun 1.3.13 can emit a native addon while its generated
    // import.meta.require cannot load it. Load the validated packaged addon.
    try {
      return loadBundledNativeKeyring();
    } catch (bundledError) {
      throw new AggregateError(
        [importError, bundledError],
        "Native Keychain binding is unavailable.",
      );
    }
  }
}

function loadNativeKeyring(): Promise<NativeKeyringModule> {
  nativeKeyringModule ??= importNativeKeyring();
  return nativeKeyringModule;
}

class NativeKeyringPlatformSecureStore implements PlatformSecureStore {
  constructor(
    readonly backend: PlatformSecureStoreBackend,
    private readonly keyringLoader: NativeKeyringLoader = loadNativeKeyring,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.keyringLoader();
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
      const { AsyncEntry } = await this.keyringLoader();
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
      const { AsyncEntry } = await this.keyringLoader();
      const entry = new AsyncEntry(ELIZA_AGENT_VAULT_SERVICE, account);
      await entry.setPassword(value);
      const verified = await entry.getPassword();
      if (verified !== value) {
        return {
          ok: false,
          reason: "error",
          message: "Native credential store write could not be verified.",
        };
      }
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
      const { AsyncEntry } = await this.keyringLoader();
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

  constructor(
    private readonly commandRunner: SecretToolCommandRunner = runSecretTool,
    private readonly storeRunner: SecretToolStoreRunner = secretToolStoreWithStdin,
    private readonly available: () => Promise<boolean> = secretToolOnPath,
    private readonly sessionReachable: () => boolean = linuxSecretServiceSessionReachable,
  ) {}

  async isAvailable(): Promise<boolean> {
    return (await this.available()) && this.sessionReachable();
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
      const { stdout } = await this.commandRunner("secret-tool", [
        "lookup",
        "service",
        ELIZA_AGENT_VAULT_SERVICE,
        "account",
        account,
      ]);
      const value = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
      return decodeLinuxSecret(value);
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
      return nativeStoreReason(err);
    }
  }

  async set(
    vaultId: string,
    kind: SecureStoreSecretKind,
    value: string,
  ): Promise<SecureStoreSetResult> {
    const account = this.account(vaultId, kind);
    try {
      await this.storeRunner(
        [
          "store",
          "--label=Eliza agent wallet",
          "service",
          ELIZA_AGENT_VAULT_SERVICE,
          "account",
          account,
        ],
        encodeLinuxSecret(value),
      );
      const verified = await this.get(vaultId, kind);
      if (!verified.ok || verified.value !== value) {
        return {
          ok: false,
          reason: "error",
          message: "Native credential store write could not be verified.",
        };
      }
      return { ok: true };
    } catch (err: unknown) {
      return nativeStoreReason(err);
    }
  }

  async delete(
    vaultId: string,
    kind: SecureStoreSecretKind,
  ): Promise<SecureStoreDeleteResult> {
    const account = this.account(vaultId, kind);
    try {
      await this.commandRunner("secret-tool", [
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
export function createNodePlatformSecureStore(
  options: NodePlatformSecureStoreOptions = {},
): PlatformSecureStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return new NativeKeyringPlatformSecureStore(
      "macos_keychain",
      options.loadNativeKeyring,
    );
  }
  if (platform === "win32") {
    return new NativeKeyringPlatformSecureStore(
      "windows_credential_manager",
      options.loadNativeKeyring,
    );
  }
  if (platform === "linux") {
    return new LinuxSecretToolPlatformSecureStore(
      options.runSecretTool,
      options.storeSecretTool,
      options.secretToolAvailable,
      options.secretServiceReachable,
    );
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
    // Desktop credential managers isolate by logged-in OS user. Service and
    // account names prevent collisions, but are not an application sandbox.
    access: "user_session",
  };
}

const WALLET_OS_STORE_TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const WALLET_OS_STORE_FALSE_VALUES = new Set(["0", "false", "off", "no"]);

export function isNodePlatformSecureStoreDefaultAvailable(): boolean {
  if (isDarwin() || isWindows()) return true;
  if (isLinux()) {
    return secretToolOnPathSync() && linuxSecretServiceSessionReachable();
  }
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
