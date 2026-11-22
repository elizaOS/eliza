// spec/os/agentService/inference.md, "Only the app's own process is served, for an operation the host offers, within its frame limit and its model storage"
import { Buffer } from "node:buffer";
import { connect } from "node:net";

/** A request the host could not be reached for: it is not listening, or the connection broke before an answer. */
export class HostUnreachable extends Error {}

/** The socket path of an abstract socket name, or the path itself when it names a file. @throws {never} */
export function socketPath(name: string): string {
  return name.startsWith("/") ? name : `\0${name}`;
}

/**
 * Sends one request frame and resolves with the host's one answer frame, parsed; aborting closes the
 * connection, which the host takes as a cancel.
 * @throws {HostUnreachable}
 */
export function exchange(socket: string, request: object, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const body = Buffer.from(JSON.stringify(request), "utf8");
    const head = Buffer.alloc(4);
    head.writeInt32BE(body.length);
    const connection = connect({ path: socketPath(socket) });
    const parts: Buffer[] = [];
    let received = 0;
    let settled = false;
    const done = (fail: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      connection.destroy();
      if (fail === undefined) resolve(value);
      else reject(fail);
    };
    const abort = () => done(signal?.reason ?? new HostUnreachable("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    connection.on("connect", () => connection.write(Buffer.concat([head, body])));
    connection.on("data", (chunk: Buffer) => {
      parts.push(chunk);
      received += chunk.length;
      const all = Buffer.concat(parts, received);
      if (all.length < 4) return;
      const length = all.readInt32BE(0);
      if (length <= 0) return done(new HostUnreachable("the host answered an empty frame"));
      if (all.length < 4 + length) return;
      try {
        done(undefined, JSON.parse(all.subarray(4, 4 + length).toString("utf8")));
      } catch {
        done(new HostUnreachable("the host answered a frame that is not JSON"));
      }
    });
    connection.on("error", (error) => done(new HostUnreachable(error.message)));
    connection.on("close", () => done(new HostUnreachable("the host closed the connection without an answer")));
  });
}

/** Little-endian float PCM as base64, the host's audio encoding. @throws {never} */
export function floatsToBase64(samples: Float32Array): string {
  const bytes = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => bytes.writeFloatLE(sample, index * 4));
  return bytes.toString("base64");
}

/** The samples of little-endian float PCM in base64, or undefined for anything else. @throws {never} */
export function floatsFromBase64(text: string): Float32Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) return undefined;
  const samples = new Float32Array(bytes.length / 4);
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}
