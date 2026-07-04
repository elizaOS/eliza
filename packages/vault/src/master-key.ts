/**
 * Master-key resolvers for vault encryption.
 *
 * Supports OS keychain storage, passphrase-derived keys, in-memory test keys,
 * and fail-closed TEE attestation before releasing sealed-volume keys.
 */

import { execFile, spawn } from "node:child_process";
import { scryptSync } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateMasterKey, KEY_BYTES } from "./crypto.js";

const execFileAsync = promisify(execFile);

/**
 * Where the encryption master key lives.
 *
 * Resolvers, ordered by preference for `defaultMasterKey()`:
 *
 *   1. **OS keychain** — cross-platform via @napi-rs/keyring (macOS
 *      Keychain, Windows Credential Manager, Linux Secret Service /
 *      libsecret). The default on machines with a desktop session.
 *   2. **Passphrase** — scrypt-derived 32-byte key from `ELIZA_VAULT_PASSPHRASE`
 *      with a per-service salt. Use this on headless Linux servers, in
 *      Docker containers, or in CI where the OS keychain isn't reachable.
 *      Operator opts in by setting the env var; we never derive from a
 *      hard-coded fallback.
 *   3. **In-memory** — `inMemoryMasterKey(buffer)`. Tests only.
 *   4. **Attestation-bound** — `attestationMasterKey(verifier)`. Releases the
 *      sealed-state-volume master key ONLY when trusted TEE evidence is present.
 *      For a confidential-compute deployment where the vault sits on an
 *      attestation-gated sealed volume: the key is bound to the measured
 *      agent/policy/device identity, so absent or tampered attestation yields
 *      NO key (fail-closed) — never a fallback key. The TEE trust decision lives
 *      in the agent runtime (`packages/agent/src/services/tee-*`), which vault
 *      must not import; the caller injects it through the
 *      {@link TeeAttestationVerifier} interface.
 *
 * `defaultMasterKey()` walks 1 → 2 and throws a single
 * `MasterKeyUnavailableError` with both paths' diagnostic messages when
 * neither is available. Operators see a single line that names every
 * remediation option. The attestation resolver is opt-in (the caller wires it),
 * not part of the default walk, because it requires the agent's TEE policy to be
 * injected.
 */

export interface MasterKeyResolver {
  load(): Promise<Buffer>;
  describe(): string;
}

export class MasterKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyUnavailableError";
  }
}

export function inMemoryMasterKey(key: Buffer): MasterKeyResolver {
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyUnavailableError(
      `inMemoryMasterKey: expected ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return {
    async load() {
      return key;
    },
    describe() {
      return "inMemory";
    },
  };
}

/**
 * Injected TEE trust boundary for {@link attestationMasterKey}. The vault
 * package is a leaf and must NOT depend on `@elizaos/agent` / `@elizaos/core`,
 * so the attestation policy + sealed-volume key-release path is supplied by the
 * caller (the agent wires its `evaluateTeeEvidencePolicy` / boot-gate state and
 * `unsealStateVolumeKey` here).
 *
 * Contract (fail-closed):
 *
 *   - `releaseSealedVolumeKey()` MUST resolve with the 32-byte sealed-volume
 *     master key ONLY when fresh TEE evidence is trusted by the agent's policy.
 *   - It MUST reject (throw) when attestation is absent, stale, simulated, or
 *     tampered, or when the boot gate already blocked secrets. It MUST NEVER
 *     resolve with a fallback / default / host-readable key — the negative path
 *     is "no key", enforced by the agent's key-release client refusing to
 *     release one.
 *
 * `attestationMasterKey` adds only shape/length validation on top: a verifier
 * that returns a non-32-byte buffer is a programming error and is rejected.
 */
export interface TeeAttestationVerifier {
  /**
   * Release the sealed-state-volume master key, gated on trusted TEE evidence.
   * Rejects (never returns a fallback key) when attestation is missing/tampered.
   */
  releaseSealedVolumeKey(): Promise<Buffer>;
  /** Short identifier for diagnostics/`describe()`, e.g. `"tdx-dstack"`. */
  describe(): string;
}

/**
 * Attestation-bound master key (resolver #4). Releases the sealed-volume master
 * key ONLY when the injected {@link TeeAttestationVerifier} confirms trusted TEE
 * evidence. When attestation is absent or tampered the verifier rejects, and
 * this resolver surfaces a {@link MasterKeyUnavailableError} — it never falls
 * back to an unsealed or default key. This is the vault-side half of the
 * confidential-compute sealed-volume contract; the trust decision itself is the
 * agent's `tee-*` policy path, injected via `verifier`.
 */
export function attestationMasterKey(
  verifier: TeeAttestationVerifier,
): MasterKeyResolver {
  return {
    async load() {
      let key: Buffer;
      try {
        key = await verifier.releaseSealedVolumeKey();
      } catch (err) {
        // Fail closed: a refused/absent/tampered attestation means the key is
        // UNAVAILABLE. Never substitute a fallback key.
        throw new MasterKeyUnavailableError(
          `attestation-bound master key unavailable (${verifier.describe()}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
        throw new MasterKeyUnavailableError(
          `attestationMasterKey: verifier (${verifier.describe()}) returned ${
            Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key
          }, expected a ${KEY_BYTES}-byte Buffer`,
        );
      }
      return key;
    },
    describe() {
      return `attestation://${verifier.describe()}`;
    },
  };
}

export interface OsKeychainOptions {
  /** Service name shown in the OS keychain UI. Default: "eliza". */
  readonly service?: string;
  /** Account/account name within the service. Default: "vault.masterKey". */
  readonly account?: string;
}

export interface PassphraseOptions {
  /**
   * Passphrase string. Typically read from `process.env.ELIZA_VAULT_PASSPHRASE`.
   * Must be at least 12 characters; shorter passphrases are rejected to
   * push operators away from trivially-brute-forceable keys.
   */
  readonly passphrase: string;
  /**
   * Salt for the scrypt KDF. Default: derived from the service identifier
   * so two distinct services on the same host with the same passphrase
   * still produce different keys. Override only if you know what you're
   * doing — changing the salt invalidates every value already in the
   * vault.
   */
  readonly salt?: string;
  /**
   * scrypt cost. Default 2^15 = 32_768 — same order of magnitude as 1Password's
   * recommendation for a master password derivation, comfortably below the
   * default 64MB memory cap on Node's scrypt. Override for tests if needed.
   */
  readonly cost?: number;
  /** Service identifier used as the default salt prefix. Default `"eliza"`. */
  readonly service?: string;
}

const PASSPHRASE_MIN_LENGTH = 12;
const DEFAULT_SCRYPT_COST = 1 << 15;
const DEFAULT_SCRYPT_BLOCK_SIZE = 8;
const DEFAULT_SCRYPT_PARALLELIZATION = 1;

/**
 * Master key derived from a passphrase via scrypt. Use this when no OS
 * keychain is available — typically headless Linux servers or containers.
 *
 * The same passphrase + salt + cost always produces the same key, so
 * operators MUST keep their passphrase stable across restarts (otherwise
 * existing ciphertext can no longer be decrypted).
 */
export function passphraseMasterKey(
  opts: PassphraseOptions,
): MasterKeyResolver {
  if (typeof opts.passphrase !== "string") {
    throw new MasterKeyUnavailableError(
      "passphraseMasterKey: passphrase must be a string",
    );
  }
  if (opts.passphrase.length < PASSPHRASE_MIN_LENGTH) {
    throw new MasterKeyUnavailableError(
      `passphraseMasterKey: passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters`,
    );
  }
  const service = opts.service ?? "eliza";
  const salt = opts.salt ?? `${service}.vault.masterKey.v1`;
  const cost = opts.cost ?? DEFAULT_SCRYPT_COST;
  return {
    async load() {
      // scryptSync is intentional: this runs once per process at vault
      // construction. Using the async variant adds noise without
      // measurable benefit on a one-shot derivation.
      try {
        // N=32_768 r=8 needs ~32MB, exactly Node's default `maxmem` cap, which
        // OpenSSL rejects with MEMORY_LIMIT_EXCEEDED. Raise the cap to 64MB so
        // the default cost works on every platform.
        const derived = scryptSync(opts.passphrase, salt, KEY_BYTES, {
          N: cost,
          r: DEFAULT_SCRYPT_BLOCK_SIZE,
          p: DEFAULT_SCRYPT_PARALLELIZATION,
          maxmem: 64 * 1024 * 1024,
        });
        if (derived.length !== KEY_BYTES) {
          throw new MasterKeyUnavailableError(
            `passphraseMasterKey: scrypt returned ${derived.length} bytes, expected ${KEY_BYTES}`,
          );
        }
        return derived;
      } catch (err) {
        if (err instanceof MasterKeyUnavailableError) throw err;
        throw new MasterKeyUnavailableError(
          `passphraseMasterKey: scrypt derivation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    describe() {
      return `passphrase://${service}`;
    },
  };
}

/**
 * Construct a passphrase resolver from `ELIZA_VAULT_PASSPHRASE` env. Returns
 * `null` when the env var is absent or empty so callers can fall through
 * to the next strategy without a try/catch dance.
 */
export function passphraseMasterKeyFromEnv(
  service?: string,
): MasterKeyResolver | null {
  const raw = process.env.ELIZA_VAULT_PASSPHRASE;
  if (!raw || raw.length === 0) return null;
  return passphraseMasterKey({
    passphrase: raw,
    ...(service ? { service } : {}),
  });
}

/**
 * Detects hosts where invoking `@napi-rs/keyring` is known to crash the
 * process at the native level instead of throwing a catchable JS error:
 *
 *   - explicit opt-out via `ELIZA_VAULT_DISABLE_KEYCHAIN=1`
 *   - headless Linux with no reachable D-Bus session (the libsecret
 *     backend aborts at the C level when it can't reach the Secret
 *     Service)
 *
 * D-Bus reachability on Linux is checked two ways:
 *
 *   1. `DBUS_SESSION_BUS_ADDRESS` env var — the classical signal,
 *      reliably set by desktop session startup and `dbus-launch`.
 *   2. `$XDG_RUNTIME_DIR/bus` socket — modern systemd user sessions
 *      socket-activate D-Bus and don't always export the env var
 *      (notably SSH sessions without env forwarding, and Fedora /
 *      Arch / Ubuntu 22+ desktops). Treat the socket file's presence
 *      as equivalent to the env var.
 *
 * This is intentionally a heuristic: it never returns `false` (safe)
 * for a host that would actually crash, and may return `false` (safe)
 * for a host where the keychain ultimately fails with a regular JS
 * error. That's the desired direction — we'd rather attempt the
 * keychain and let the existing try/catch handle a JS-level failure
 * than refuse on a host where it would have worked.
 */
function isKeychainUnsafe(): boolean {
  if (process.env.ELIZA_VAULT_DISABLE_KEYCHAIN === "1") return true;
  if (process.platform !== "linux") return false;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && existsSync(join(xdgRuntime, "bus"))) return false;
  return true;
}

function keychainUnsafeMessage(prefix: string): string {
  return `${prefix}OS keychain is unsafe on this host (headless Linux with no reachable D-Bus session, or ELIZA_VAULT_DISABLE_KEYCHAIN=1). Set ELIZA_VAULT_PASSPHRASE (≥${PASSPHRASE_MIN_LENGTH} chars) to enable a passphrase-derived master key, or pass an inMemoryMasterKey.`;
}

async function readMacOSKeychainPassword(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8" },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr ?? err);
    if (
      stderr.includes("could not be found") ||
      stderr.includes("The specified item could not be found")
    ) {
      return null;
    }
    throw new MasterKeyUnavailableError(
      `macOS keychain read failed (${service}/${account}): ${stderr.trim()}`,
    );
  }
}

function writeMacOSKeychainPassword(
  service: string,
  account: string,
  password: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use the system `security` tool instead of @napi-rs/keyring on macOS.
    // Keychain ACLs are tied to the requesting binary; dev Bun paths change
    // often enough that the native binding can trigger a GUI prompt on every
    // boot. `/usr/bin/security` is stable and commonly already trusted by the
    // item ACL. Password data goes through stdin, not argv.
    const child = spawn(
      "/usr/bin/security",
      ["add-generic-password", "-s", service, "-a", account, "-U", "-w"],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
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
        new MasterKeyUnavailableError(
          `macOS keychain write failed (${service}/${account}): ${
            stderr.trim() || `security exited ${code}`
          }`,
        ),
      );
    });
    child.stdin.on("error", () => {});
    child.stdin.write(`${password}\n${password}\n`, () => {
      child.stdin.end();
    });
  });
}

/**
 * Default resolver: try the OS keychain first, then a passphrase-derived
 * key from `ELIZA_VAULT_PASSPHRASE`. If both fail, throws a single
 * `MasterKeyUnavailableError` whose message lists every remediation
 * option so operators on a fresh headless box see one actionable line.
 *
 * Tests should NOT use this — pass `inMemoryMasterKey(...)` to
 * `createVault()` directly. Production paths that already inject a
 * resolver are unaffected.
 */
export function defaultMasterKey(
  opts: OsKeychainOptions = {},
): MasterKeyResolver {
  const keychain = osKeychainMasterKey(opts);
  return {
    async load() {
      // Skip the OS keychain on hosts where @napi-rs/keyring is known to
      // segfault the process instead of throwing a catchable JS error.
      // The defensive try/catch around keychain.load() can't help once
      // the native crash fires.
      if (isKeychainUnsafe()) {
        const passphrase = passphraseMasterKeyFromEnv(opts.service);
        if (passphrase) return passphrase.load();
        throw new MasterKeyUnavailableError(keychainUnsafeMessage("vault: "));
      }
      try {
        return await keychain.load();
      } catch (keychainErr) {
        const passphrase = passphraseMasterKeyFromEnv(opts.service);
        if (passphrase) {
          try {
            return await passphrase.load();
          } catch (passphraseErr) {
            throw new MasterKeyUnavailableError(
              `vault master key unavailable. Keychain: ${
                keychainErr instanceof Error
                  ? keychainErr.message
                  : String(keychainErr)
              }. Passphrase: ${
                passphraseErr instanceof Error
                  ? passphraseErr.message
                  : String(passphraseErr)
              }.`,
            );
          }
        }
        throw new MasterKeyUnavailableError(
          `vault master key unavailable. ${
            keychainErr instanceof Error
              ? keychainErr.message
              : String(keychainErr)
          } To use a passphrase-derived key on a headless host, set ELIZA_VAULT_PASSPHRASE (≥${PASSPHRASE_MIN_LENGTH} chars) and restart.`,
        );
      }
    },
    describe() {
      // describe() reflects the runtime-selected path. On hosts where
      // the keychain is bypassed, surfacing `keychain://...` would
      // misrepresent which resolver actually ran.
      const passphrase = passphraseMasterKeyFromEnv(opts.service);
      if (isKeychainUnsafe()) {
        return passphrase
          ? `${passphrase.describe()} (keychain bypassed: host unsafe)`
          : `unavailable (keychain bypassed: host unsafe; no ELIZA_VAULT_PASSPHRASE set)`;
      }
      return passphrase
        ? `${keychain.describe()} (fallback: ${passphrase.describe()})`
        : keychain.describe();
    },
  };
}

export function osKeychainMasterKey(
  opts: OsKeychainOptions = {},
): MasterKeyResolver {
  const service = opts.service ?? "eliza";
  const account = opts.account ?? "vault.masterKey";
  return {
    async load() {
      // Refuse to invoke the native binding on hosts where it crashes
      // the process. Direct callers of `osKeychainMasterKey` (plugins,
      // integrations) get the same protection as `defaultMasterKey`.
      if (isKeychainUnsafe()) {
        throw new MasterKeyUnavailableError(
          keychainUnsafeMessage(`OS keychain (${service}/${account}): `),
        );
      }
      if (process.platform === "darwin") {
        const existing = await readMacOSKeychainPassword(service, account);
        if (existing && existing.length > 0) {
          const buf = Buffer.from(existing, "base64");
          if (buf.length !== KEY_BYTES) {
            throw new MasterKeyUnavailableError(
              `OS keychain entry ${service}/${account} is not a ${KEY_BYTES}-byte key`,
            );
          }
          return buf;
        }
        const created = generateMasterKey();
        await writeMacOSKeychainPassword(
          service,
          account,
          created.toString("base64"),
        );
        return created;
      }
      let Entry: typeof import("@napi-rs/keyring").Entry;
      try {
        ({ Entry } = await import("@napi-rs/keyring"));
      } catch (err) {
        throw new MasterKeyUnavailableError(
          `OS keychain binding unavailable (${service}/${account}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      let entry: InstanceType<typeof Entry>;
      try {
        entry = new Entry(service, account);
      } catch (err) {
        throw new MasterKeyUnavailableError(
          `OS keychain entry construction failed (${service}/${account}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      let existing: string | null = null;
      try {
        existing = entry.getPassword();
      } catch (err) {
        throw new MasterKeyUnavailableError(
          `OS keychain read failed (${service}/${account}): ${
            err instanceof Error ? err.message : String(err)
          }. On Linux, ensure libsecret + a Secret Service agent (gnome-keyring / kwallet) is running, or pass an inMemoryMasterKey.`,
        );
      }
      if (existing && existing.length > 0) {
        const buf = Buffer.from(existing, "base64");
        if (buf.length !== KEY_BYTES) {
          throw new MasterKeyUnavailableError(
            `OS keychain entry ${service}/${account} is not a ${KEY_BYTES}-byte key`,
          );
        }
        return buf;
      }
      const created = generateMasterKey();
      try {
        entry.setPassword(created.toString("base64"));
      } catch (err) {
        throw new MasterKeyUnavailableError(
          `OS keychain write failed (${service}/${account}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return created;
    },
    describe() {
      return `keychain://${service}/${account}`;
    },
  };
}
