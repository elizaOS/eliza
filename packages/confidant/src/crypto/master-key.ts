import type { Entry as EntryType } from "@napi-rs/keyring";
import { isKeychainUnsafe, KEYCHAIN_UNSAFE_MESSAGE } from "../keychain-host.js";
import { generateMasterKey, KEY_BYTES } from "./envelope.js";

/**
 * Source of the master key for the FileBackend's at-rest encryption.
 *
 * - `keyring`: 32 bytes stored as a single OS-keychain entry. Cross-platform
 *   via `@napi-rs/keyring` — macOS Keychain, Windows Credential Manager,
 *   Linux Secret Service (libsecret). The recommended source.
 * - `inMemory`: 32-byte buffer supplied by the caller. Intended for tests
 *   and headless deployments that derive the key out-of-band.
 *
 * A passphrase-derived resolver (scrypt) is planned for phase 1 — it
 * materializes a key from a user passphrase + persistent salt, for hosts
 * with no usable secret service.
 */

export interface MasterKeyResolver {
  readonly load: () => Promise<Buffer>;
  readonly describe: () => string;
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
    load: async () => key,
    describe: () => "inMemory",
  };
}

export interface KeyringMasterKeyOptions {
  /** Service name surfaced in the OS keychain UI. */
  readonly service: string;
  /** Account/username slot within the service. */
  readonly account: string;
}

/**
 * Cross-platform OS-keychain resolver. Backed by `@napi-rs/keyring` which
 * uses macOS Keychain, Windows Credential Manager, and Linux Secret Service
 * via a single API.
 *
 * On first use, generates a fresh 32-byte key and writes it to the keychain
 * slot. Subsequent loads read it back. If the platform has no usable secret
 * service (e.g., headless Linux without libsecret + a service-bus agent),
 * the underlying call throws and the caller should supply an
 * `inMemoryMasterKey` derived elsewhere.
 */
export function osKeyringMasterKey(
  opts: KeyringMasterKeyOptions,
): MasterKeyResolver {
  return {
    load: async () => await loadOrCreateKeychainEntry(opts),
    describe: () => `keyring://${opts.service}/${opts.account}`,
  };
}

async function loadOrCreateKeychainEntry(opts: KeyringMasterKeyOptions): Promise<Buffer> {
  // Dodge headless-Linux native segfaults from libsecret. The OS keychain
  // backend is unsafe on hosts without a reachable D-Bus session because
  // the native binding crashes the process before throwing a catchable
  // JS error.
  if (isKeychainUnsafe()) {
    throw new MasterKeyUnavailableError(
      `${KEYCHAIN_UNSAFE_MESSAGE} Supply an inMemoryMasterKey instead.`,
    );
  }

  // Lazy-load the native binding so just importing this module doesn't
  // initialize @napi-rs/keyring on hosts where it would crash.
  let Entry: typeof import("@napi-rs/keyring").Entry;
  try {
    ({ Entry } = await import("@napi-rs/keyring"));
  } catch (err) {
    throw new MasterKeyUnavailableError(
      `OS keychain binding unavailable for ${opts.service}/${opts.account}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let entry: EntryType;
  try {
    entry = new Entry(opts.service, opts.account);
  } catch (err) {
    throw new MasterKeyUnavailableError(
      `OS keychain entry construction failed for ${opts.service}/${opts.account}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let existing: string | null = null;
  try {
    existing = entry.getPassword();
  } catch (err) {
    throw new MasterKeyUnavailableError(
      `Failed to read OS keychain entry ${opts.service}/${opts.account}: ${
        err instanceof Error ? err.message : String(err)
      }. On Linux, ensure libsecret + a Secret Service agent (gnome-keyring / kwallet) is running, or supply an inMemoryMasterKey.`,
    );
  }

  if (existing && existing.length > 0) {
    const buf = Buffer.from(existing, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new MasterKeyUnavailableError(
        `Keychain entry ${opts.service}/${opts.account} is not a ${KEY_BYTES}-byte key (got ${buf.length} bytes after base64 decode). Refusing to use.`,
      );
    }
    return buf;
  }

  const created = generateMasterKey();
  try {
    entry.setPassword(created.toString("base64"));
  } catch (err) {
    throw new MasterKeyUnavailableError(
      `Failed to persist OS keychain entry ${opts.service}/${opts.account}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return created;
}
