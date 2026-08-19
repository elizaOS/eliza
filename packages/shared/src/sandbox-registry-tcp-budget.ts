/**
 * Byte budget for SandboxRegistry's native Redis TCP path. The socket
 * concatenates every chunk until a full RESP reply arrives; a hostile peer
 * can declare a multi-gigabyte bulk string (`$999999999\r\n`) and force the
 * agent to retain the stream for the full 10s timeout. Honest AUTH/SET/GET
 * replies are a few hundred bytes.
 */

/** Combined TCP reply ceiling for one register/refresh/unregister round-trip. */
export const MAX_REGISTRY_TCP_BYTES = 1_048_576;

export function appendRegistryTcpBytes(
  buffer: Buffer,
  chunk: Buffer,
  maxBytes = MAX_REGISTRY_TCP_BYTES,
): { ok: true; buffer: Buffer } | { ok: false } {
  if (buffer.length + chunk.length > maxBytes) {
    return { ok: false };
  }
  return { ok: true, buffer: Buffer.concat([buffer, chunk]) };
}

/**
 * True when a RESP bulk-string length can be materialized inside the TCP
 * budget. `-1` is Redis null bulk and is allowed. Non-finite values are not.
 */
export function isRegistryTcpBulkLengthAllowed(length: number): boolean {
  if (length === -1) return true;
  return Number.isFinite(length) && length >= 0 && length <= MAX_REGISTRY_TCP_BYTES;
}
