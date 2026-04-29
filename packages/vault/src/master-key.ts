import { Entry } from "@napi-rs/keyring";
import { generateMasterKey, KEY_BYTES } from "./crypto.js";

/**
 * Where the encryption master key lives.
 *
 * Default: OS keychain (cross-platform via @napi-rs/keyring — macOS
 * Keychain, Windows Credential Manager, Linux Secret Service). On first
 * run, generates a fresh 32-byte key and stores it under
 * `service: "milady"`, `account: "vault.masterKey"`. Subsequent runs
 * read it back.
 *
 * For tests, supply an in-memory key via `inMemoryMasterKey(buffer)`.
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

export interface OsKeychainOptions {
  /** Service name shown in the OS keychain UI. Default: "milady". */
  readonly service?: string;
  /** Account/account name within the service. Default: "vault.masterKey". */
  readonly account?: string;
}

export function osKeychainMasterKey(opts: OsKeychainOptions = {}): MasterKeyResolver {
  const service = opts.service ?? "milady";
  const account = opts.account ?? "vault.masterKey";
  return {
    async load() {
      let entry: Entry;
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
