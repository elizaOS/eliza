/**
 * Resilience tests for SocketRedis against a real local TCP server.
 *
 * On Cloudflare Workers a socket belongs to the request context that opened
 * it; a client instance that survives that request holds a dead/poisoned
 * socket. These tests pin the two recovery behaviors that keep a long-lived
 * client usable after a bad connection:
 *
 *  1. A failed operation must DROP the connection so the next call
 *     reconnects fresh (pre-fix, a non-timeout socket error left the dead
 *     socket cached and every later op on the instance failed forever).
 *  2. A caller queued behind a stalled operation must not hang unboundedly —
 *     the stalled op times out, the queue drains, and the next op completes
 *     on a fresh connection.
 *
 * The workerd-specific orphan (a predecessor whose `finally release()` never
 * runs because its request context died) cannot be reproduced under Node —
 * `finally` always runs here. The queue-wait bound added for that case is
 * exercised indirectly: these tests prove the raced wait resolves "released"
 * and behaves identically on the normal path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Socket as NetSocket, type Server } from "node:net";
import { SocketRedis } from "./socket-redis";

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("no port"));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("SocketRedis connection resilience", () => {
  test("drops a poisoned connection after a socket error and recovers on the next call", async () => {
    let connections = 0;
    const server = createServer((socket: NetSocket) => {
      connections += 1;
      if (connections === 1) {
        // First connection dies as soon as the client speaks — a socket
        // error, NOT a timeout (the path that previously never closed).
        socket.once("data", () => socket.destroy());
        return;
      }
      // Later connections behave: nil bulk reply to any command.
      socket.on("data", () => socket.write("$-1\r\n"));
    });
    const port = await listen(server);
    const redis = new SocketRedis(`redis://127.0.0.1:${port}`);

    await expect(redis.get("k")).rejects.toThrow();
    // Pre-fix: the dead socket stayed cached and this second call failed
    // forever. Post-fix it reconnects and completes.
    expect(await redis.get("k")).toBeNull();
    expect(connections).toBe(2);

    await redis.quit();
  });

  test("a caller queued behind a stalled operation completes on a fresh connection instead of hanging", async () => {
    let connections = 0;
    const server = createServer((socket: NetSocket) => {
      connections += 1;
      if (connections === 1) {
        // Accept, read, never reply — a stalled origin.
        socket.on("data", () => {});
        return;
      }
      socket.on("data", () => socket.write("$-1\r\n"));
    });
    const port = await listen(server);
    const redis = new SocketRedis(`redis://127.0.0.1:${port}`);

    const started = Date.now();
    const first = redis.get("a");
    const second = redis.get("b");

    await expect(first).rejects.toThrow(/timed out/);
    expect(await second).toBeNull();
    // Stall bound (1s) + second op — nowhere near an unbounded hang.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(connections).toBe(2);

    await redis.quit();
  });

  test("drops partial RESP parser state when reconnecting after a stalled reply", async () => {
    let connections = 0;
    const server = createServer((socket: NetSocket) => {
      connections += 1;
      if (connections === 1) {
        // Write half a bulk string, then stall. Without resetting the parser on
        // close, the next connection's reply is parsed as the tail of this
        // stale frame.
        socket.on("data", () => socket.write("$5\r\nhe"));
        return;
      }
      socket.on("data", () => socket.write("$-1\r\n"));
    });
    const port = await listen(server);
    const redis = new SocketRedis(`redis://127.0.0.1:${port}`);

    await expect(redis.get("partial")).rejects.toThrow(/timed out/);
    expect(await redis.get("fresh")).toBeNull();
    expect(connections).toBe(2);

    await redis.quit();
  });
});
