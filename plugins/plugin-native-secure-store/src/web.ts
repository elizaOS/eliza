import { WebPlugin } from "@capacitor/core";
import type {
  ElizaSecureStorePlugin,
  ElizaSecureStoreResult,
  ElizaSecureStoreStatus,
} from "./definitions";

const unavailable = (): ElizaSecureStoreResult => ({
  ok: false,
  error: "unavailable",
  message: "Apple Keychain is available only in the native Eliza app.",
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
      message: "Apple Keychain is available only in the native Eliza app.",
    };
  }
}
