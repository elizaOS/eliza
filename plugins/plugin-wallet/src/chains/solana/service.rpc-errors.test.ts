/**
 * RPC-failure contract for SolanaService balance and token-account reads, the
 * wallet routes built on them, and the portfolio cache. Uses the real service
 * prototype and real route handlers with only the RPC connection stubbed, so
 * the assertions cover the code path a down or rate-limited RPC actually takes
 * (#31110). Deterministic; no network.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { SOLANA_WALLET_DATA_CACHE_KEY } from "./constants";
import { solanaRoutes } from "./routes/index";
import { SolanaService } from "./service";

const ADDR = "11111111111111111111111111111112";
// Public USDC mint on mainnet, used only as a held-token lookup key.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC_ERROR = new Error(
  "failed to get info about accounts: Server responded with 500 Internal Server Error"
);
const RATE_LIMIT_ERROR = new Error("429 Too Many Requests");

type Stub = {
  getMultipleAccountsInfo: () => Promise<unknown[]>;
  getParsedTokenAccountsByOwner: () => Promise<{ value: unknown[] }>;
};

function serviceWithConnection(connection: Stub) {
  const cache = new Map<string, unknown>();
  const svc = Object.create(SolanaService.prototype) as SolanaService & {
    connection: Stub;
    decimalsCache: Map<string, number>;
    runtime: unknown;
    lastUpdate: number;
    UPDATE_INTERVAL: number;
    ensurePublicKey: () => Promise<PublicKey>;
  };
  svc.connection = connection;
  svc.decimalsCache = new Map();
  svc.lastUpdate = 0;
  svc.UPDATE_INTERVAL = 0;
  svc.runtime = {
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
    },
    getSetting: () => undefined,
  };
  svc.getPublicKey = async () => new PublicKey(ADDR);
  svc.ensurePublicKey = async () => new PublicKey(ADDR);
  return { svc, cache };
}

function mkRes() {
  const res = { statusCode: 200, payload: undefined as unknown } as {
    statusCode: number;
    payload: unknown;
    status: (code: number) => typeof res;
    json: (body: unknown) => typeof res;
    send: (body: unknown) => typeof res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.payload = body;
    return res;
  };
  res.send = res.json;
  return res;
}

const routeByPath = Object.fromEntries(solanaRoutes.map((route) => [route.path, route.handler]));

describe("SolanaService RPC failures", () => {
  it("throws a typed error from getTokenAccountsByKeypair instead of returning []", async () => {
    const { svc } = serviceWithConnection({
      getMultipleAccountsInfo: async () => {
        throw RPC_ERROR;
      },
      getParsedTokenAccountsByOwner: async () => {
        throw RPC_ERROR;
      },
    });
    await expect(svc.getTokenAccountsByKeypair(new PublicKey(ADDR), {})).rejects.toMatchObject({
      code: "SOLANA_RPC_UNAVAILABLE",
      cause: RPC_ERROR,
    });
  });

  it("throws a typed error from getBalancesByAddrs instead of returning {}", async () => {
    const { svc } = serviceWithConnection({
      getMultipleAccountsInfo: async () => {
        throw RPC_ERROR;
      },
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    });
    await expect(svc.getBalancesByAddrs([ADDR])).rejects.toMatchObject({
      code: "SOLANA_RPC_UNAVAILABLE",
    });
  });

  it("bounds the 429 retry and surfaces a rate-limit error", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { svc } = serviceWithConnection({
        getMultipleAccountsInfo: async () => {
          calls += 1;
          throw RATE_LIMIT_ERROR;
        },
        getParsedTokenAccountsByOwner: async () => ({ value: [] }),
      });
      const pending = svc.getBalancesByAddrs([ADDR]);
      const settled = expect(pending).rejects.toMatchObject({
        code: "SOLANA_RPC_RATE_LIMITED",
      });
      await vi.runAllTimersAsync();
      await settled;
      expect(calls).toBe(SolanaService.BALANCE_READ_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers when the rate limit clears within the retry budget", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const { svc } = serviceWithConnection({
        getMultipleAccountsInfo: async () => {
          calls += 1;
          if (calls === 1) throw RATE_LIMIT_ERROR;
          return [{ lamports: 2_000_000_000 }];
        },
        getParsedTokenAccountsByOwner: async () => ({ value: [] }),
      });
      const pending = svc.getBalancesByAddrs([ADDR]);
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({ [ADDR]: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache an empty portfolio while the RPC is down", async () => {
    const { svc, cache } = serviceWithConnection({
      getMultipleAccountsInfo: async () => {
        throw RPC_ERROR;
      },
      getParsedTokenAccountsByOwner: async () => {
        throw RPC_ERROR;
      },
    });
    await expect(svc.updateWalletData(true)).rejects.toMatchObject({
      code: "SOLANA_RPC_UNAVAILABLE",
    });
    expect(cache.has(SOLANA_WALLET_DATA_CACHE_KEY)).toBe(false);
  });

  it("still caches a genuinely empty portfolio when the RPC reports no accounts", async () => {
    const { svc, cache } = serviceWithConnection({
      getMultipleAccountsInfo: async () => [],
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    });
    await expect(svc.updateWalletData(true)).resolves.toMatchObject({
      totalUsd: "0",
      items: [],
    });
    expect(cache.get(SOLANA_WALLET_DATA_CACHE_KEY)).toMatchObject({
      totalUsd: "0",
      items: [],
    });
  });

  it("answers the balance and token routes with 500, not 200/0 or 404, while the RPC is down", async () => {
    const { svc } = serviceWithConnection({
      getMultipleAccountsInfo: async () => {
        throw RPC_ERROR;
      },
      getParsedTokenAccountsByOwner: async () => {
        throw RPC_ERROR;
      },
    });
    const runtime = {
      getService: () => svc,
      logger: { warn: vi.fn(), error: vi.fn() },
      getCache: async () => undefined,
      setCache: async () => undefined,
    } as never;

    const balance = mkRes();
    await routeByPath["/wallet/balance"]({ params: {} } as never, balance as never, runtime);
    expect(balance.statusCode).toBe(500);
    expect(balance.payload).toMatchObject({
      success: false,
      error: { code: "ERROR" },
    });

    const token = mkRes();
    await routeByPath["/wallet/balance/:token"](
      { params: { token: USDC_MINT } } as never,
      token as never,
      runtime
    );
    expect(token.statusCode).toBe(500);
    expect(token.payload).not.toMatchObject({
      error: { code: "TOKEN_NOT_FOUND" },
    });
  });
});
