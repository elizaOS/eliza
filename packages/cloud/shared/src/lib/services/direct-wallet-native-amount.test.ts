/**
 * Native BNB verification against a local JSON-RPC node: the real viem client
 * reads the receipt and transaction; only the chain is local.
 */
import { afterAll, expect, test } from "bun:test";
import type { DirectWalletNetworkConfig } from "./direct-wallet-payments";
import { verifyEvmNativePayment } from "./direct-wallet-payments";

const PAYER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const TX_HASH = `0x${"ab".repeat(32)}`;
const EXPECTED = 1_000_000_000_000_000_000n; // 1 BNB
let txValue = EXPECTED;

const hex = (value: bigint | number) => `0x${value.toString(16)}`;
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { id, method } = (await request.json()) as { id: number; method: string };
    const result =
      method === "eth_getTransactionReceipt"
        ? {
            transactionHash: TX_HASH,
            blockHash: `0x${"cd".repeat(32)}`,
            blockNumber: hex(100),
            transactionIndex: "0x0",
            from: PAYER,
            to: RECEIVER,
            status: "0x1",
            cumulativeGasUsed: hex(21_000),
            gasUsed: hex(21_000),
            effectiveGasPrice: hex(1),
            contractAddress: null,
            logs: [],
            logsBloom: `0x${"00".repeat(256)}`,
            type: "0x0",
          }
        : method === "eth_getTransactionByHash"
          ? {
              hash: TX_HASH,
              blockHash: `0x${"cd".repeat(32)}`,
              blockNumber: hex(100),
              transactionIndex: "0x0",
              from: PAYER,
              to: RECEIVER,
              value: hex(txValue),
              gas: hex(21_000),
              gasPrice: hex(1),
              input: "0x",
              nonce: "0x0",
              type: "0x0",
              v: "0x1b",
              r: `0x${"11".repeat(32)}`,
              s: `0x${"22".repeat(32)}`,
              chainId: hex(56),
            }
          : null;
    return Response.json({ jsonrpc: "2.0", id, result });
  },
});
afterAll(() => server.stop(true));

const cfg = {
  network: "bsc",
  displayName: "BNB Chain",
  chainId: 56,
  tokenSymbol: "BNB",
  tokenDecimals: 18,
  tokens: [],
  receiveAddress: RECEIVER,
  secureAddress: null,
  rpcUrl: `http://127.0.0.1:${server.port}`,
  enabled: true,
} satisfies DirectWalletNetworkConfig;

const verify = (value: bigint) => {
  txValue = value;
  return verifyEvmNativePayment({
    cfg,
    payerAddress: PAYER,
    txHash: TX_HASH,
    expectedUnits: EXPECTED,
    slippageBps: 200,
  });
};

test("a native payment below the locked quote is refused", async () => {
  await expect(verify((EXPECTED * 98n) / 100n)).rejects.toThrow(/below the expected floor/);
  await expect(verify(EXPECTED - 1n)).rejects.toThrow(/below the expected floor/);
});

test("the exact quote and a payment up to 2% over it credit", async () => {
  expect((await verify(EXPECTED)).receivedUnits).toBe(EXPECTED);
  expect((await verify((EXPECTED * 102n) / 100n)).receivedUnits).toBe((EXPECTED * 102n) / 100n);
});

test("a payment more than 2% over the quote is refused", async () => {
  await expect(verify((EXPECTED * 103n) / 100n)).rejects.toThrow(/above the expected ceiling/);
});
