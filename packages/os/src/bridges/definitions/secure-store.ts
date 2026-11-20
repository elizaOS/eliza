// spec/os/android/secureStore.md, "The app view names only slots its consumer policy opens to it, and never a delegation slot"; spec/os/android/secureStore.md, "A compare-and-exchange changes a slot only when it holds exactly the expected value"; spec/os/android/secureStore.md, "A write is acknowledged only after it reads back exactly, and a removal only after every file of the slot is gone"
import type { ExchangeOutcome } from "../../../gen/os__android__secureStore.ts";

export type { ExchangeOutcome };

/** A slot name, 1 to 1024 UTF-16 units; the host's consumer policy decides what the app view may do with it. */
export type ElizaSecureStoreKey = string;

export type ElizaSecureStoreReadError = "not_found" | "unreadable" | "denied" | "unavailable";

export type ElizaSecureStoreError = "conflict" | "storage_full" | "denied" | "native_error" | "unconfirmed" | "unavailable";

/** `value` is exactly one serialized JSON value. */
export type ElizaSecureStoreRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: ElizaSecureStoreReadError };

/** `outcome` is absent only when the plugin could not load the host's policy. */
export type ElizaSecureStoreResult =
  | { readonly ok: true; readonly outcome: Extract<ExchangeOutcome, "Written" | "Removed"> }
  | { readonly ok: false; readonly error: ElizaSecureStoreError; readonly outcome?: Exclude<ExchangeOutcome, "Written" | "Removed"> };

export type ElizaSecureStoreStatus =
  | {
    readonly ok: true;
    readonly available: true;
    readonly backend: "android_keystore";
    readonly accessibility: "credential_encrypted_device_only";
    readonly synchronized: false;
    readonly accessGroup: "app_only";
  }
  | {
    readonly ok: false;
    readonly available: false;
    readonly error: "unavailable";
    readonly backend: "unavailable";
    readonly accessibility: "unavailable";
    readonly synchronized: false;
    readonly accessGroup: "app_only";
  };

export interface ElizaSecureStoreExchange {
  readonly key: ElizaSecureStoreKey;
  /** The exact stored text the caller last read, or null when it expects the slot to be absent. */
  readonly expected: string | null;
  /** The new serialized JSON value, or null to remove the slot. */
  readonly value: string | null;
}

export interface ElizaSecureStorePlugin {
  get(options: { key: ElizaSecureStoreKey }): Promise<ElizaSecureStoreRead>;
  set(options: { key: ElizaSecureStoreKey; value: string }): Promise<ElizaSecureStoreResult>;
  remove(options: { key: ElizaSecureStoreKey }): Promise<ElizaSecureStoreResult>;
  compareAndExchange(options: ElizaSecureStoreExchange): Promise<ElizaSecureStoreResult>;
  status(): Promise<ElizaSecureStoreStatus>;
}
