/**
 * EVM send outcome against a real local chain: `anvil` mines every
 * transaction, and a small JSON-RPC proxy in front of it delays or rejects
 * only the `eth_sendRawTransaction` response. A delayed answer is the case a
 * slow RPC or a gateway timeout gives: the node accepted the transaction,
 * but the wallet's 4 s RPC timeout fires first. The transfer and swap paths
 * must then report the hash as unconfirmed, never as a failure, because a
 * retry after a "failed" report pays a second time.
 *
 * Runs only where `anvil` (Foundry) is on PATH.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { type Address, createPublicClient, type Hex, parseEther, http as viemHttp } from "viem";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletBackendService } from "../../../services/wallet-backend-service";
import type { WalletRouterResult } from "../../../types/wallet-router";
import { SwapAction } from "../../evm/actions/swap";
import { NATIVE_TOKEN_ADDRESS } from "../../evm/constants";
import { initWalletProvider } from "../../evm/providers/wallet";
import type { SwapQuote } from "../../evm/types";
import { registerDefaultWalletChainHandlers } from "../../registry";
import { walletRouterAction } from "../../wallet-action";
import { ANVIL_ADDRESS, ANVIL_ADDRESS_2, ANVIL_PRIVATE_KEY } from "./custom-chain";

const HAS_ANVIL = spawnSync("anvil", ["--version"], { stdio: "ignore" }).status === 0;
const ANVIL_PORT = 18645;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
// A contract that answers every call with the word 18, so `decimals()` is 18
// and `transfer(address,uint256)` returns true. Runtime bytecode:
// PUSH1 0x12 PUSH1 0 MSTORE PUSH1 0x20 PUSH1 0 RETURN
const TOKEN = "0x00000000000000000000000000000000000e1a20" as Address;
const TOKEN_CODE = "0x601260005260206000f3" as Hex;

type SendMode = "pass" | "delay" | "reject" | "duplicate";
let sendMode: SendMode = "pass";
let anvil: ChildProcess | undefined;
let proxy: http.Server | undefined;
let proxyUrl = "";

const chainClient = createPublicClient({ chain: foundry, transport: viemHttp(ANVIL_URL) });

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

function startProxy(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      const isSend = body.includes("eth_sendRawTransaction");
      if (isSend && sendMode === "reject") {
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "insufficient funds for gas * price + value" },
          })
        );
        return;
      }
      const forward = async () => {
        const upstream = await fetch(ANVIL_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        return upstream.text();
      };
      let text = await forward();
      // A gateway that already passed the transaction to the node (for
      // example the Eliza Cloud RPC before its public fallback) sends it
      // again: the client gets the node's answer to the second copy.
      if (isSend && sendMode === "duplicate") text = await forward();
      // The node has the transaction now; only its answer is late.
      if (isSend && sendMode === "delay") await new Promise((r) => setTimeout(r, 5_000));
      if (res.destroyed) return;
      res.setHeader("content-type", "application/json");
      res.end(text);
    });
  });
  proxy = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function createRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    EVM_PRIVATE_KEY: ANVIL_PRIVATE_KEY,
    ETHEREUM_PROVIDER_FOUNDRY: proxyUrl,
  };
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "send-outcome-agent",
    character: { name: "Send Outcome", settings: { chains: { evm: ["foundry"] } } },
    getSetting: (key: string) => settings[key] ?? null,
    getService: () => null,
    getServicesByType: () => [],
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    deleteCache: async (key: string) => cache.delete(key),
    logger: { debug() {}, info() {}, log() {}, warn() {}, error() {} },
  };
  return runtime as unknown as IAgentRuntime;
}

function routerFor(runtime: IAgentRuntime): WalletBackendService {
  const service = new WalletBackendService(runtime);
  registerDefaultWalletChainHandlers(service, runtime);
  (runtime as { getService: (name: string) => unknown }).getService = (name) =>
    name === WalletBackendService.serviceType ? service : null;
  return service;
}

async function settled(): Promise<{ nonce: number; recipientWei: bigint }> {
  await rpc("evm_mine");
  return {
    nonce: await chainClient.getTransactionCount({ address: ANVIL_ADDRESS }),
    recipientWei: await chainClient.getBalance({ address: ANVIL_ADDRESS_2 }),
  };
}

function message(text: string, id: string): Memory {
  return {
    id,
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

function metadataOf(result: WalletRouterResult): Record<string, unknown> {
  if (!result.ok) throw new Error(`router failed: ${result.error}: ${result.detail}`);
  return (result.result.metadata ?? {}) as Record<string, unknown>;
}

describe.skipIf(!HAS_ANVIL)("EVM send outcome after the node accepted the transaction", () => {
  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await rpc("eth_chainId");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await rpc("anvil_setCode", [TOKEN, TOKEN_CODE]);
    proxyUrl = await startProxy();
  }, 20_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (proxy ? proxy.close(() => resolve()) : resolve()));
    anvil?.kill();
  });

  beforeEach(() => {
    sendMode = "pass";
  });

  it("reports a native transfer whose send answer timed out as unconfirmed, with the mined hash", async () => {
    const runtime = createRuntime();
    const service = routerFor(runtime);
    const before = await settled();

    sendMode = "delay";
    const result = await service.routeWalletAction({
      subaction: "transfer",
      chain: "foundry",
      fromToken: "ETH",
      amount: "1",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
      dryRun: false,
    });
    const after = await settled();

    // The node accepted the transfer: 1 ETH moved once.
    expect(after.recipientWei - before.recipientWei).toBe(parseEther("1"));
    expect(after.nonce).toBe(before.nonce + 1);
    expect(result.ok).toBe(true);
    const metadata = metadataOf(result);
    expect(metadata.confirmationStatus).toBe("unconfirmed");
    expect(metadata.sendUncertain).toBe(true);
    const hash = (result.ok ? result.result.transactionHash : undefined) as Hex;
    const mined = await chainClient.getTransaction({ hash });
    expect(mined.to?.toLowerCase()).toBe(ANVIL_ADDRESS_2.toLowerCase());
  }, 30_000);

  it("reports an ERC-20 transfer whose send answer timed out as unconfirmed, with the mined hash", async () => {
    const runtime = createRuntime();
    const service = routerFor(runtime);
    const before = await settled();

    sendMode = "delay";
    const result = await service.routeWalletAction({
      subaction: "transfer",
      chain: "foundry",
      fromToken: TOKEN,
      amount: "5",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
      dryRun: false,
    });
    const after = await settled();

    expect(after.nonce).toBe(before.nonce + 1);
    expect(result.ok).toBe(true);
    const metadata = metadataOf(result);
    expect(metadata.confirmationStatus).toBe("unconfirmed");
    expect(metadata.sendUncertain).toBe(true);
    const hash = (result.ok ? result.result.transactionHash : undefined) as Hex;
    const mined = await chainClient.getTransaction({ hash });
    expect(mined.to?.toLowerCase()).toBe(TOKEN.toLowerCase());
  }, 30_000);

  it("reports a swap whose send answer timed out as unconfirmed, with the mined hash", async () => {
    const runtime = createRuntime();
    const walletProvider = await initWalletProvider(runtime);
    const swap = new SwapAction(walletProvider);
    // Only the aggregator quote API is replaced; signing, sending and the
    // retry loop over quotes run for real against the chain.
    const quote: SwapQuote = {
      aggregator: "bebop",
      minOutputAmount: "1",
      swapData: {
        data: "0x" as Hex,
        sellAmount: parseEther("2").toString(),
        approvalTarget: TOKEN,
        from: ANVIL_ADDRESS,
        value: parseEther("2").toString(),
        to: ANVIL_ADDRESS_2,
        gas: "21000",
        gasPrice: "0",
      },
    };
    vi.spyOn(
      swap as unknown as { getSortedQuotes: () => Promise<SwapQuote[]> },
      "getSortedQuotes"
    ).mockResolvedValue([quote]);
    const before = await settled();

    sendMode = "delay";
    const tx = await swap.swap({
      chain: "foundry" as never,
      fromToken: NATIVE_TOKEN_ADDRESS,
      toToken: TOKEN,
      amount: "2",
      slippageBps: 100,
    });
    const after = await settled();

    expect(after.recipientWei - before.recipientWei).toBe(parseEther("2"));
    expect(after.nonce).toBe(before.nonce + 1);
    expect(tx.confirmationStatus).toBe("unconfirmed");
    expect(tx.sendUncertain).toBe(true);
    const mined = await chainClient.getTransaction({ hash: tx.hash });
    expect(mined.value).toBe(parseEther("2"));
  }, 30_000);

  it("tells the user not to retry a WALLET transfer whose send answer timed out", async () => {
    const runtime = createRuntime();
    routerFor(runtime);
    const parameters = {
      subaction: "transfer",
      chain: "foundry",
      fromToken: "ETH",
      amount: "1",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
    };
    const first = await walletRouterAction.handler(
      runtime,
      message("send 1 ETH", "00000000-0000-0000-0000-000000000001"),
      undefined,
      { parameters } as HandlerOptions
    );
    expect(first?.data?.requiresConfirmation).toBe(true);
    const before = await settled();

    sendMode = "delay";
    const confirmed = await walletRouterAction.handler(
      runtime,
      message("yes, confirm", "00000000-0000-0000-0000-000000000005"),
      undefined,
      { parameters } as HandlerOptions
    );
    const after = await settled();

    expect(after.recipientWei - before.recipientWei).toBe(parseEther("1"));
    expect(confirmed?.text).toContain("Confirmation uncertain");
    expect(confirmed?.text).toContain("Do not retry the transfer automatically.");
    expect(confirmed?.values?.walletActionSucceeded).toBe(false);
  }, 30_000);

  it("reports a transfer whose send answer says the node already has it as unconfirmed", async () => {
    const runtime = createRuntime();
    const service = routerFor(runtime);
    const before = await settled();

    sendMode = "duplicate";
    const result = await service.routeWalletAction({
      subaction: "transfer",
      chain: "foundry",
      fromToken: "ETH",
      amount: "1",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
      dryRun: false,
    });
    const after = await settled();

    expect(after.recipientWei - before.recipientWei).toBe(parseEther("1"));
    expect(after.nonce).toBe(before.nonce + 1);
    expect(result.ok).toBe(true);
    const metadata = metadataOf(result);
    expect(metadata.confirmationStatus).toBe("unconfirmed");
    expect(metadata.sendUncertain).toBe(true);
    const hash = (result.ok ? result.result.transactionHash : undefined) as Hex;
    const mined = await chainClient.getTransaction({ hash });
    expect(mined.to?.toLowerCase()).toBe(ANVIL_ADDRESS_2.toLowerCase());
  }, 30_000);

  it("still reports a transfer the node rejected as failed, so a retry is safe", async () => {
    const runtime = createRuntime();
    const service = routerFor(runtime);
    const before = await settled();

    sendMode = "reject";
    const result = await service.routeWalletAction({
      subaction: "transfer",
      chain: "foundry",
      fromToken: "ETH",
      amount: "1",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
      dryRun: false,
    });
    const after = await settled();

    expect(after.nonce).toBe(before.nonce);
    expect(after.recipientWei).toBe(before.recipientWei);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toBe("EXECUTION_FAILED");
    expect(result.ok ? "" : result.detail).toContain("insufficient funds");
  }, 30_000);

  it("reports a transfer with a prompt answer as submitted, not unconfirmed", async () => {
    const runtime = createRuntime();
    const service = routerFor(runtime);
    const result = await service.routeWalletAction({
      subaction: "transfer",
      chain: "foundry",
      fromToken: "ETH",
      amount: "1",
      recipient: ANVIL_ADDRESS_2,
      mode: "execute",
      dryRun: false,
    });
    expect(result.ok).toBe(true);
    const metadata = metadataOf(result);
    expect(metadata.confirmationStatus).toBeUndefined();
    expect(metadata.sendUncertain).toBeUndefined();
  }, 30_000);
});
