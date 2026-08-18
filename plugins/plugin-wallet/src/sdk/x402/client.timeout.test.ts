/**
 * X402Client fetch deadline — proves the production client aborts on timeout
 * via a real hanging HTTP server, not a stubbed helper.
 */
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_X402_FETCH_TIMEOUT_MS, X402Client } from "./client";

function createWallet() {
  return {
    address: "0x0000000000000000000000000000000000000001",
  } as unknown as import("../wallet-core").AgentWallet;
}

describe("X402Client fetch timeout (real server)", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_X402_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled X402 fetch via the client boundary", async () => {
    const server = http.createServer((_req, _res) => {
      // hang
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/data`;

    const client = new X402Client(createWallet(), { autoPay: false });

    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    try {
      await expect(client.fetch(url)).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_X402_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/data`;

    const client = new X402Client(createWallet(), { autoPay: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const res = await client.fetch(url);
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
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

  it("merges a caller signal via AbortSignal.any", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/data`;

    const client = new X402Client(createWallet(), { autoPay: false });
    const controller = new AbortController();
    const anySpy = vi.spyOn(AbortSignal, "any");

    try {
      const res = await client.fetch(url, { signal: controller.signal });
      expect(res.status).toBe(200);
      expect(anySpy).toHaveBeenCalled();
      const merged = anySpy.mock.calls[0]?.[0] as AbortSignal[] | undefined;
      expect(merged).toContain(controller.signal);
    } finally {
      anySpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("honors caller abort without waiting for timeout", async () => {
    const server = http.createServer((_req, _res) => {
      // hang
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/data`;

    const client = new X402Client(createWallet(), { autoPay: false });
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(
        client.fetch(url, { signal: controller.signal }),
      ).rejects.toMatchObject({
        name: "AbortError",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
