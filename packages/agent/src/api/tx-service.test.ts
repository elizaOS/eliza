/**
 * Behavioral coverage for tx-service.ts: JSON-RPC probing, constructor
 * validation, nonce/balance/fee helpers, contract runners, and wait-for-tx
 * outcomes. Provider RPC is stubbed; Wallet address derivation and Ether
 * formatting stay on the real ethers implementation.
 */
import { logger } from "@elizaos/core";
import * as ethers from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatPrivateKeyPreview,
  probeJsonRpcEndpoint,
  TxService,
} from "./tx-service";

const VALID_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VALID_KEY_NO_PREFIX = VALID_KEY.slice(2);
const RPC_URL = "http://127.0.0.1:8545";
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
] as const;

type ProviderStub = {
  getBalance: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  estimateGas: ReturnType<typeof vi.fn>;
  getFeeData: ReturnType<typeof vi.fn>;
  waitForTransaction: ReturnType<typeof vi.fn>;
  getTransactionCount: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const providerCtl = vi.hoisted(() => {
  const providers: ProviderStub[] = [];
  let nextInit: ((stub: ProviderStub) => void) | undefined;

  function createProviderStub(): ProviderStub {
    return {
      getBalance: vi.fn(),
      getNetwork: vi.fn(),
      estimateGas: vi.fn(),
      getFeeData: vi.fn(),
      waitForTransaction: vi.fn(),
      getTransactionCount: vi.fn(),
      destroy: vi.fn(),
    };
  }

  return {
    providers,
    setNextInit(init: (stub: ProviderStub) => void) {
      nextInit = init;
    },
    reset() {
      providers.length = 0;
      nextInit = undefined;
    },
    alloc(): ProviderStub {
      const stub = createProviderStub();
      nextInit?.(stub);
      nextInit = undefined;
      providers.push(stub);
      return stub;
    },
  };
});

vi.mock("ethers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ethers")>();
  class JsonRpcProvider {
    constructor(_url?: string) {
      Object.assign(this, providerCtl.alloc());
    }
  }
  return {
    ...actual,
    JsonRpcProvider,
  };
});

vi.mock("@elizaos/core", async () => {
  const wellFormed = await import("../../../core/src/utils/well-formed.ts");
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    toWellFormedUnicode: wellFormed.toWellFormedUnicode,
    truncateWellFormed: wellFormed.truncateWellFormed,
  };
});

function jsonRpcFetch(
  body: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: init.statusText ?? "",
    json: async () => body,
  };
}

describe("formatPrivateKeyPreview", () => {
  it("returns the placeholder for empty, short, and exactly-10-character keys", () => {
    expect(formatPrivateKeyPreview("")).toBe("(empty or too short)");
    expect(formatPrivateKeyPreview("abcdefghij")).toBe("(empty or too short)");
  });

  it("keeps the first 6 and last 4 characters for a longer well-formed key", () => {
    expect(formatPrivateKeyPreview("0123456789abc")).toBe("012345...9abc");
  });
});

describe("probeJsonRpcEndpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects an empty URL before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeJsonRpcEndpoint("   ")).rejects.toThrow(/required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs eth_chainId and reports ok when the result is hex", async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8545/");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      });
      return jsonRpcFetch({ result: "0x1" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeJsonRpcEndpoint(`  ${RPC_URL}  `)).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports the HTTP status when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRpcFetch({}, { ok: false, status: 502, statusText: "Bad Gateway" }),
      ),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "HTTP 502 Bad Gateway",
    });
  });

  it("trims a blank HTTP statusText from the failure reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRpcFetch({}, { ok: false, status: 500, statusText: "" }),
      ),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "HTTP 500",
    });
  });

  it("uses the JSON-RPC error message when eth_chainId is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonRpcFetch({ error: { message: "method not found" } }),
      ),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "method not found",
    });
  });

  it("falls back when the JSON-RPC error message is not a string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRpcFetch({ result: 1, error: { message: 12 } })),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "missing eth_chainId result",
    });
  });

  it("rejects a 0x result that is not hex", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonRpcFetch({ result: "0xzz" })),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "missing eth_chainId result",
    });
  });

  it("reports a timeout when fetch aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL, 15)).resolves.toEqual({
      ok: false,
      reason: "timed out after 15ms",
    });
  });

  it("surfaces a non-abort Error message from fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "ECONNREFUSED",
    });
  });

  it("stringifies a non-Error fetch rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw "socket hang up";
      }),
    );
    await expect(probeJsonRpcEndpoint(RPC_URL)).resolves.toEqual({
      ok: false,
      reason: "socket hang up",
    });
  });
});

describe("TxService", () => {
  beforeEach(() => {
    providerCtl.reset();
    vi.mocked(logger.info).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an invalid private key before touching the RPC URL", () => {
    expect(() => new TxService("", "not-a-key")).toThrow(
      /Invalid EVM_PRIVATE_KEY: expected 64-character hex string, got \(empty or too short\)/,
    );
  });

  it("includes a redacted preview for a too-short hex key", () => {
    expect(() => new TxService(RPC_URL, "0x1234567890abcdef")).toThrow(
      /got 0x1234\.\.\.cdef/,
    );
  });

  it("rejects a 63-character hex key, a 65-character hex key, and non-hex", () => {
    const hex63 = `0x${"a".repeat(63)}`;
    const hex65 = `0x${"a".repeat(65)}`;
    expect(() => new TxService(RPC_URL, hex63)).toThrow(
      /Invalid EVM_PRIVATE_KEY/,
    );
    expect(() => new TxService(RPC_URL, hex65)).toThrow(
      /Invalid EVM_PRIVATE_KEY/,
    );
    expect(() => new TxService(RPC_URL, `0x${"g".repeat(64)}`)).toThrow(
      /Invalid EVM_PRIVATE_KEY/,
    );
  });

  it("rejects an invalid RPC URL after a valid key", () => {
    expect(() => new TxService("   ", VALID_KEY)).toThrow(/required/);
    expect(() => new TxService("ws://eth.example", VALID_KEY)).toThrow(
      /expected http: or https:/,
    );
  });

  it("derives the checksum address from a 0x-prefixed key", () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    expect(service.address).toBe(new ethers.Wallet(VALID_KEY).address);
    expect(providerCtl.providers).toHaveLength(1);
  });

  it("accepts a 64-character key without the 0x prefix", () => {
    const service = new TxService(RPC_URL, VALID_KEY_NO_PREFIX);
    expect(service.address).toBe(new ethers.Wallet(VALID_KEY).address);
  });

  it("accepts mixed-case hex private keys", () => {
    const mixed = `0x${VALID_KEY_NO_PREFIX.slice(0, 32).toUpperCase()}${VALID_KEY_NO_PREFIX.slice(32).toLowerCase()}`;
    const service = new TxService(RPC_URL, mixed);
    expect(service.address).toBe(new ethers.Wallet(VALID_KEY).address);
  });

  it("fetches a pending nonce on a fresh provider and destroys it", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.setNextInit((stub) => {
      stub.getTransactionCount.mockResolvedValue(9);
    });

    await expect(service.getFreshNonce()).resolves.toBe(9);
    const fresh = providerCtl.providers[1];
    expect(fresh?.getTransactionCount).toHaveBeenCalledWith(
      service.address,
      "pending",
    );
    expect(fresh?.destroy).toHaveBeenCalledOnce();
    expect(providerCtl.providers[0]?.destroy).not.toHaveBeenCalled();
  });

  it("destroys the fresh nonce provider even when the lookup fails", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const failure = new Error("rpc unavailable");
    providerCtl.setNextInit((stub) => {
      stub.getTransactionCount.mockRejectedValue(failure);
    });

    await expect(service.getFreshNonce()).rejects.toBe(failure);
    expect(providerCtl.providers[1]?.destroy).toHaveBeenCalledOnce();
  });

  it("returns the wallet balance as wei and as formatted ether", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.getBalance.mockResolvedValue(10n ** 18n);
    await expect(service.getBalance()).resolves.toBe(10n ** 18n);
    expect(providerCtl.providers[0]?.getBalance).toHaveBeenCalledWith(
      service.address,
    );
    await expect(service.getBalanceFormatted()).resolves.toBe("1.0");
  });

  it("returns the numeric chain id from the provider network", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.getNetwork.mockResolvedValue(
      ethers.Network.from(11155111),
    );
    await expect(service.getChainId()).resolves.toBe(11155111);
  });

  it("binds getContract to the wallet and getReadOnlyContract to the provider", () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const writable = service.getContract(
      "0x0000000000000000000000000000000000000001",
      ERC20_ABI,
    );
    const readable = service.getReadOnlyContract(
      "0x0000000000000000000000000000000000000002",
      ERC20_ABI,
    );
    expect(writable.target).toBe("0x0000000000000000000000000000000000000001");
    expect(readable.target).toBe("0x0000000000000000000000000000000000000002");
    expect(writable.runner).toBeInstanceOf(ethers.Wallet);
    expect((writable.runner as ethers.Wallet).address).toBe(service.address);
    expect(readable.runner).not.toBeInstanceOf(ethers.Wallet);
    expect(readable.runner).toHaveProperty(
      "getBalance",
      providerCtl.providers[0]?.getBalance,
    );
  });

  it("forwards estimateGas and getFeeData to the provider", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const tx = { to: service.address, value: 1n };
    const fee = new ethers.FeeData(2n, 3n, 1n);
    providerCtl.providers[0]?.estimateGas.mockResolvedValue(21_000n);
    providerCtl.providers[0]?.getFeeData.mockResolvedValue(fee);
    await expect(service.estimateGas(tx)).resolves.toBe(21_000n);
    await expect(service.getFeeData()).resolves.toBe(fee);
    expect(providerCtl.providers[0]?.estimateGas).toHaveBeenCalledWith(tx);
  });

  it("returns the receipt when waitForTransaction succeeds", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const receipt = { status: 1 } as ethers.TransactionReceipt;
    providerCtl.providers[0]?.waitForTransaction.mockResolvedValue(receipt);
    await expect(service.waitForTransaction("0xabc")).resolves.toBe(receipt);
    expect(providerCtl.providers[0]?.waitForTransaction).toHaveBeenCalledWith(
      "0xabc",
      1,
      120_000,
    );
  });

  it("passes custom confirmations and timeout through to the provider", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const receipt = { status: 1 } as ethers.TransactionReceipt;
    providerCtl.providers[0]?.waitForTransaction.mockResolvedValue(receipt);
    await service.waitForTransaction("0xdef", 3, 5_000);
    expect(providerCtl.providers[0]?.waitForTransaction).toHaveBeenCalledWith(
      "0xdef",
      3,
      5_000,
    );
  });

  it("throws a timeout error when the provider returns a null receipt", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.waitForTransaction.mockResolvedValue(null);
    await expect(service.waitForTransaction("0xdead", 1, 50)).rejects.toThrow(
      "Transaction 0xdead timed out after 50ms",
    );
  });

  it("throws when the mined receipt has a reverted status", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.waitForTransaction.mockResolvedValue({
      status: 0,
    } as ethers.TransactionReceipt);
    await expect(service.waitForTransaction("0xbad")).rejects.toThrow(
      "Transaction 0xbad reverted",
    );
  });

  it("rethrows a provider failure from waitForTransaction", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const failure = new Error("connection reset");
    providerCtl.providers[0]?.waitForTransaction.mockRejectedValue(failure);
    await expect(service.waitForTransaction("0xeee")).rejects.toBe(failure);
  });

  it("prices gas from gasPrice, then maxFeePerGas, then zero", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    const tx = { to: service.address };
    providerCtl.providers[0]?.estimateGas.mockResolvedValue(21_000n);

    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(2n, 9n, 1n),
    );
    await expect(service.estimateGasCostEth(tx)).resolves.toBe(
      ethers.formatEther(21_000n * 2n),
    );

    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(null, 3n, 1n),
    );
    await expect(service.estimateGasCostEth(tx)).resolves.toBe(
      ethers.formatEther(21_000n * 3n),
    );

    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(null, null, null),
    );
    await expect(service.estimateGasCostEth(tx)).resolves.toBe("0.0");
  });

  it("compares value plus gas cost against the wallet balance", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(2n, null, null),
    );

    providerCtl.providers[0]?.getBalance.mockResolvedValue(20n);
    await expect(service.hasEnoughBalance(10n, 5n)).resolves.toBe(true);

    providerCtl.providers[0]?.getBalance.mockResolvedValue(19n);
    await expect(service.hasEnoughBalance(10n, 5n)).resolves.toBe(false);
  });

  it("uses maxFeePerGas and a zero fallback when gasPrice is absent", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.getBalance.mockResolvedValue(10n);

    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(null, 4n, 1n),
    );
    await expect(service.hasEnoughBalance(2n, 2n)).resolves.toBe(true);
    await expect(service.hasEnoughBalance(3n, 2n)).resolves.toBe(false);

    providerCtl.providers[0]?.getFeeData.mockResolvedValue(
      new ethers.FeeData(null, null, null),
    );
    await expect(service.hasEnoughBalance(10n, 99n)).resolves.toBe(true);
    await expect(service.hasEnoughBalance(11n, 0n)).resolves.toBe(false);
  });

  it("logs address, chain id, and formatted balance", async () => {
    const service = new TxService(RPC_URL, VALID_KEY);
    providerCtl.providers[0]?.getBalance.mockResolvedValue(5n * 10n ** 17n);
    providerCtl.providers[0]?.getNetwork.mockResolvedValue(
      ethers.Network.from(1),
    );

    await service.logStatus();

    expect(logger.info).toHaveBeenCalledWith(
      `[tx-service] address=${service.address} chain=1 balance=0.5 ETH`,
    );
  });
});
