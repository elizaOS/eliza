import net from "node:net";

const BIONIC_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** A buffered request on the existing Android host socket; each call owns its connection. */
export function requestBionicHost(
  socketName: string,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify(request), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: `\0${socketName}` });
    let settled = false;
    let chunks = Buffer.alloc(0);
    let expected = -1;
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("[mobile-device-bridge] bionic host timed out")),
      timeoutMs,
    );
    sock.on("connect", () => sock.write(frame));
    sock.on("data", (d: Buffer) => {
      chunks = Buffer.concat([chunks, d]);
      if (expected < 0 && chunks.length >= 4) {
        expected = chunks.readUInt32BE(0);
        if (expected < 0 || expected > BIONIC_MAX_FRAME_BYTES) {
          finish(
            new Error(`[mobile-device-bridge] bad bionic frame ${expected}`),
          );
          return;
        }
      }
      if (expected >= 0 && chunks.length >= 4 + expected) {
        try {
          finish(
            null,
            JSON.parse(chunks.subarray(4, 4 + expected).toString("utf8")),
          );
        } catch (e) {
          finish(
            new Error(
              `[mobile-device-bridge] bad bionic JSON: ${(e as Error).message}`,
            ),
          );
        }
      }
    });
    sock.on("error", (e: Error) =>
      finish(
        new Error(`[mobile-device-bridge] bionic socket error: ${e.message}`),
      ),
    );
    sock.on("close", () => {
      if (!settled)
        finish(new Error("[mobile-device-bridge] bionic host closed early"));
    });
  });
}
