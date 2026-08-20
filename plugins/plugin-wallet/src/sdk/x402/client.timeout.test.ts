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

function listen(server: http.Server): Promise<import("node:net").AddressInfo> {
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  ).then(() => server.address() as import("node:net").AddressInfo);
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const PAYMENT_OPTION = {
  scheme: "exact",
  network: "base:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "1",
  payTo: "0x0000000000000000000000000000000000000002",
  maxTimeoutSeconds: 60,
  extra: {},
} as const;

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: {
    url: "https://example.test/data",
    description: "test resource",
    mimeType: "application/json",
  },
  accepts: [PAYMENT_OPTION],
};

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

  it("keeps the first-request deadline active while its body stalls", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"ok":');
    });
    const addr = await listen(server);
    const client = new X402Client(createWallet(), { autoPay: false });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    try {
      const response = await client.fetch(`http://127.0.0.1:${addr.port}/data`);
      await expect(response.json()).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_X402_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await close(server);
    }
  });

  it("propagates a deadline while parsing a stalled 402 body", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.write('{"x402Version":');
    });
    const addr = await listen(server);
    const client = new X402Client(createWallet());
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(10));

    try {
      await expect(
        client.fetch(`http://127.0.0.1:${addr.port}/data`),
      ).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      timeoutSpy.mockRestore();
      await close(server);
    }
  });

  it("keeps a fresh deadline active through the paid retry body", async () => {
    let requestCount = 0;
    let retryPaymentHeader: string | undefined;
    const server = http.createServer((req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(402, {
          "payment-required": btoa(JSON.stringify(PAYMENT_REQUIRED)),
        });
        res.end();
        return;
      }
      retryPaymentHeader = req.headers["x-payment"];
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"paid":');
    });
    const addr = await listen(server);
    const client = new X402Client(createWallet(), {
      supportedAssets: { "base:8453": [PAYMENT_OPTION.asset] },
    });
    Object.defineProperty(client, "executePayment", {
      value: vi.fn(async () => ({
        txHash:
          "0x0000000000000000000000000000000000000000000000000000000000000001",
      })),
    });
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => originalTimeout(25));

    try {
      const response = await client.fetch(`http://127.0.0.1:${addr.port}/data`);
      expect(requestCount).toBe(2);
      expect(retryPaymentHeader).toBeTruthy();
      await expect(response.json()).rejects.toMatchObject({
        name: "TimeoutError",
      });
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_X402_FETCH_TIMEOUT_MS);
    } finally {
      timeoutSpy.mockRestore();
      await close(server);
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
