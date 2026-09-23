/**
 * Owns an authenticated host's Linux abstract Unix HTTP listener and shutdown.
 * Abstract sockets have no filesystem entry to remove or accidentally replace;
 * the kernel releases only this listener's endpoint. They have no filesystem
 * permission gate: persistent session admission and deployment network-namespace
 * isolation remain mandatory independent controls.
 */
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { ElizaError } from "@elizaos/core";

export async function listenConfidentialUnix(input: {
  server: Server;
  socketName: string;
  /** Synchronously withdraw all HTTP and persistent-transport admission. */
  revokeAdmission: () => void;
  /** Maximum time for already admitted connections to drain before destruction. */
  drainTimeoutMs: number;
}): Promise<{ stop: () => Promise<void> }> {
  if (
    process.platform !== "linux" ||
    !/^eliza-[a-zA-Z0-9._-]+$/.test(input.socketName) ||
    // Linux sun_path reserves one byte for the abstract-namespace prefix.
    Buffer.byteLength(input.socketName) > 106 ||
    !Number.isSafeInteger(input.drainTimeoutMs) ||
    input.drainTimeoutMs < 0 ||
    input.drainTimeoutMs > 2_147_483_647 ||
    input.server.listening
  ) {
    throw new ElizaError(
      "Use an unbound server and an explicit Linux abstract socket name",
      {
        code: "CONFIDENTIAL_LISTENER_CONFIGURATION_INVALID",
      },
    );
  }
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  let listening = false;
  try {
    // Binding an occupied abstract name fails without changing its owner.
    const path = `\0${input.socketName}`;
    input.server.on("connection", track);
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        input.server.removeListener("listening", ready);
        reject(error);
      };
      const ready = () => {
        input.server.removeListener("error", failed);
        resolve();
      };
      input.server.once("error", failed);
      input.server.once("listening", ready);
      input.server.listen(path);
    });
    listening = true;
  } catch (cause) {
    // error-policy:J2 Preserve startup failure without exposing configuration.
    input.server.removeListener("connection", track);
    throw new ElizaError("Confidential Unix listener could not bind", {
      code: "CONFIDENTIAL_LISTENER_BIND_FAILED",
      cause,
    });
  }

  let stopping: Promise<void> | undefined;
  function stop(): Promise<void> {
    if (stopping) return stopping;
    // Publish the same promise before invoking host code, including reentrant stop.
    const completion = Promise.withResolvers<void>();
    stopping = completion.promise;
    const shutdown = async () => {
      let revokeFailure: Error | undefined;
      try {
        input.revokeAdmission();
      } catch (cause) {
        // error-policy:J2 Close the transport even if host admission teardown failed.
        revokeFailure = new ElizaError("Host admission revocation failed", {
          code: "CONFIDENTIAL_LISTENER_REVOCATION_FAILED",
          cause,
        });
      }
      const timeout = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, input.drainTimeoutMs);
      try {
        if (listening) {
          await new Promise<void>((resolve, reject) => {
            input.server.close((error) => (error ? reject(error) : resolve()));
          });
          listening = false;
        }
      } finally {
        clearTimeout(timeout);
        for (const socket of sockets) socket.destroy();
        input.server.removeListener("connection", track);
      }
      if (revokeFailure) throw revokeFailure;
    };
    void shutdown().then(completion.resolve, completion.reject);
    return stopping;
  }
  return Object.freeze({ stop });
}
