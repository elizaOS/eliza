/**
 * Fail-closed browser fallback for the native secure store.
 *
 * Every operation reports `unavailable` rather than reaching for a web storage
 * API: `localStorage` and IndexedDB are readable by any script on the origin,
 * so silently degrading to them would turn "stored in the Keychain/Keystore"
 * into "stored in the clear" without the caller ever learning the guarantee
 * changed. Callers must treat `ok: false, error: "unavailable"` as a real
 * absence of secure storage, never as an empty store.
 */
import { WebPlugin } from "@capacitor/core";
import type {
  ElizaSecureStorePlugin,
  ElizaSecureStoreResult,
  ElizaSecureStoreStatus,
} from "./definitions";

const unavailable = (): ElizaSecureStoreResult => ({
  ok: false,
  error: "unavailable",
  message: "Secure storage is available only in the native Eliza app.",
});

export class ElizaSecureStoreWeb
  extends WebPlugin
  implements ElizaSecureStorePlugin
{
  async get(): Promise<ElizaSecureStoreResult> {
    return unavailable();
  }

  async set(): Promise<ElizaSecureStoreResult> {
    return unavailable();
  }

  async remove(): Promise<ElizaSecureStoreResult> {
    return unavailable();
  }

  async status(): Promise<ElizaSecureStoreStatus> {
    return {
      ok: false,
      available: false,
      backend: "unavailable",
      accessibility: "unavailable",
      synchronized: false,
      accessGroup: "app_only",
      error: "unavailable",
      message: "Secure storage is available only in the native Eliza app.",
    };
  }
}
