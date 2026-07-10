/**
 * SQLCipher key acquisition for the Signal Desktop collector. Signal stores its
 * 256-bit database key in `<Signal>/config.json` — legacy installs keep it in
 * plaintext (`key`), newer installs wrap it with Electron `safeStorage`
 * (`encryptedKey`), which on macOS is Chromium's OSCrypt v10 scheme keyed by a
 * random password held in the login Keychain under the "Signal Safe Storage"
 * service.
 *
 * This module resolves that key without ever persisting it: it reads config.json,
 * and — when the key is wrapped — derives the AES key from the Keychain password
 * and decrypts the v10 blob in-process. The Keychain read is injected as a
 * command runner so the unwrap crypto is exercised deterministically in tests
 * while production shells out to `security`. Nothing here writes the key to disk;
 * the caller holds it only for the lifetime of one collect run.
 */
import { createDecipheriv, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { CollectorError } from "./errors.ts";

/**
 * Chromium OSCrypt v10 parameters (macOS). safeStorage on Electron reuses these
 * exact constants: PBKDF2-HMAC-SHA1 over the Keychain password with a fixed salt
 * and iteration count yields a 128-bit AES-CBC key, and every ciphertext is
 * prefixed with the ASCII version tag and decrypted with an all-spaces IV.
 */
const OSCRYPT_SALT = "saltysalt";
const OSCRYPT_ITERATIONS_MACOS = 1003;
const OSCRYPT_KEY_LENGTH = 16;
const OSCRYPT_IV = Buffer.alloc(16, " ");
const OSCRYPT_VERSION_PREFIX = Buffer.from("v10", "utf8");

export interface SignalConfig {
  /** Plaintext SQLCipher key hex (legacy installs). */
  key?: string;
  /** safeStorage-wrapped SQLCipher key, hex-encoded ciphertext (newer installs). */
  encryptedKey?: string;
}

/** Runs a Keychain lookup; injected so the unwrap path is testable without macOS. */
export type KeychainPasswordReader = (
  service: string,
) => Promise<string> | string;

export interface ResolveKeyOptions {
  configPath: string;
  /** Keychain service holding the safeStorage password; defaults to Signal's. */
  keychainService?: string;
  readKeychainPassword?: KeychainPasswordReader;
}

const SQLCIPHER_KEY_HEX = /^[0-9a-fA-F]{64}$/;

function assertSqlcipherKey(key: string): string {
  const trimmed = key.trim();
  if (!SQLCIPHER_KEY_HEX.test(trimmed)) {
    throw new CollectorError(
      "resolved Signal key is not a 256-bit hex string",
      {
        collectorCode: "key_decrypt_failed",
        platform: "signal",
        context: { keyLength: trimmed.length },
      },
    );
  }
  return trimmed.toLowerCase();
}

/**
 * Decrypt a Chromium/Electron safeStorage v10 blob given the Keychain password.
 * Exposed on its own so the exact OSCrypt scheme can be round-tripped in tests
 * with a known password and ciphertext. Fails closed with a typed error on a
 * missing version prefix or a padding/decrypt failure — a wrong key must never
 * yield a partial or fabricated result.
 */
export function unwrapSafeStorageKey(
  encryptedKey: Buffer,
  keychainPassword: string,
): string {
  if (encryptedKey.length <= OSCRYPT_VERSION_PREFIX.length) {
    throw new CollectorError("safeStorage blob is too short to be v10", {
      collectorCode: "key_decrypt_failed",
      platform: "signal",
      context: { blobBytes: encryptedKey.length },
    });
  }
  const prefix = encryptedKey.subarray(0, OSCRYPT_VERSION_PREFIX.length);
  if (
    prefix.length !== OSCRYPT_VERSION_PREFIX.length ||
    !timingSafeEqual(prefix, OSCRYPT_VERSION_PREFIX)
  ) {
    throw new CollectorError(
      "safeStorage blob missing the v10 version prefix",
      {
        collectorCode: "key_decrypt_failed",
        platform: "signal",
        context: { prefix: prefix.toString("latin1") },
      },
    );
  }

  const derivedKey = pbkdf2Sync(
    keychainPassword,
    OSCRYPT_SALT,
    OSCRYPT_ITERATIONS_MACOS,
    OSCRYPT_KEY_LENGTH,
    "sha1",
  );
  const ciphertext = encryptedKey.subarray(OSCRYPT_VERSION_PREFIX.length);

  try {
    const decipher = createDecipheriv("aes-128-cbc", derivedKey, OSCRYPT_IV);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch (error) {
    // error-policy:J2 wrong Keychain password surfaces as a PKCS7 padding
    // failure; rethrow as a typed fail-closed decrypt error with the cause.
    throw new CollectorError("safeStorage decryption failed", {
      collectorCode: "key_decrypt_failed",
      platform: "signal",
      cause: error,
    });
  }
}

async function readConfig(configPath: string): Promise<SignalConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    throw new CollectorError("Signal config.json is unreadable", {
      collectorCode: "source_missing",
      platform: "signal",
      cause: error,
      context: { configPath },
    });
  }
  // error-policy:J3 config.json is untrusted local state; a parse failure is a
  // typed source error, not a silent fall-through to an empty config.
  try {
    return JSON.parse(raw) as SignalConfig;
  } catch (error) {
    throw new CollectorError("Signal config.json is not valid JSON", {
      collectorCode: "source_missing",
      platform: "signal",
      cause: error,
      context: { configPath },
    });
  }
}

/**
 * Resolve the SQLCipher key from a Signal install directory's config.json,
 * unwrapping the safeStorage-encrypted form via the injected Keychain reader
 * when present. Throws a typed error (never returns a placeholder) if neither a
 * plaintext nor an unwrappable encrypted key is available.
 */
export async function resolveSignalKey(
  options: ResolveKeyOptions,
): Promise<string> {
  const config = await readConfig(options.configPath);

  if (config.key) {
    return assertSqlcipherKey(config.key);
  }

  if (config.encryptedKey) {
    const reader = options.readKeychainPassword;
    if (!reader) {
      throw new CollectorError(
        "Signal key is safeStorage-wrapped but no Keychain reader was provided",
        {
          collectorCode: "key_source_unavailable",
          platform: "signal",
          context: { configPath: options.configPath },
        },
      );
    }
    const service = options.keychainService ?? "Signal Safe Storage";
    const password = await reader(service);
    if (!password) {
      throw new CollectorError(
        "Keychain returned an empty safeStorage password",
        {
          collectorCode: "key_source_unavailable",
          platform: "signal",
          context: { service },
        },
      );
    }
    const decrypted = unwrapSafeStorageKey(
      Buffer.from(config.encryptedKey, "hex"),
      password,
    );
    return assertSqlcipherKey(decrypted);
  }

  throw new CollectorError(
    "Signal config.json has neither a plaintext nor an encrypted key",
    {
      collectorCode: "key_source_unavailable",
      platform: "signal",
      context: { configPath: options.configPath },
    },
  );
}

/**
 * Production Keychain reader: reads the safeStorage password with the macOS
 * `security` tool. Kept as the default injected implementation so the live path
 * uses no third-party dependency, while tests substitute a deterministic reader.
 */
export function macosKeychainPasswordReader(
  runCommand: (
    command: string,
    args: string[],
  ) => Promise<{ stdout: string; status: number }>,
): KeychainPasswordReader {
  return async (service: string) => {
    const result = await runCommand("security", [
      "find-generic-password",
      "-ws",
      service,
    ]);
    if (result.status !== 0) {
      throw new CollectorError("security find-generic-password failed", {
        collectorCode: "key_source_unavailable",
        platform: "signal",
        context: { service, status: result.status },
      });
    }
    return result.stdout.trim();
  };
}
