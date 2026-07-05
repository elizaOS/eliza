// Pins the EVM RPC handler's fail-closed error surface (#13415): an upstream
// failure must never be swallowed into a fabricated success. Drives the real
// exported rpcHandlerForChain against a mocked global fetch (the only I/O
// boundary); config + retry are the real modules.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { HandlerContext } from "../types";
import { rpcHandlerForChain } from "./rpc";

const realFetch = globalThis.fetch;

function ctx(network?: string): HandlerContext {
  const searchParams = new URLSearchParams();
  if (network) searchParams.set("network", network);
  return {
    body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    searchParams,
    // handler never reads auth; a minimal fixture keeps the production type intact.
    auth: { user: {} } as HandlerContext["auth"],
  };
}

beforeEach(() => {
  process.env.ALCHEMY_API_KEY = "test-alchemy-key";
  // One attempt, no backoff delay: exercise the branch, not the retry timer.
  process.env.ALCHEMY_MAX_RETRIES = "1";
  process.env.ALCHEMY_INITIAL_RETRY_DELAY_MS = "0";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ALCHEMY_API_KEY;
  delete process.env.ALCHEMY_MAX_RETRIES;
  delete process.env.ALCHEMY_INITIAL_RETRY_DELAY_MS;
});

describe("EVM RPC handler — fail-closed error surface", () => {
  it("passes a legitimate upstream success through unchanged (the healthy result)", async () => {
    const okBody = { jsonrpc: "2.0", id: 1, result: "0x10" };
    globalThis.fetch = mock(async () => Response.json(okBody, { status: 200 }));

    const { response } = await rpcHandlerForChain("ethereum")(ctx());

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(okBody);
  });

  it("translates an upstream 5xx into a distinct 502 error envelope (never a fake success)", async () => {
    globalThis.fetch = mock(async () => Response.json({ oops: true }, { status: 500 }));

    const { response } = await rpcHandlerForChain("ethereum")(ctx());

    // A failure surface must stay distinguishable from the 200 success above.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Upstream RPC error",
      code: 500,
    });
  });

  it("propagates an upstream timeout as the canonical 'timeout' marker (not swallowed)", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    });

    await expect(rpcHandlerForChain("ethereum")(ctx())).rejects.toThrow("timeout");
  });

  it("re-throws a non-timeout transport error unchanged (no default, no empty result)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(rpcHandlerForChain("ethereum")(ctx())).rejects.toThrow("ECONNREFUSED");
  });

  it("fails closed when the upstream credential is missing (never proceeds keyless)", async () => {
    delete process.env.ALCHEMY_API_KEY;
    // fetch must not even be reached; if it is, surface that as a distinct failure.
    globalThis.fetch = mock(async () => Response.json({}, { status: 200 }));

    await expect(rpcHandlerForChain("ethereum")(ctx())).rejects.toThrow(
      "ALCHEMY_API_KEY not configured",
    );
  });

  it("rejects an unsupported network instead of defaulting to a working one", async () => {
    globalThis.fetch = mock(async () => Response.json({}, { status: 200 }));

    await expect(rpcHandlerForChain("ethereum")(ctx("regtest"))).rejects.toThrow("Invalid network");
  });
});
