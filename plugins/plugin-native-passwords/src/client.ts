/**
 * Validating wrapper around the native bridge. Responses are rebuilt from allowlisted fields,
 * and any response carrying a secret-like key is rejected outright, so a native regression
 * cannot leak a secret into renderer state, agent context, logs or crash reports.
 */
import type {
  ElizaPasswordsPlugin,
  PasswordBinding,
  PasswordEntrySummary,
  PasswordSaveInput,
  PasswordSaveResult,
  PasswordsErrorCode,
  PasswordsStatus,
} from "./definitions";

/** Keys that must never appear in any bridge response or agent-facing payload. */
export const SECRET_FIELD_NAMES: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "totp",
  "otp",
  "otpsecret",
  "passkey",
  "privatekey",
  "credential",
  "credentials",
];

export class PasswordsClientError extends Error {
  readonly code: PasswordsErrorCode;
  constructor(code: PasswordsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PasswordsClientError";
  }
}

/** Throws if any object key at any depth names a secret. Arrays and objects are walked. */
export function assertNoSecretFields(value: unknown, depth = 0): void {
  if (depth > 12)
    throw new PasswordsClientError(
      "unavailable",
      "Saved passwords are unavailable.",
    );
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretFields(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_FIELD_NAMES.includes(key.toLowerCase().replace(/[^a-z]/g, "")))
      throw new PasswordsClientError(
        "unavailable",
        "Saved passwords are unavailable.",
      );
    assertNoSecretFields(item, depth + 1);
  }
}

const text = (value: unknown, max = 1024): string => {
  if (typeof value !== "string" || value.length > max)
    throw new PasswordsClientError(
      "unavailable",
      "Saved passwords are unavailable.",
    );
  return value;
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

function binding(value: unknown): PasswordBinding {
  const item = (value || {}) as Record<string, unknown>;
  const kind =
    item.kind === "android" ? "android" : item.kind === "web" ? "web" : null;
  if (!kind)
    throw new PasswordsClientError(
      "unavailable",
      "Saved passwords are unavailable.",
    );
  return {
    kind,
    facet: text(item.facet, 512),
    display: text(item.display, 512),
  };
}

export function parseEntries(value: unknown): PasswordEntrySummary[] {
  assertNoSecretFields(value);
  const entries = (value as { entries?: unknown })?.entries;
  if (!Array.isArray(entries) || entries.length > 1000)
    throw new PasswordsClientError(
      "unavailable",
      "Saved passwords are unavailable.",
    );
  return entries.map((raw) => {
    const item = (raw || {}) as Record<string, unknown>;
    if (!Array.isArray(item.bindings) || item.bindings.length > 20)
      throw new PasswordsClientError(
        "unavailable",
        "Saved passwords are unavailable.",
      );
    const bindings = item.bindings.map(binding);
    return {
      id: text(item.id, 128),
      label: text(item.label, 200),
      username: text(item.username),
      bindings,
      updatedAt: count(item.updatedAt),
    };
  });
}

export function parseStatus(value: unknown): PasswordsStatus {
  assertNoSecretFields(value);
  const item = (value || {}) as Record<string, unknown>;
  const autofill = (item.autofill || {}) as Record<string, unknown>;
  const selected = ["this-app", "other", "none"].includes(
    autofill.selected as string,
  )
    ? (autofill.selected as PasswordsStatus["autofill"]["selected"])
    : "unknown";
  return {
    available: item.available === true,
    ...(item.reason === "no-screen-lock" || item.reason === "unsupported"
      ? { reason: item.reason }
      : {}),
    locked: item.locked !== false,
    unlockRemainingMs: count(item.unlockRemainingMs),
    unlockSeconds: count(item.unlockSeconds),
    biometric: item.biometric === true,
    autofill: {
      supported:
        typeof autofill.supported === "boolean" ? autofill.supported : null,
      selected,
    },
  };
}

const CODES: readonly PasswordsErrorCode[] = [
  "locked",
  "cancelled",
  "no-screen-lock",
  "invalid",
  "key-invalidated",
  "busy",
  "unavailable",
];

/** Maps any bridge failure to a fixed code and a message that never echoes inputs. */
export function passwordsError(error: unknown): PasswordsClientError {
  if (error instanceof PasswordsClientError) return error;
  const raw = (error as { code?: unknown })?.code;
  const code = CODES.includes(raw as PasswordsErrorCode)
    ? (raw as PasswordsErrorCode)
    : "unavailable";
  const messages: Record<PasswordsErrorCode, string> = {
    locked: "Unlock saved passwords first.",
    cancelled: "Unlock was cancelled.",
    "no-screen-lock": "Set a screen lock to use saved passwords.",
    invalid: "Check the entry and try again.",
    "key-invalidated":
      "Saved passwords can no longer be decrypted on this device.",
    busy: "Finish the current unlock first.",
    unavailable: "Saved passwords are unavailable.",
  };
  // Native validation messages are fixed strings; still only pass through known-safe ones.
  const message = (error as { message?: unknown })?.message;
  const safe =
    code === "invalid" &&
    typeof message === "string" &&
    /^[A-Za-z ,.'-]{1,80}$/.test(message)
      ? message
      : messages[code];
  return new PasswordsClientError(code, safe);
}

async function call<T>(
  run: () => Promise<unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  let value: unknown;
  try {
    value = await run();
  } catch (error) {
    throw passwordsError(error);
  }
  return parse(value);
}

const ack =
  <K extends string>(key: K) =>
  (value: unknown) => {
    assertNoSecretFields(value);
    if ((value as Record<string, unknown>)?.[key] !== true)
      throw new PasswordsClientError(
        "unavailable",
        "Saved passwords are unavailable.",
      );
    return value as Record<K, true>;
  };

export interface PasswordsClient {
  status(): Promise<PasswordsStatus>;
  unlock(): Promise<{ unlockRemainingMs: number }>;
  lock(): Promise<void>;
  list(): Promise<PasswordEntrySummary[]>;
  save(input: PasswordSaveInput): Promise<PasswordSaveResult>;
  remove(id: string): Promise<void>;
  reset(): Promise<void>;
  reveal(id: string): Promise<{ hidesAfterMs: number }>;
  copy(id: string): Promise<{ clearsAfterMs: number }>;
  openAutofillSettings(): Promise<{
    destination: "autofill-picker" | "system-settings";
  }>;
}

export function createPasswordsClient(
  plugin: ElizaPasswordsPlugin,
): PasswordsClient {
  return {
    status: () => call(() => plugin.status(), parseStatus),
    unlock: () =>
      call(
        () => plugin.unlock(),
        (value) => ({
          unlockRemainingMs: count(
            ack("unlocked")(value) &&
              (value as Record<string, unknown>).unlockRemainingMs,
          ),
        }),
      ),
    lock: () =>
      call(
        () => plugin.lock(),
        (value) => void ack("locked")(value),
      ),
    list: () => call(() => plugin.list(), parseEntries),
    save: (input) => {
      if (input.password !== undefined && input.generate !== undefined)
        return Promise.reject(
          new PasswordsClientError(
            "invalid",
            "Choose a typed or generated password.",
          ),
        );
      return call(
        () => plugin.save(input),
        (value) => {
          assertNoSecretFields(value);
          const item = (value || {}) as Record<string, unknown>;
          return {
            id: text(item.id, 128),
            ...(item.generated === true
              ? { generated: true as const, length: count(item.length) }
              : {}),
          };
        },
      );
    },
    remove: (id) =>
      call(
        () => plugin.remove({ id }),
        (value) => void ack("removed")(value),
      ),
    reset: () =>
      call(
        () => plugin.reset(),
        (value) => void ack("reset")(value),
      ),
    reveal: (id) =>
      call(
        () => plugin.reveal({ id }),
        (value) => ({
          hidesAfterMs: count(
            ack("shown")(value) &&
              (value as Record<string, unknown>).hidesAfterMs,
          ),
        }),
      ),
    copy: (id) =>
      call(
        () => plugin.copy({ id }),
        (value) => ({
          clearsAfterMs: count(
            ack("copied")(value) &&
              (value as Record<string, unknown>).clearsAfterMs,
          ),
        }),
      ),
    openAutofillSettings: () =>
      call(
        () => plugin.openAutofillSettings(),
        (value) => {
          assertNoSecretFields(value);
          const item = (value || {}) as Record<string, unknown>;
          if (item.status !== "opened")
            throw new PasswordsClientError(
              "unavailable",
              "Android settings did not open.",
            );
          return {
            destination:
              item.destination === "autofill-picker"
                ? ("autofill-picker" as const)
                : ("system-settings" as const),
          };
        },
      ),
  };
}
