import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const instances: Array<{
    wallet: unknown;
    config: unknown;
    fetch: ReturnType<typeof vi.fn>;
    parse402Response: ReturnType<typeof vi.fn>;
    selectPaymentOption: ReturnType<typeof vi.fn>;
  }> = [];

  class FakeX402Client {
    wallet: unknown;
    config: unknown;
    fetch = vi.fn(async () => new Response(null, { status: 200 }));
    parse402Response = vi.fn(async () => null);
    selectPaymentOption = vi.fn(() => null);

    constructor(wallet: unknown, config?: unknown) {
      this.wallet = wallet;
      this.config = config;
      instances.push(this);
    }
  }

  return { FakeX402Client, instances };
});

vi.mock("./client.js", () => ({
  X402Client: mocks.FakeX402Client,
}));

import { createX402Client, createX402Fetch, wrapWithX402 } from "./middleware";

describe("createX402Client", () => {
  it("constructs an X402Client with the wallet and config", () => {
    const wallet = { address: "0xabc" };
    const config = { globalDailyLimit: 10_000_000n };
    const client = createX402Client(wallet as never, config as never);
    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0].wallet).toBe(wallet);
    expect(mocks.instances[0].config).toBe(config);
    expect(client).toBeInstanceOf(mocks.FakeX402Client);
  });
});

describe("createX402Fetch", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
  });

  it("returns a fetch-compatible function that delegates to the client", async () => {
    const x402Fetch = createX402Fetch({ address: "0xabc" } as never);
    const expected = new Response("ok", { status: 200 });
    mocks.instances[0].fetch.mockResolvedValueOnce(expected);
    const result = await x402Fetch("https://api.example.com/data");
    expect(result).toBe(expected);
    expect(mocks.instances[0].fetch).toHaveBeenCalledWith(
      "https://api.example.com/data",
      undefined,
    );
  });

  it("stringifies URL objects before delegating", async () => {
    const x402Fetch = createX402Fetch({ address: "0xabc" } as never);
    await x402Fetch(new URL("https://api.example.com/v2"));
    expect(mocks.instances[0].fetch).toHaveBeenCalledWith(
      "https://api.example.com/v2",
      undefined,
    );
  });

  it("extracts .url from Request inputs", async () => {
    const x402Fetch = createX402Fetch({ address: "0xabc" } as never);
    await x402Fetch(
      new Request("https://api.example.com/upload", { method: "POST" }),
    );
    expect(mocks.instances[0].fetch).toHaveBeenCalledWith(
      "https://api.example.com/upload",
      undefined,
    );
  });

  it("forwards init options to the client fetch", async () => {
    const x402Fetch = createX402Fetch({ address: "0xabc" } as never);
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };
    await x402Fetch("https://api.example.com/data", init);
    expect(mocks.instances[0].fetch).toHaveBeenCalledWith(
      "https://api.example.com/data",
      init,
    );
  });
});

describe("wrapWithX402", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
  });

  const okResponse = () => new Response("ok", { status: 200 });

  it("passes through non-402 responses untouched", async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const wrapped = wrapWithX402(
      fetchFn as never,
      { address: "0xabc" } as never,
    );
    const response = await wrapped("https://api.example.com/data");
    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.com/data",
      undefined,
    );
    const client = mocks.instances[0];
    expect(client.parse402Response).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("passes through when a 402 response carries no parseable payment requirements", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 402 }));
    const wrapped = wrapWithX402(
      fetchFn as never,
      { address: "0xabc" } as never,
    );
    const client = mocks.instances[0];
    client.parse402Response.mockResolvedValueOnce(null);
    const response = await wrapped("https://api.example.com/data");
    expect(response.status).toBe(402);
    expect(client.selectPaymentOption).not.toHaveBeenCalled();
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("passes through when no payment option is selected", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 402 }));
    const wrapped = wrapWithX402(
      fetchFn as never,
      { address: "0xabc" } as never,
    );
    const client = mocks.instances[0];
    client.parse402Response.mockResolvedValueOnce({ accepts: ["USDC"] });
    client.selectPaymentOption.mockReturnValueOnce(null);
    const response = await wrapped("https://api.example.com/data");
    expect(response.status).toBe(402);
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("retries through the client when a payment option is selected", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 402 }));
    const wrapped = wrapWithX402(
      fetchFn as never,
      { address: "0xabc" } as never,
    );
    const client = mocks.instances[0];
    client.parse402Response.mockResolvedValueOnce({ accepts: ["USDC"] });
    client.selectPaymentOption.mockReturnValueOnce("USDC");
    const retried = new Response("paid", { status: 200 });
    client.fetch.mockResolvedValueOnce(retried);
    const response = await wrapped("https://api.example.com/data", {
      method: "GET",
    });
    expect(response).toBe(retried);
    expect(client.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
      method: "GET",
    });
  });

  it("extracts .url from Request inputs before retrying", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 402 }));
    const wrapped = wrapWithX402(
      fetchFn as never,
      { address: "0xabc" } as never,
    );
    const client = mocks.instances[0];
    client.parse402Response.mockResolvedValueOnce({ accepts: ["USDC"] });
    client.selectPaymentOption.mockReturnValueOnce("USDC");
    client.fetch.mockResolvedValueOnce(new Response("paid", { status: 200 }));
    await wrapped(new Request("https://api.example.com/pay"));
    expect(client.fetch).toHaveBeenCalledWith(
      "https://api.example.com/pay",
      undefined,
    );
  });
});
