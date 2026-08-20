/** Fixed, non-user-controlled account names accepted by the native bridge. */
export type ElizaSecureStoreKey =
  | "session.device_auth"
  | "session.steward_token"
  | "runtime.active_server"
  | "runtime.agent_profiles";

export type ElizaSecureStoreError =
  | "not_found"
  | "denied"
  | "invalid_input"
  | "unavailable"
  | "native_error";

export interface ElizaSecureStoreResult {
  ok: boolean;
  value?: string;
  error?: ElizaSecureStoreError;
  message?: string;
}

export interface ElizaSecureStoreStatus {
  ok: boolean;
  available: boolean;
  backend: "apple_keychain" | "unavailable";
  accessibility: "after_first_unlock_this_device_only" | "unavailable";
  synchronized: false;
  accessGroup: "app_only";
  error?: ElizaSecureStoreError;
  message?: string;
}

export interface ElizaSecureStorePlugin {
  get(options: { key: ElizaSecureStoreKey }): Promise<ElizaSecureStoreResult>;
  set(options: {
    key: ElizaSecureStoreKey;
    value: string;
  }): Promise<ElizaSecureStoreResult>;
  remove(options: {
    key: ElizaSecureStoreKey;
  }): Promise<ElizaSecureStoreResult>;
  status(): Promise<ElizaSecureStoreStatus>;
}
