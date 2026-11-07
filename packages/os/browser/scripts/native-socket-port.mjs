/**
 * Test peer transport: a `chrome.runtime.connectNative` port over the native
 * browser socket. Give it to `NativeConnection` to register a profile with a
 * `NativeSocketBrowserTarget` in-process (hello, hello-ack, ping, chunks) as the
 * extension and native host do, with the same 4-byte little-endian frames.
 */
import { createConnection } from "node:net";
import { NativeFrameTransform } from "./native-host.mjs";

export function connectNativeSocket(socketPath) {
  const socket = createConnection(socketPath);
  const frames = socket.pipe(new NativeFrameTransform());
  const messageListeners = [];
  const disconnectListeners = [];
  frames.on("data", (frame) => {
    const message = JSON.parse(frame.subarray(4).toString("utf8"));
    for (const listener of messageListeners) listener(message);
  });
  frames.on("error", (error) => socket.destroy(error));
  socket.on("error", () => {});
  socket.once("close", () => {
    for (const listener of disconnectListeners) listener();
  });
  return {
    postMessage(message) {
      if (socket.destroyed) throw new Error("Native socket is closed.");
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    },
    disconnect: () => socket.destroy(),
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.push(listener),
    },
  };
}
