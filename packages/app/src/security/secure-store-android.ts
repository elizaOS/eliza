/** Bun host adapter for the app-UID-only Android Keystore broker. */

import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "@elizaos/plugin-browser/remote-control/secure-store-contract";
import { requestAndroidPrivateHost } from "./android-private-host.js";

type Reply =
  | SecureStoreGetResult
  | SecureStoreSetResult
  | SecureStoreDeleteResult;

export function createAndroidPlatformSecureStore(
  // Embedding Android hosts supply the abstract socket name without its NUL prefix.
  socketPath = `\0${process.env.ELIZA_ANDROID_SECURE_STORE_SOCKET || "ai.elizaos.app.secure-store"}`,
  timeoutMs = 15_000,
): PlatformSecureStore {
  async function request(
    operation: "get" | "set" | "delete",
    vaultId: string,
    secretKind: SecureStoreSecretKind,
    value?: string,
  ): Promise<Reply> {
    if (
      secretKind !== "runtime.agent_profiles" ||
      !vaultId ||
      vaultId.length > 256
    )
      return { ok: false, reason: "denied" };
    const reply = await requestAndroidPrivateHost(
      { operation, vaultId, secretKind, value },
      socketPath,
      timeoutMs,
    );
    if (reply.ok === false && reply.reason === "request_too_large")
      return {
        ok: false,
        reason: "error",
        message: "Secure-store request exceeds the native frame limit.",
      };
    if (
      reply.ok === false &&
      "reason" in reply &&
      ["not_found", "denied", "unavailable", "error"].includes(
        String(reply.reason),
      )
    ) {
      return {
        ok: false,
        reason: reply.reason as
          | "not_found"
          | "denied"
          | "unavailable"
          | "error",
      };
    } else if (
      reply.ok === true &&
      operation === "get" &&
      "value" in reply &&
      typeof reply.value === "string"
    ) {
      return { ok: true, value: reply.value };
    } else if (
      reply.ok === true &&
      operation === "delete" &&
      "deleted" in reply &&
      typeof reply.deleted === "boolean"
    ) {
      return { ok: true, deleted: reply.deleted };
    } else if (reply.ok === true && operation === "set") {
      return { ok: true };
    } else return { ok: false, reason: "error" };
  }
  return {
    backend: "android_keystore",
    get: (vaultId, kind) =>
      request("get", vaultId, kind) as Promise<SecureStoreGetResult>,
    set: (vaultId, kind, value) =>
      request("set", vaultId, kind, value) as Promise<SecureStoreSetResult>,
    delete: (vaultId, kind) =>
      request("delete", vaultId, kind) as Promise<SecureStoreDeleteResult>,
    async isAvailable() {
      const result = await request(
        "get",
        "availability-probe",
        "runtime.agent_profiles",
      );
      return result.ok || result.reason === "not_found";
    },
  };
}
