/**
 * Binds admitted WebSocket connections to the auth session that admitted
 * them, so revoking a session also ends its open sockets instead of only
 * denying the next handshake.
 *
 * The agent server owns the `ws` instances; the host only sees the upgrade
 * request. Closing therefore happens at the transport: a server close frame
 * (1008 policy violation, unmasked per RFC 6455 §5.1) is written on the raw
 * socket and the socket is ended, then destroyed if the peer does not finish
 * the close promptly. `ws` writes each frame synchronously under cork, so this
 * frame cannot interleave with a partially written application frame.
 */
import type { Duplex } from "node:stream";
import { logger } from "@elizaos/core";

/** WebSocket close code sent when the bound session is revoked. */
export const SESSION_REVOKED_CLOSE_CODE = 1008;
const SESSION_REVOKED_CLOSE_REASON = "Session revoked";
const FORCE_DESTROY_AFTER_MS = 1_000;

interface BoundSocket {
  sessionId: string;
  identityId: string;
}

const socketsBySession = new Map<string, Set<Duplex>>();
const bindings = new Map<Duplex, BoundSocket>();

function unbind(socket: Duplex): void {
  const binding = bindings.get(socket);
  if (!binding) return;
  bindings.delete(socket);
  const sockets = socketsBySession.get(binding.sessionId);
  sockets?.delete(socket);
  if (sockets && sockets.size === 0) socketsBySession.delete(binding.sessionId);
}

function encodeCloseFrame(code: number, reason: string): Buffer {
  const reasonBytes = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  // FIN + opcode 0x8 (close); control frame payloads are < 126 bytes.
  return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
}

/** Record that `socket` was admitted by the given session. */
export function bindSessionSocket(session: BoundSocket, socket: Duplex): void {
  if (socket.destroyed || bindings.has(socket)) return;
  bindings.set(socket, session);
  let sockets = socketsBySession.get(session.sessionId);
  if (!sockets) {
    sockets = new Set();
    socketsBySession.set(session.sessionId, sockets);
  }
  sockets.add(socket);
  socket.once("close", () => unbind(socket));
}

/** Drop a binding without closing the socket (a handshake being refused). */
export function unbindSessionSocket(socket: Duplex): void {
  unbind(socket);
}

function closeSocket(socket: Duplex): void {
  unbind(socket);
  if (socket.destroyed) return;
  try {
    socket.write(
      encodeCloseFrame(
        SESSION_REVOKED_CLOSE_CODE,
        SESSION_REVOKED_CLOSE_REASON,
      ),
    );
    socket.end();
  } catch (error) {
    // error-policy:J2 a write on a dying socket still ends in destroy below;
    // revocation must never leave the connection open.
    logger.warn(
      `[eliza][auth] revoked-session socket close write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    socket.destroy();
    return;
  }
  const timer = setTimeout(() => socket.destroy(), FORCE_DESTROY_AFTER_MS);
  timer.unref?.();
  socket.once("close", () => clearTimeout(timer));
}

/** Close every open socket admitted by `sessionId`. Returns the count closed. */
export function closeSessionSockets(sessionId: string): number {
  const sockets = [...(socketsBySession.get(sessionId) ?? [])];
  for (const socket of sockets) closeSocket(socket);
  return sockets.length;
}

/**
 * Close every open socket admitted by any session of `identityId`, except the
 * sockets of `exceptSessionId` (mirrors revoke-all-but-current).
 */
export function closeIdentitySockets(
  identityId: string,
  exceptSessionId?: string,
): number {
  const targets = [...bindings].filter(
    ([, binding]) =>
      binding.identityId === identityId &&
      binding.sessionId !== exceptSessionId,
  );
  for (const [socket] of targets) closeSocket(socket);
  return targets.length;
}
