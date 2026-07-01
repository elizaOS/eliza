/**
 * Anvil-fork integration test for the payout transfer path.
 *
 * Forks Base + BSC mainnet via `anvil` and exercises the exact viem call
 * sequence used by `payoutProcessorService.executeEvmPayout`:
 *
 *   1. resolveEvmRpc → http(url) transport
 *   2. createPublicClient.readContract(ERC20.balanceOf) against the live
 *      ELIZA token contract on the fork (proves the token contract is
 *      reachable via our RPC plumbing)
 *   3. createWalletClient.writeContract(transfer) — sent through the same
 *      RPC URL, signed by an impersonated holder
 *   4. publicClient.waitForTransactionReceipt({confirmations: 2}) — proves
 *      the confirmation-waiting path works against the configured RPC
 *
 * The test impersonates an existing ELIZA holder via `anvil_impersonateAccount`,
 * which only works on a forked chain — so this also indirectly verifies the
 * fork-url RPC endpoints (mainnet.base.org / bsc-dataseed.binance.org) are
 * actually serving the production state.
 *
 * Gated on RUN_FORK_TESTS=1 because it needs `anvil` on PATH and outbound
 * HTTPS to the public Base/BSC RPCs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { type Address, createPublicClient, createWalletClient, custom, http, parseAbi } from "viem";
import { base, bsc, type Chain } from "viem/chains";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const RUN = process.env.RUN_FORK_TESTS === "1";

const ELIZA_TOKEN: Address = "0xea17df5cf6d172224892b5477a16acb111182478";
const ERC20_ABI = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
]);

const RECIPIENT: Address = "0x0000000000000000000000000000000000001234";

interface Fork {
  name: string;
  chain: Chain;
  forkUrl: string;
  expectedChainId: number;
  port: number;
  proc: ChildProcess | null;
  rpcUrl: string;
}

const FORKS: Fork[] = [
  {
    name: "base",
    chain: base,
    forkUrl: "https://mainnet.base.org",
    expectedChainId: 8453,
    port: 18545,
    proc: null,
    rpcUrl: "http://127.0.0.1:18545",
  },
  {
    name: "bnb",
    chain: bsc,
    forkUrl: "https://bsc-dataseed.binance.org",
    expectedChainId: 56,
    port: 18546,
    proc: null,
    rpcUrl: "http://127.0.0.1:18546",
  },
];

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpc(url, "eth_chainId");
      return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Anvil at ${url} did not become ready within ${timeoutMs}ms`);
}

async function startAnvil(fork: Fork): Promise<void> {
  fork.proc = spawn(
    "anvil",
    [
      "--fork-url",
      fork.forkUrl,
      "--port",
      String(fork.port),
      "--silent",
      "--chain-id",
      String(fork.expectedChainId),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  fork.proc.stderr?.on("data", (b) => {
    const s = b.toString();
    if (/error|panic|cannot/i.test(s)) {
      console.error(`[anvil ${fork.name}] ${s}`);
    }
  });
  await waitForRpc(fork.rpcUrl);
}

function stopAnvil(fork: Fork): void {
  if (fork.proc && !fork.proc.killed) {
    fork.proc.kill("SIGTERM");
  }
}

/** Find a real ELIZA holder by scanning recent Transfer events on the fork. */
async function findHolder(rpcUrl: string, chain: Chain): Promise<Address | null> {
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const latest = await client.getBlockNumber();
  // Many public RPCs cap eth_getLogs at 10k blocks. Walk back in 5k chunks.
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const chunk = 5000n;
  const maxChunks = 4n;
  let logs: Array<{ topics: string[] }> = [];
  for (let i = 0n; i < maxChunks; i++) {
    const toBlock = latest - i * chunk;
    const fromBlock = toBlock - chunk + 1n;
    if (fromBlock < 0n) break;
    try {
      const window = (await rpc(rpcUrl, "eth_getLogs", [
        {
          address: ELIZA_TOKEN,
          topics: [transferTopic],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
        },
      ])) as Array<{ topics: string[] }>;
      logs = window;
      if (window.length > 0) break;
    } catch {
      // RPC may still rate-limit; try the next chunk.
    }
  }
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    const to = `0x${log.topics[2].slice(26)}` as Address;
    if (to === "0x0000000000000000000000000000000000000000") continue;
    // Confirm this address actually still holds tokens.
    const balance = await client.readContract({
      address: ELIZA_TOKEN,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [to],
    });
    if (balance > 1000n * 10n ** 9n) return to;
  }
  return null;
}

describe.skipIf(!RUN)("payout transfer path against anvil forks", () => {
  beforeAll(async () => {
    await Promise.all(FORKS.map(startAnvil));
  }, 60_000);

  afterAll(() => {
    for (const f of FORKS) stopAnvil(f);
  });

  for (const fork of FORKS) {
    test(`${fork.name}: ELIZA contract reachable via configured RPC`, async () => {
      const client = createPublicClient({
        chain: fork.chain,
        transport: http(fork.rpcUrl),
      });
      const [chainId, name, decimals] = await Promise.all([
        client.getChainId(),
        client.readContract({
          address: ELIZA_TOKEN,
          abi: ERC20_ABI,
          functionName: "name",
        }),
        client.readContract({
          address: ELIZA_TOKEN,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      ]);
      expect(chainId).toBe(fork.expectedChainId);
      expect(name).toMatch(/eliza/i);
      expect(decimals).toBe(9);
    }, 60_000);

    test(`${fork.name}: full payout sequence — impersonate holder → transfer → waitForReceipt(confirmations=2)`, async () => {
      const holder = await findHolder(fork.rpcUrl, fork.chain);
      if (!holder) {
        console.warn(
          `[${fork.name}] no ELIZA holder found in recent blocks; skipping transfer assertion`,
        );
        return;
      }

      // Fund the impersonated holder with native gas, then impersonate.
      await rpc(fork.rpcUrl, "anvil_setBalance", [holder, `0x${(10n ** 18n).toString(16)}`]);
      await rpc(fork.rpcUrl, "anvil_impersonateAccount", [holder]);

      const publicClient = createPublicClient({
        chain: fork.chain,
        transport: http(fork.rpcUrl),
      });
      const walletClient = createWalletClient({
        chain: fork.chain,
        // Use a custom JSON-RPC transport so impersonated accounts work
        // (privateKeyToAccount won't match the holder's address).
        transport: custom({
          async request({ method, params }) {
            return rpc(fork.rpcUrl, method, (params as unknown[]) ?? []);
          },
        }),
      });

      const before = (await publicClient.readContract({
        address: ELIZA_TOKEN,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RECIPIENT],
      })) as bigint;

      const transferAmount = 100n * 10n ** 9n; // 100 ELIZA (decimals=9)
      const transferHash = await walletClient.writeContract({
        account: holder,
        address: ELIZA_TOKEN,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [RECIPIENT, transferAmount],
      });

      // Push the chain forward so confirmations=2 resolves promptly.
      await rpc(fork.rpcUrl, "anvil_mine", ["0x2"]);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transferHash,
        confirmations: 2,
      });
      expect(receipt.status).toBe("success");

      const after = (await publicClient.readContract({
        address: ELIZA_TOKEN,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RECIPIENT],
      })) as bigint;
      expect(after - before).toBe(transferAmount);
    }, 120_000);
  }
});
