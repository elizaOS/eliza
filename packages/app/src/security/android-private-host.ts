/** Existing bounded same-UID Android service framing; no listener, credentials or retries. */
import { randomUUID } from "node:crypto";
import { connect } from "node:net";

const MAX_FRAME = 4 * 1024 * 1024;
export type AndroidPrivateHostRequest =
  | { operation: "nativeOwnerContext" }
  | {
      operation: "get" | "set" | "delete";
      vaultId: string;
      secretKind: "runtime.agent_profiles";
      value?: string;
    };
export interface AndroidPrivateHostReply {
  ok: boolean;
  [key: string]: unknown;
}
export function requestAndroidPrivateHost(
  request: AndroidPrivateHostRequest,
  socketPath: string,
  timeoutMs = 15_000,
): Promise<AndroidPrivateHostReply> {
  const id = randomUUID();
  const encoded = Buffer.from(JSON.stringify({ ...request, id }));
  if (encoded.length > MAX_FRAME)
    return Promise.resolve({ ok: false, reason: "request_too_large" });
  return new Promise<AndroidPrivateHostReply>((resolve) => {
    let settled = false;
    const socket = connect(socketPath);
    let pending = Buffer.alloc(0);
    const finish = (reply: AndroidPrivateHostReply) => {
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
          new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(4)),
        );
        if (
          !reply ||
          typeof reply !== "object" ||
          !("id" in reply) ||
          reply.id !== id ||
          !("ok" in reply) ||
          typeof reply.ok !== "boolean"
        )
          throw new Error("Invalid secure-store receipt");
        finish(reply as AndroidPrivateHostReply);
      } catch {
        // error-policy:J1 Reject malformed receipts without logging secret-bearing frames.
        finish({ ok: false, reason: "error" });
      }
    });
  });
}
