#!/usr/bin/env node
/**
 * Relays Chromium native messaging to the user's private agent socket. Only the
 * packaged extension origin is admitted; socket ownership and permissions are
 * checked before any browser frame is forwarded. Large messages are chunked by
 * the protocol owners, never truncated by this byte-preserving transport.
 */
import { lstat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const origin = "chrome-extension://pmldpcoefklbdbgmggcejkfoinmjfeio/";
const maxFrameBytes = 64 * 1024;

export class NativeFrameTransform extends Transform {
  pending = Buffer.alloc(0);

  _transform(chunk, _encoding, callback) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length === 0 || length > maxFrameBytes) {
        callback(
          new Error(
            "BROWSER_NATIVE_FRAME_TOO_LARGE: use ordered chunk frames below 64 KiB",
          ),
        );
        return;
      }
      if (this.pending.length < length + 4) break;
      this.push(this.pending.subarray(0, length + 4));
      this.pending = this.pending.subarray(length + 4);
    }
    callback();
  }

  _flush(callback) {
    callback(
      this.pending.length === 0
        ? undefined
        : new Error("BROWSER_NATIVE_FRAME_INCOMPLETE"),
    );
  }
}

export async function runNativeHost() {
  if (process.platform !== "linux" || process.argv[2] !== origin) {
    throw new Error("BROWSER_NATIVE_ORIGIN_DENIED");
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !path.isAbsolute(runtimeDir)) {
    throw new Error(
      "BROWSER_NATIVE_RUNTIME_UNAVAILABLE: XDG_RUNTIME_DIR is required",
    );
  }
  const socketPath =
    process.env.ELIZA_BROWSER_NATIVE_SOCKET ||
    path.join(runtimeDir, "eliza", "browser-native.sock");
  if (!path.isAbsolute(socketPath))
    throw new Error("BROWSER_NATIVE_SOCKET_INVALID");
  const parent = await lstat(path.dirname(socketPath));
  const socketStat = await lstat(socketPath);
  const uid = process.getuid();
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o077) !== 0 ||
    !socketStat.isSocket() ||
    socketStat.uid !== uid ||
    (socketStat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "BROWSER_NATIVE_SOCKET_DENIED: private user-owned directory and socket required",
    );
  }
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await Promise.all([
    pipeline(process.stdin, new NativeFrameTransform(), socket),
    pipeline(socket, new NativeFrameTransform(), process.stdout),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  runNativeHost().catch((error) => {
    // error-policy:J1 Protocol/peer failures end the host and disconnect the browser port.
    process.stderr.write(`Browser native host: ${error.message}\n`);
    process.exit(1);
  });
}
