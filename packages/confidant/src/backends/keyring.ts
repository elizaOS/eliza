import { Entry } from "@napi-rs/keyring";
import { parseReference } from "../references.js";
import type { VaultReference } from "../types.js";
import {
  BackendError,
  BackendNotConfiguredError,
  type VaultBackend,
} from "./types.js";

/**
 * KeyringBackend persists literals as OS-keychain entries. Reference shape:
 *
 *   keyring://{service}/{account}
 *
 * Cross-platform via `@napi-rs/keyring`:
 *   - macOS: Keychain Services
 *   - Windows: Credential Manager
 *   - Linux: Secret Service (libsecret + gnome-keyring / kwallet)
 *
 * The backend itself is dumb: it constructs an `Entry(service, account)` and
 * calls `getPassword` / `setPassword` / `deleteCredential`. It does not
 * shell out, so there is no argv-injection surface to defend.
 *
 * Headless Linux without a running Secret Service agent will see the
 * underlying call throw; we re-throw as `BackendNotConfiguredError` so
 * higher layers can degrade to a passphrase-derived master key (phase 1).
 *
 * `defaultService` is supplied by the caller (the runtime supplies a
 * branding-aware service name like `elizaos`); `store(id, value)` writes
 * under that service with `account = id`.
 */
export class KeyringBackend implements VaultBackend {
  readonly source = "keyring" as const;

  constructor(private readonly defaultService: string = "elizaos") {}

  async resolve(ref: VaultReference): Promise<string> {
    const { service, account } = parseKeyringRef(ref);
    let value: string | null;
    try {
      value = new Entry(service, account).getPassword();
    } catch (err) {
      throw mapKeyringError(err, `read keychain entry ${service}/${account}`);
    }
    if (value === null || value.length === 0) {
      throw new BackendError(
        this.source,
        `keychain entry ${service}/${account} is empty`,
      );
    }
    return value;
  }

  async store(id: string, value: string): Promise<VaultReference> {
    const account = id;
    const service = this.defaultService;
    try {
      new Entry(service, account).setPassword(value);
    } catch (err) {
      throw mapKeyringError(err, `write keychain entry ${service}/${account}`);
    }
    return `keyring://${service}/${account}`;
  }

  async remove(ref: VaultReference): Promise<void> {
    const { service, account } = parseKeyringRef(ref);
    try {
      new Entry(service, account).deleteCredential();
    } catch (err) {
      // Idempotent: missing entries are not an error.
      if (isNoEntryError(err)) return;
      throw mapKeyringError(err, `delete keychain entry ${service}/${account}`);
    }
  }
}

function parseKeyringRef(ref: VaultReference): {
  service: string;
  account: string;
} {
  const parsed = parseReference(ref);
  if (parsed.source !== "keyring") {
    throw new BackendError("keyring", `cannot resolve ref ${ref}`);
  }
  // Split on the LAST `/` so service names containing slashes
  // (e.g., `@elizaos/confidant`) are handled. Account names may not
  // contain slashes.
  const slash = parsed.path.lastIndexOf("/");
  if (slash <= 0 || slash === parsed.path.length - 1) {
    throw new BackendError(
      "keyring",
      `keyring reference ${JSON.stringify(ref)} must be keyring://<service>/<account>`,
    );
  }
  return {
    service: parsed.path.slice(0, slash),
    account: parsed.path.slice(slash + 1),
  };
}

function mapKeyringError(err: unknown, action: string): BackendError {
  const message = err instanceof Error ? err.message : String(err);
  // `@napi-rs/keyring` surfaces the OS error as message text; the most
  // common Linux failure mode is "no Secret Service agent" which we want to
  // distinguish from "real failure" so the caller can offer a passphrase
  // fallback. The library doesn't expose a structured error code, so we
  // keyword-match on the message.
  if (
    /no.*service|no.*backend|service.*not.*available|connection.*refused/i.test(
      message,
    )
  ) {
    return new BackendNotConfiguredError(
      "keyring",
      `${action}: OS keychain unavailable (${message}). On Linux, ensure libsecret + a Secret Service agent (gnome-keyring / kwallet) is running, or pass an inMemoryMasterKey.`,
    );
  }
  return new BackendError("keyring", `${action} failed: ${message}`);
}

function isNoEntryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no\s*entry|not\s*found|does\s*not\s*exist/i.test(message);
}
