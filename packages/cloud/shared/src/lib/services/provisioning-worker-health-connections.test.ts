/** Verifies heartbeat Redis connection ownership using a real local TCP transport. */
import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { SocketRedis } from "../cache/socket-redis";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import {
  checkProvisioningWorkerCapability,
  checkProvisioningWorkerHealth,
  publishProvisioningWorkerHeartbeat,
} from "./provisioning-worker-health";

async function withTransport(
  reply: string | null,
  exercise: (url: string, sockets: Set<Socket>) => Promise<void>,
) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => {
      if (reply !== null) socket.write(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  try {
    await exercise(`redis://127.0.0.1:${address.port}`, sockets);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function waitForClosed(sockets: Set<Socket>) {
  for (let attempt = 0; attempt < 100 && sockets.size; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(sockets.size).toBe(0);
}

function withRedis<T>(url: string, run: () => Promise<T>) {
  return runWithCloudBindingsAsync(
    { NODE_ENV: "production", MOCK_REDIS: "0", DIRECT_REDIS_BACKEND: "redis", REDIS_URL: url },
    run,
  );
}

describe("provisioning heartbeat transport ownership", () => {
  test("repeated and concurrent heartbeat cycles leave no open TCP connections", async () => {
    await withTransport("+OK\r\n", async (url, sockets) => {
      await withRedis(url, async () => {
        for (let cycle = 0; cycle < 20; cycle++) {
          expect(await publishProvisioningWorkerHeartbeat()).toBe(true);
          await waitForClosed(sockets);
        }
        await Promise.all(Array.from({ length: 12 }, () => publishProvisioningWorkerHeartbeat()));
        await waitForClosed(sockets);
      });
    });
  });

  test("health and capability reads release their owned connections", async () => {
    await withTransport("$-1\r\n", async (url, sockets) => {
      await withRedis(url, async () => {
        expect((await checkProvisioningWorkerHealth()).ok).toBe(false);
        await waitForClosed(sockets);
        expect((await checkProvisioningWorkerCapability("required")).ok).toBe(false);
        await waitForClosed(sockets);
      });
    });
  });

  test("Redis command failures release the owned connection", async () => {
    await withTransport("-ERR injected command failure\r\n", async (url, sockets) => {
      await withRedis(url, async () => {
        await expect(publishProvisioningWorkerHeartbeat()).rejects.toThrow(
          "injected command failure",
        );
        await waitForClosed(sockets);
      });
    });
  });

  test("a stalled heartbeat releases its connection at the operation deadline", async () => {
    await withTransport(null, async (url, sockets) => {
      await withRedis(url, async () => {
        await expect(publishProvisioningWorkerHeartbeat()).rejects.toThrow();
        await waitForClosed(sockets);
      });
    });
  }, 10_000);

  test("borrowed clients stay usable and are closed by their caller", async () => {
    await withTransport("+OK\r\n", async (url, sockets) => {
      const client = new SocketRedis(url);
      try {
        expect(await publishProvisioningWorkerHeartbeat(client)).toBe(true);
        expect(await publishProvisioningWorkerHeartbeat(client)).toBe(true);
        expect(sockets.size).toBe(1);
      } finally {
        await client.close();
      }
      await waitForClosed(sockets);
    });
  });
});
