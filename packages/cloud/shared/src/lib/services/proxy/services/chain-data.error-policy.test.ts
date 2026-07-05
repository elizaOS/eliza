// Pins the Chain Data handler's fail-closed error surface (#13415): an upstream
// Alchemy failure must never be swallowed into a fabricated success. Drives the
// real exported chainDataHandler against a mocked global fetch (the only I/O
// boundary); config + retry are the real modules. Covers both transport styles
// (REST getNFTsForOwner, JSON-RPC getTokenBalances) since each has its own
// !response.ok branch.
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { HandlerContext } from "../types";
import { chainDataHandler } from "./chain-data";

const realFetch = globalThis.fetch;

function ctx(method: string, params: Record<string, unknown> = {}): HandlerContext {
  return {
    body: { method, chain: "ethereum", params },
    searchParams: new URLSearchParams(),
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

describe("Chain Data handler — fail-closed error surface", () => {
  it("passes a legitimate REST success through unchanged (the healthy result)", async () => {
    const okBody = { ownedNfts: [], totalCount: 0 };
    globalThis.fetch = mock(async () => Response.json(okBody, { status: 200 }));

    const { response } = await chainDataHandler(ctx("getNFTsForOwner", { owner: "0xabc" }));

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    // A genuinely-empty upstream result (zero NFTs) is a valid success, NOT a
    // failure — it must stay distinct from the 502 error surface below.
    await expect(response.json()).resolves.toEqual(okBody);
  });

  it("translates an upstream REST 5xx into a distinct 502 envelope (never a fake success)", async () => {
    globalThis.fetch = mock(async () => Response.json({ oops: true }, { status: 500 }));

    const { response } = await chainDataHandler(ctx("getNFTsForOwner", { owner: "0xabc" }));

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Chain data provider error",
      code: 500,
    });
  });

  it("translates an upstream JSON-RPC 5xx into a distinct 502 envelope (never a fake success)", async () => {
    globalThis.fetch = mock(async () => Response.json({ oops: true }, { status: 503 }));

    const { response } = await chainDataHandler(ctx("getTokenBalances", { address: "0xabc" }));

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Chain data provider error",
      code: 503,
    });
  });

  it("propagates an upstream timeout as the canonical 'timeout' marker (not swallowed)", async () => {
    globalThis.fetch = mock(async () => {
      const err = new Error("The operation timed out");
      err.name = "TimeoutError";
      throw err;
    });

    await expect(chainDataHandler(ctx("getTokenBalances", { address: "0xabc" }))).rejects.toThrow(
      "timeout",
    );
  });

  it("re-throws a non-timeout transport error unchanged (no default, no empty result)", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(chainDataHandler(ctx("getNFTsForOwner", { owner: "0xabc" }))).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("fails closed when the Alchemy credential is missing (never proceeds keyless)", async () => {
    delete process.env.ALCHEMY_API_KEY;
    // fetch must not even be reached; if it is, surface that as a distinct failure.
    globalThis.fetch = mock(async () => Response.json({}, { status: 200 }));

    await expect(chainDataHandler(ctx("getNFTsForOwner", { owner: "0xabc" }))).rejects.toThrow(
      "ALCHEMY_API_KEY not configured",
    );
  });

  it("rejects an unsupported chain instead of defaulting to a working one", async () => {
    globalThis.fetch = mock(async () => Response.json({}, { status: 200 }));

    const bad: HandlerContext = {
      body: { method: "getNFTsForOwner", chain: "dogecoin", params: {} },
      searchParams: new URLSearchParams(),
      auth: { user: {} } as HandlerContext["auth"],
    };

    await expect(chainDataHandler(bad)).rejects.toThrow("not supported for enhanced data");
  });

  it("rejects an unknown method instead of silently no-op'ing", async () => {
    globalThis.fetch = mock(async () => Response.json({}, { status: 200 }));

    await expect(chainDataHandler(ctx("getNonsense"))).rejects.toThrow("Unknown chain data method");
  });
});
