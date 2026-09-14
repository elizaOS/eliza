/**
 * Exercises the EVM RPC handler's error and replay boundaries through a mocked
 * provider fetch. Configuration and the shared attempt engine execute for real.
 */
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
  it.each([
    "eth_sendRawTransaction",
    "eth_newFilter",
    "eth_newBlockFilter",
    "eth_newPendingTransactionFilter",
    "eth_getFilterChanges",
    "eth_uninstallFilter",
    "eth_subscribe",
    "eth_unsubscribe",
  ])("does not replay an ambiguous %s, alone or inside a read batch", async (method) => {
    process.env.ALCHEMY_MAX_RETRIES = "3";
    const mutation = { jsonrpc: "2.0", id: 2, method, params: [] };
    for (const body of [mutation, [ctx().body, mutation]]) {
      let providerExecutions = 0;
      globalThis.fetch = mock(async () => {
        providerExecutions += 1;
        throw new Error("connection lost after provider execution");
      });
      await expect(rpcHandlerForChain("ethereum")({ ...ctx(), body })).rejects.toThrow(
        "connection lost after provider execution",
      );
      expect(providerExecutions).toBe(1);
    }
  });

  it("retries a read-only batch after a transient provider failure", async () => {
    process.env.ALCHEMY_MAX_RETRIES = "3";
    const result = [{ jsonrpc: "2.0", id: 1, result: "0x10" }];
    let attempts = 0;
    globalThis.fetch = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return Response.json(result);
    });
    const { response } = await rpcHandlerForChain("ethereum")({
      ...ctx(),
      body: [ctx().body],
    });
    await expect(response.json()).resolves.toEqual(result);
    expect(attempts).toBe(2);
  });

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
