/**
 * Opt-in real-chain test for the Aomi wallet execution boundary.
 *
 * Point this at a testnet or Anvil fork. The suite refuses production chain
 * ids, signs through plugin-wallet, verifies the resulting balance change, and
 * exercises an actual insufficient-funds rejection with a fresh empty signer.
 */
import type { WalletRequest } from "@aomi-labs/client";
import type { IAgentRuntime } from "@elizaos/core";
import {
  LocalEoaBackend,
  WALLET_BACKEND_SERVICE_TYPE,
} from "@elizaos/plugin-wallet";
import {
  type Address,
  createPublicClient,
  formatEther,
  type Hex,
  http,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as viemChains from "viem/chains";
import { describe, expect, it } from "vitest";
import type { AomiConfig } from "./config.js";
import { executeWalletRequest, walletRequestPreview } from "./wallet.js";

const live = process.env.ELIZA_E2E_AOMI_WALLET === "1";
const ALLOWED_CHAIN_IDS = new Set([31_337, 84_532, 11_155_111, 59_141, 10_143]);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the live wallet test.`);
  return value;
}

function testChain(chainId: number) {
  const chain = Object.values(viemChains).find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "id") === chainId,
  );
  if (!chain) {
    throw new Error(`viem does not define test chain ${chainId}.`);
  }
  return chain;
}

async function runtimeWithKey(
  privateKey: Hex,
  rpcUrl: string,
): Promise<IAgentRuntime> {
  const settings: Record<string, string> = {
    EVM_PRIVATE_KEY: privateKey,
    AOMI_EVM_RPC_URL: rpcUrl,
  };
  const base = {
    getSetting: (key: string) => settings[key],
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as IAgentRuntime;
  const backend = await LocalEoaBackend.create(base);
  const walletService = {
    getWalletBackend: () => backend,
    getWalletBackendOrNull: () => backend,
  };
  return {
    ...base,
    getService: (type: string) =>
      type === WALLET_BACKEND_SERVICE_TYPE ? walletService : null,
  } as unknown as IAgentRuntime;
}

function transferRequest(
  target: Address,
  chainId: number,
  value: bigint,
  id: string,
): WalletRequest {
  return {
    id,
    kind: "transaction",
    timestamp: Date.now(),
    payload: {
      txId: 1,
      txIds: [1],
      chainId,
      calls: [
        {
          txId: 1,
          chainId,
          to: target,
          value: value.toString(),
        },
      ],
    },
  };
}

describe.runIf(live)("Aomi live wallet execution", () => {
  it("changes chain state and surfaces a real insufficient-funds failure", async () => {
    const privateKey = requiredEnvironment("EVM_PRIVATE_KEY") as Hex;
    const rpcUrl = requiredEnvironment("AOMI_EVM_RPC_URL");
    const chainId = Number.parseInt(requiredEnvironment("AOMI_CHAIN_ID"), 10);
    if (!ALLOWED_CHAIN_IDS.has(chainId)) {
      throw new Error(
        `Refusing live wallet test on chain ${chainId}; use a supported testnet or chain 31337 fork.`,
      );
    }

    const chain = testChain(chainId);
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const sender = privateKeyToAccount(privateKey);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const value = 1n;
    const request = transferRequest(recipient, chainId, value, "aomi-e2e-send");
    const config: AomiConfig = {
      apiUrl: "https://api.aomi.dev",
      app: "default",
      chainId,
      evmRpcUrl: rpcUrl,
    };

    const senderBefore = await client.getBalance({ address: sender.address });
    const recipientBefore = await client.getBalance({ address: recipient });
    const result = await executeWalletRequest(
      await runtimeWithKey(privateKey, rpcUrl),
      config,
      request,
    );
    expect(result.kind).toBe("transaction");
    if (result.kind !== "transaction") return;

    const receipt = await client.waitForTransactionReceipt({
      hash: result.txHash as Hex,
    });
    const senderAfter = await client.getBalance({ address: sender.address });
    const recipientAfter = await client.getBalance({ address: recipient });

    const emptyKey = generatePrivateKey();
    const emptyAddress = privateKeyToAccount(emptyKey).address;
    expect(await client.getBalance({ address: emptyAddress })).toBe(0n);
    await expect(
      executeWalletRequest(
        await runtimeWithKey(emptyKey, rpcUrl),
        config,
        transferRequest(recipient, chainId, 1n, "aomi-e2e-insufficient"),
      ),
    ).rejects.toThrow(/insufficient|exceeds the balance/i);

    expect(receipt.status).toBe("success");
    expect(recipientAfter - recipientBefore).toBe(value);
    expect(senderAfter).toBeLessThan(senderBefore);
    console.info(
      JSON.stringify({
        network: { chainId, rpcUrl: new URL(rpcUrl).origin },
        preview: walletRequestPreview(request),
        txHash: result.txHash,
        receipt: {
          status: receipt.status,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
        },
        balances: {
          sender: {
            address: sender.address,
            before: formatEther(senderBefore),
            after: formatEther(senderAfter),
          },
          recipient: {
            address: recipient,
            before: formatEther(recipientBefore),
            after: formatEther(recipientAfter),
          },
        },
        failurePath: {
          kind: "insufficient-funds",
          address: emptyAddress,
          balance: "0",
        },
      }),
    );
  }, 120_000);
});
