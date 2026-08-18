/**
 * Exercises `ProxyServer` lifecycle serialization against real Node HTTP
 * listeners so concurrent start and stop requests cannot leak a bound server.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyServer } from "../src/proxy/server.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length) {
    await cleanup.pop()?.();
  }
});

function underlyingServer(proxy: ProxyServer): Server | null {
  return (proxy as unknown as { server: Server | null }).server;
}

async function closeLeakedServer(server: Server | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

async function reserveAvailablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an assigned TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return address.port;
}

describe("ProxyServer lifecycle", () => {
  it("coalesces concurrent starts onto one listener", async () => {
    const port = await reserveAvailablePort();
    const proxy = new ProxyServer({
      port,
      bindHost: "127.0.0.1",
      envToken: "test-oauth-token-not-real",
    });

    const firstStart = proxy.start();
    const firstServer = underlyingServer(proxy);
    const secondStart = proxy.start();
    cleanup.push(async () => {
      await proxy.stop();
      if (firstServer !== underlyingServer(proxy)) await closeLeakedServer(firstServer);
    });

    await Promise.all([firstStart, secondStart]);

    expect(proxy.isListening()).toBe(true);
    expect(proxy.getUrl()).toBe(`http://127.0.0.1:${port}`);
  });

  it("honors a stop requested while startup is pending", async () => {
    const proxy = new ProxyServer({
      port: 0,
      bindHost: "127.0.0.1",
      envToken: "test-oauth-token-not-real",
    });
    cleanup.push(() => proxy.stop());

    const starting = proxy.start();
    const stopping = proxy.stop();
    await Promise.all([starting, stopping]);

    expect(proxy.isListening()).toBe(false);
    expect(underlyingServer(proxy)).toBeNull();
  });

  it("clears failed startup state and can retry once the port is available", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => closeLeakedServer(blocker));
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected an assigned TCP port");
    }

    const proxy = new ProxyServer({
      port: address.port,
      bindHost: "127.0.0.1",
      envToken: "test-oauth-token-not-real",
    });
    cleanup.push(() => proxy.stop());

    await expect(proxy.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(proxy.isListening()).toBe(false);
    expect(underlyingServer(proxy)).toBeNull();

    await closeLeakedServer(blocker);
    await proxy.start();
    expect(proxy.isListening()).toBe(true);
  });

  it("allows repeated concurrent stops and a later restart", async () => {
    const proxy = new ProxyServer({
      port: 0,
      bindHost: "127.0.0.1",
      envToken: "test-oauth-token-not-real",
    });
    cleanup.push(() => proxy.stop());
    await proxy.start();

    await Promise.all([proxy.stop(), proxy.stop(), proxy.stop()]);
    expect(proxy.isListening()).toBe(false);

    await proxy.start();
    expect(proxy.isListening()).toBe(true);
  });
});
