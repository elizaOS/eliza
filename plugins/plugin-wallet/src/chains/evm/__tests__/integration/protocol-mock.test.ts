/**
 * Drives the production WalletProvider viem clients through a resettable local
 * Base JSON-RPC simulator; no wallet or RPC client methods are replaced.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, test } from "vitest";
import {
  EVM_RPC_MAX_REQUEST_BYTES,
  startEvmRpcMock,
} from "../../../../../../../packages/cloud/test-mocks/src/wallet-evm";
import { WalletProvider } from "../../providers/wallet";

const RECIPIENT = "0x2222222222222222222222222222222222222222" as const;
const runningMocks: Awaited<ReturnType<typeof startEvmRpcMock>>[] = [];

async function startMock(
  balances: Record<string, bigint> = {},
  bearerToken = "synthetic-rpc-token",
  revertRecipients: string[] = []
) {
  const mock = await startEvmRpcMock({ balances, bearerToken, revertRecipients });
  runningMocks.push(mock);
  return mock;
}

function providerFor(
  url: string,
  account: ReturnType<typeof privateKeyToAccount>,
  bearerToken = "synthetic-rpc-token"
): WalletProvider {
  const chain = WalletProvider.genChainFromName("base");
  return new WalletProvider(
    account,
    {} as IAgentRuntime,
    { base: chain },
    {
      base: {
        rpcUrl: url,
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    }
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out awaiting RPC state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(runningMocks.splice(0).map((mock) => mock.stop()));
});

describe("wallet EVM JSON-RPC protocol mock", () => {
  test("reads chain state, applies one signed transfer, deduplicates, and rolls it back on reorg", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const openingBalance = 10_000_000_000_000_000n;
    const transferValue = 1_000_000_000_000_000n;
    const mock = await startMock({
      [account.address]: openingBalance,
      [RECIPIENT]: 0n,
    });
    const provider = providerFor(mock.url, account);
    const publicClient = provider.getPublicClient("base");
    const walletClient = provider.getWalletClient("base");
    const initialState = mock.store.readback();

    await expect(publicClient.getChainId()).resolves.toBe(8453);
    await expect(publicClient.getBlockNumber()).resolves.toBe(100n);
    const block = await publicClient.getBlock({ blockTag: "latest" });
    expect(block.number).toBe(100n);
    expect(block.timestamp).toBe(1_800_000_000n);
    await expect(publicClient.getBalance({ address: account.address })).resolves.toBe(
      openingBalance
    );
    await expect(
      publicClient.call({
        account: account.address,
        to: RECIPIENT,
        data: "0x",
      })
    ).resolves.toMatchObject({ data: undefined });

    const raw = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: RECIPIENT,
      value: transferValue,
    });
    const hash = await walletClient.sendRawTransaction({
      serializedTransaction: raw,
    });
    await expect(walletClient.sendRawTransaction({ serializedTransaction: raw })).resolves.toBe(
      hash
    );
    await expect(
      publicClient.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })
    ).resolves.toBeNull();

    mock.store.mine();
    const firstReceipt = await publicClient.getTransactionReceipt({ hash });
    expect(firstReceipt.status).toBe("success");
    await expect(publicClient.getBalance({ address: account.address })).resolves.toBe(
      openingBalance - transferValue
    );
    await expect(publicClient.getBalance({ address: RECIPIENT })).resolves.toBe(transferValue);
    await expect(publicClient.getTransactionCount({ address: account.address })).resolves.toBe(1);
    expect(mock.store.readback()).toMatchObject({
      blockNumber: 101,
      timestamp: 1_800_000_002,
      transactions: [{ hash, state: "mined", value: transferValue.toString() }],
    });

    mock.store.reorg(1);
    await expect(
      publicClient.request({
        method: "eth_getTransactionReceipt",
        params: [hash],
      })
    ).resolves.toBeNull();
    await expect(publicClient.getBalance({ address: account.address })).resolves.toBe(
      openingBalance
    );
    await expect(publicClient.getBalance({ address: RECIPIENT })).resolves.toBe(0n);
    mock.store.mine();
    const replacementReceipt = await publicClient.getTransactionReceipt({ hash });
    expect(replacementReceipt.status).toBe("success");
    expect(replacementReceipt.blockHash).not.toBe(firstReceipt.blockHash);

    const readback = mock.store.readback();
    expect(
      readback.observations
        .filter((entry) => entry.method === "eth_sendRawTransaction")
        .map((entry) => entry.outcome)
    ).toEqual(["accepted", "duplicate"]);
    expect(JSON.stringify(readback)).not.toContain(raw);
    expect(JSON.stringify(readback)).not.toContain("synthetic-rpc-token");

    mock.store.reset();
    const replayState = mock.store.readback();
    const { generation: _initialGeneration, ...initialWorld } = initialState;
    const { generation: _replayGeneration, ...replayedWorld } = replayState;
    expect(replayedWorld).toEqual(initialWorld);
    const replayedBlock = await publicClient.getBlock({ blockTag: "latest" });
    expect(replayedBlock.hash).toBe(block.hash);
    expect(replayedBlock.timestamp).toBe(block.timestamp);
    await expect(publicClient.getBalance({ address: account.address })).resolves.toBe(
      openingBalance
    );
  });

  test("mines an explicit reverted receipt without applying a fabricated effect", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const openingBalance = 100n;
    const mock = await startMock(
      { [account.address]: openingBalance, [RECIPIENT]: 0n },
      "synthetic-rpc-token",
      [RECIPIENT]
    );
    const provider = providerFor(mock.url, account);
    const publicClient = provider.getPublicClient("base");
    const walletClient = provider.getWalletClient("base");
    const raw = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: RECIPIENT,
      value: 11n,
    });
    const hash = await walletClient.sendRawTransaction({
      serializedTransaction: raw,
    });

    mock.store.mine();

    await expect(publicClient.getTransactionReceipt({ hash })).resolves.toMatchObject({
      status: "reverted",
    });
    await expect(publicClient.getBalance({ address: account.address })).resolves.toBe(
      openingBalance
    );
    await expect(publicClient.getBalance({ address: RECIPIENT })).resolves.toBe(0n);
    await expect(publicClient.getTransactionCount({ address: account.address })).resolves.toBe(1);

    const insufficient = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce: 1,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: "0x3333333333333333333333333333333333333333",
      value: openingBalance + 1n,
    });
    await expect(
      walletClient.sendRawTransaction({ serializedTransaction: insufficient })
    ).rejects.toThrow("Insufficient funds");
    expect(mock.store.readback().transactions).toHaveLength(1);
    await expect(
      publicClient.request({
        method: "eth_getTransactionReceipt",
        params: ["0x01"],
      })
    ).rejects.toThrow("32-byte transaction hash");
    await expect(
      walletClient.sendRawTransaction({
        serializedTransaction: "0x1" as `0x02${string}`,
      })
    ).rejects.toThrow("even-length raw transaction bytes");
  });

  test("deduplicates a retry after an ambiguous post-accept timeout", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mock = await startMock({
      [account.address]: 1_000n,
      [RECIPIENT]: 0n,
    });
    const provider = providerFor(mock.url, account);
    const publicClient = provider.getPublicClient("base");
    const walletClient = provider.getWalletClient("base");
    const raw = await account.signTransaction({
      chainId: 8453,
      type: "eip1559",
      nonce: 0,
      gas: 21_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: RECIPIENT,
      value: 100n,
    });
    mock.store.setFault("stall_after_accept", "eth_sendRawTransaction");

    await expect(walletClient.sendRawTransaction({ serializedTransaction: raw })).rejects.toThrow();
    await waitFor(() => mock.store.pendingResponseCount === 0);
    const accepted = mock.store.readback();
    expect(accepted.transactions).toHaveLength(1);
    expect(accepted.observations).toContainEqual(
      expect.objectContaining({
        method: "eth_sendRawTransaction",
        outcome: "accepted",
        responseFault: "stalled",
      })
    );
    expect(accepted.observations).toContainEqual(
      expect.objectContaining({
        method: "eth_sendRawTransaction",
        outcome: "cancelled",
      })
    );
    const hash = accepted.transactions[0]?.hash;
    if (!hash) throw new Error("Expected admitted transaction hash");

    mock.store.setFault(null);
    await expect(walletClient.sendRawTransaction({ serializedTransaction: raw })).resolves.toBe(
      hash
    );
    expect(mock.store.readback().transactions).toHaveLength(1);
    mock.store.mine();
    await expect(publicClient.getTransactionReceipt({ hash })).resolves.toMatchObject({
      status: "success",
    });
    await expect(publicClient.getBalance({ address: RECIPIENT })).resolves.toBe(100n);

    expect(mock.store.pendingResponseCount).toBe(0);
  }, 10_000);

  test("enforces synthetic auth without retaining credentials", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mock = await startMock({}, "expected-synthetic-token");
    const client = providerFor(mock.url, account, "wrong-synthetic-token").getPublicClient("base");

    await expect(client.getChainId()).rejects.toThrow();
    expect(mock.store.readback().observations).toContainEqual(
      expect.objectContaining({
        method: "eth_chainId",
        authorized: false,
        outcome: "unauthorized",
      })
    );
    const serialized = JSON.stringify(mock.store.readback());
    expect(serialized).not.toContain("expected-synthetic-token");
    expect(serialized).not.toContain("wrong-synthetic-token");
  });

  test("surfaces rate-limit, provider, and malformed failures from real HTTP", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mock = await startMock();
    const client = providerFor(mock.url, account).getPublicClient("base");

    mock.store.setFault("rate_limit", "eth_blockNumber");
    await expect(client.getBlockNumber()).rejects.toThrow();
    mock.store.setFault("provider_error", "eth_blockNumber");
    await expect(client.getBlockNumber()).rejects.toThrow("Synthetic provider failure");
    mock.store.setFault("malformed_json", "eth_blockNumber");
    await expect(client.getBlockNumber()).rejects.toThrow();
    expect(
      mock.store
        .readback()
        .observations.filter((entry) => entry.method === "eth_blockNumber")
        .map((entry) => entry.outcome)
    ).toEqual(expect.arrayContaining(["rate_limited", "provider_error", "malformed"]));
    mock.store.reset();
    expect(mock.store.pendingResponseCount).toBe(0);
  });

  test("bounds request admission and never reflects raw transactions or credentials", async () => {
    const bearerToken = "BOUNDARY_BEARER_SECRET_7f92";
    const mock = await startMock({}, bearerToken);
    const account = privateKeyToAccount(generatePrivateKey());
    const walletClient = providerFor(mock.url, account, bearerToken).getWalletClient("base");
    const rpc = (
      body: BodyInit,
      headers: Record<string, string> = { "content-type": "application/json" }
    ) =>
      fetch(mock.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, ...headers },
        body,
      });
    const envelope = (params: unknown[]) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params });

    const wrongType = await rpc(envelope([]), { "content-type": "text/plain" });
    expect(wrongType.status).toBe(415);
    const encoded = await rpc(envelope([]), {
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
    expect(encoded.status).toBe(415);
    const oversized = await rpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
        padding: "x".repeat(EVM_RPC_MAX_REQUEST_BYTES),
      })
    );
    expect(oversized.status).toBe(413);
    const invalidUtf8 = await rpc(new Uint8Array([0xff, 0xfe]));
    expect(invalidUtf8.status).toBe(400);

    let deeplyNested: unknown = "leaf";
    for (let depth = 0; depth < 20; depth += 1) deeplyNested = [deeplyNested];
    const deep = await rpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [deeplyNested] })
    );
    expect(deep.status).toBe(400);
    const wide = await rpc(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [Array.from({ length: 2_100 }, () => 0)],
      })
    );
    expect(wide.status).toBe(400);

    const distinctiveRaw = `0x${"deadbeef".repeat(40)}`;
    const invalidTransaction = await rpc(envelope([distinctiveRaw]));
    expect(invalidTransaction.status).toBe(200);
    const invalidTransactionBody = await invalidTransaction.text();
    expect(invalidTransactionBody).toContain("Invalid signed transaction encoding");
    expect(invalidTransactionBody).not.toContain(distinctiveRaw);
    expect(invalidTransactionBody).not.toContain(bearerToken);

    let clientFailure = "";
    try {
      await walletClient.sendRawTransaction({
        serializedTransaction: distinctiveRaw as `0x02${string}`,
      });
    } catch (error) {
      clientFailure = error instanceof Error ? error.message : String(error);
    }
    expect(clientFailure).toContain("Invalid signed transaction encoding");
    expect(clientFailure).not.toContain(distinctiveRaw);
    expect(clientFailure).not.toContain(bearerToken);

    const serializedReadback = JSON.stringify(mock.store.readback());
    expect(mock.store.readback().transactions).toEqual([]);
    expect(serializedReadback).not.toContain(distinctiveRaw);
    expect(serializedReadback).not.toContain(bearerToken);
  });

  test("generation-fences a stalled request across reset", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mock = await startMock();
    const client = providerFor(mock.url, account).getPublicClient("base");
    mock.store.setFault("stall", "eth_blockNumber");
    const stalled = client.getBlockNumber();
    await waitFor(() => mock.store.pendingResponseCount === 1);
    const staleGeneration = mock.store.generation;

    mock.store.reset({ blockNumber: 700, timestamp: 1_900_000_000 });

    await expect(stalled).rejects.toThrow();
    expect(mock.store.readback()).toMatchObject({
      generation: staleGeneration + 1,
      blockNumber: 700,
      timestamp: 1_900_000_000,
      fault: null,
      transactions: [],
      observations: [],
    });
    expect(mock.store.pendingResponseCount).toBe(0);
  });
});
