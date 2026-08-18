/**
 * Bounded BirdeyeService fetch — proves the production service aborts on
 * timeout via a real hanging HTTP server, not a stubbed helper.
 */
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS } from "./constants";
import { BirdeyeService } from "./service";

function createRuntime(port: number) {
  return {
    getSetting: (key: string) => {
      if (key === "BIRDEYE_API_KEY") return null;
      if (key === "ELIZAOS_CLOUD_API_KEY") return "test-cloud-key";
      if (key === "ELIZAOS_CLOUD_ENABLED") return true;
      if (key === "ELIZAOS_CLOUD_BASE_URL") return `http://127.0.0.1:${port}`;
      return undefined;
    },
    getCache: async () => undefined,
    setCache: async () => {},
    logger: {
      debug: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
    },
  } as unknown as import("@elizaos/core").IAgentRuntime;
}

describe("BirdeyeService fetch timeout (real server)", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled Birdeye fetch via the service boundary", async () => {
    const server = http.createServer((_req, _res) => {
      // hang intentionally
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const port = addr.port;

    const runtime = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    try {
      await expect(
        service.fetchTokenOverview({
          address: "So11111111111111111111111111111111111111112",
        } as never),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { price: 1.23 } }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const port = addr.port;

    const runtime = createRuntime(port);
    const service = new BirdeyeService(runtime);

    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const result = await service.fetchTokenOverview({
        address: "So11111111111111111111111111111111111111112",
      } as never);
      expect((result as { data: { price: number } }).data.price).toBe(1.23);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/apis/birdeye/defi/token_overview`),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)
        ?.signal as AbortSignal | undefined;
      expect(signal?.aborted).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the deadline active while the Birdeye body stalls", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const service = new BirdeyeService(createRuntime(addr.port));
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    try {
      await expect(
        service.fetchTokenOverview({
          address: "So11111111111111111111111111111111111111112",
        } as never),
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_BIRDEYE_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("surfaces a provider error from a completed upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("Service Unavailable");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const port = addr.port;

    const runtime = createRuntime(port);
    const service = new BirdeyeService(runtime);

    try {
      await expect(
        service.fetchTokenOverview({ address: "So111" } as never),
      ).rejects.toThrow("503");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
