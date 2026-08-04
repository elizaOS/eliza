/** Exercises real TCP binding, fallback, and teardown through the listener boundary. */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HttpListener, listenHttpServer } from "./http-listener.ts";

describe("HTTP listener", () => {
  const listeners: HttpListener[] = [];
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
  });

  it("binds and closes an ephemeral listener", async () => {
    const closed = vi.fn(async () => undefined);
    const listener = await listenHttpServer({
      server: createServer(),
      host: "127.0.0.1",
      port: 0,
      strictPortBinding: false,
      closeResources: closed,
    });
    listeners.push(listener);
    expect(listener.port).toBeGreaterThan(0);
    await listener.close();
    listeners.pop();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("falls back to an ephemeral port when the requested port is occupied", async () => {
    const occupied = await listenHttpServer({
      server: createServer(),
      host: "127.0.0.1",
      port: 0,
      strictPortBinding: false,
      closeResources: async () => undefined,
    });
    listeners.push(occupied);
    const onPortInUse = vi.fn();
    const fallback = await listenHttpServer({
      server: createServer(),
      host: "127.0.0.1",
      port: occupied.port,
      strictPortBinding: false,
      closeResources: async () => undefined,
      onPortInUse,
    });
    listeners.push(fallback);
    expect(fallback.port).not.toBe(occupied.port);
    expect(onPortInUse).toHaveBeenCalledWith(occupied.port, true);
  });
});
