/** Bun host adapter for the app-UID-only Android Keystore broker. */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import type {
  PlatformSecureStore,
  SecureStoreDeleteResult,
  SecureStoreGetResult,
  SecureStoreSecretKind,
  SecureStoreSetResult,
} from "./platform-secure-store";

const MAX_FRAME = 4 * 1024 * 1024;
type Reply =
  | SecureStoreGetResult
  | SecureStoreSetResult
  | SecureStoreDeleteResult;

export function createAndroidPlatformSecureStore(
  socketPath = "\0ai.elizaos.app.secure-store",
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
    const id = randomUUID();
    const encoded = Buffer.from(
      JSON.stringify({ id, operation, vaultId, secretKind, value }),
    );
    if (encoded.length > MAX_FRAME)
      return {
        ok: false,
        reason: "error",
        message: "Secure-store request exceeds the native frame limit.",
      };
    return new Promise((resolve) => {
      let settled = false;
      const socket = connect(socketPath);
      let pending = Buffer.alloc(0);
      const finish = (reply: Reply) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(reply);
      };
      socket.setTimeout(timeoutMs, () =>
        finish({ ok: false, reason: "unavailable" }),
      );
      socket.once("error", () => finish({ ok: false, reason: "unavailable" }));
      socket.once("close", () => finish({ ok: false, reason: "unavailable" }));
      socket.once("connect", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(encoded.length);
        socket.write(Buffer.concat([header, encoded]));
      });
      socket.on("data", (chunk) => {
        pending = Buffer.concat([
          pending,
          typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        ]);
        if (pending.length < 4) return;
        const length = pending.readUInt32LE();
        if (!length || length > MAX_FRAME || pending.length > length + 4) {
          finish({ ok: false, reason: "error" });
          return;
        }
        if (pending.length !== length + 4) return;
        try {
          const reply: unknown = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              pending.subarray(4),
            ),
          );
          if (
            !reply ||
            typeof reply !== "object" ||
            !("id" in reply) ||
            reply.id !== id ||
            !("ok" in reply)
          )
            throw new Error("Invalid secure-store receipt");
          if (
            reply.ok === false &&
            "reason" in reply &&
            ["not_found", "denied", "unavailable", "error"].includes(
              String(reply.reason),
            )
          ) {
            finish({
              ok: false,
              reason: reply.reason as
                | "not_found"
                | "denied"
                | "unavailable"
                | "error",
            });
          } else if (
            reply.ok === true &&
            operation === "get" &&
            "value" in reply &&
            typeof reply.value === "string"
          ) {
            finish({ ok: true, value: reply.value });
          } else if (
            reply.ok === true &&
            operation === "delete" &&
            "deleted" in reply &&
            typeof reply.deleted === "boolean"
          ) {
            finish({ ok: true, deleted: reply.deleted });
          } else if (reply.ok === true && operation === "set") {
            finish({ ok: true });
          } else throw new Error("Invalid secure-store operation receipt");
        } catch {
          // error-policy:J1 Reject malformed receipts without logging secret-bearing frames.
          finish({ ok: false, reason: "error" });
        }
      });
    });
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
