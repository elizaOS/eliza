/**
 * /api/admin/rpc-status
 *
 * Probes every configured EVM RPC and reports chainId, latest block, and
 * ELIZA-token balanceOf for the hot wallet. Lets admins verify pay-in and
 * payout RPCs are actually reachable from the worker.
 */

import { Hono } from "hono";
import { type Address, createPublicClient, http } from "viem";

import { requireAdmin } from "@/lib/auth/workers-hono-auth";
import {
  type EvmPayoutNetwork,
  listEvmPayoutNetworks,
  resolveEvmRpc,
} from "@/lib/config/evm-rpc";
import { ELIZA_DECIMALS, ERC20_ABI, EVM_CHAINS } from "@/lib/config/token-constants";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { ELIZA_TOKEN_ADDRESSES, type SupportedNetwork } from "@/lib/services/eliza-token-price";
import { getHotWalletAddresses } from "@/lib/services/payout-status";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const PROBE_TIMEOUT_MS = 5000;

interface RpcProbe {
  network: EvmPayoutNetwork;
  chainId: number;
  rpcUrl: string;
  rpcSource: string;
  reachable: boolean;
  latencyMs: number | null;
  latestBlock: string | null;
  hotWalletAddress: string | null;
  hotWalletBalance: number | null;
  error: string | null;
}

async function probeNetwork(
  network: EvmPayoutNetwork,
  hotWalletAddress: Address | null,
): Promise<RpcProbe> {
  const chain = EVM_CHAINS[network];
  const { url, source } = resolveEvmRpc(network);
  const result: RpcProbe = {
    network,
    chainId: chain.id,
    rpcUrl: redact(url),
    rpcSource: source,
    reachable: false,
    latencyMs: null,
    latestBlock: null,
    hotWalletAddress,
    hotWalletBalance: null,
    error: null,
  };

  const client = createPublicClient({ chain, transport: http(url, { timeout: PROBE_TIMEOUT_MS }) });
  const started = Date.now();
  try {
    const [chainId, block] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
    if (chainId !== chain.id) {
      result.error = `chainId mismatch: rpc returned ${chainId}, expected ${chain.id}`;
      return result;
    }
    result.reachable = true;
    result.latencyMs = Date.now() - started;
    result.latestBlock = block.toString();

    if (hotWalletAddress) {
      const tokenAddress = ELIZA_TOKEN_ADDRESSES[network as SupportedNetwork] as Address;
      const raw = await client.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [hotWalletAddress],
      });
      result.hotWalletBalance =
        Number(raw) / 10 ** ELIZA_DECIMALS[network as keyof typeof ELIZA_DECIMALS];
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function redact(url: string): string {
  // Strip api keys from infura/alchemy-style URLs for the response payload.
  return url.replace(/(api[-_]?key=|\/v[23]\/|\/[a-f0-9]{20,}\b)/gi, (m) =>
    m.startsWith("api") ? m.split("=")[0] + "=***" : "/***",
  );
}

function hotWalletFromEnv(): Address | null {
  const evm = getHotWalletAddresses().evm;
  return evm ? (evm as Address) : null;
}

const app = new Hono<AppEnv>();

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  await requireAdmin(c);

  const hotWallet = hotWalletFromEnv();
  const probes = await Promise.all(
    listEvmPayoutNetworks().map((net) => probeNetwork(net, hotWallet)),
  );

  const env = getCloudAwareEnv();
  const solana = {
    rpcUrl: redact(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"),
    configured: Boolean(env.SOLANA_PAYOUT_PRIVATE_KEY),
  };

  const allReachable = probes.every((p) => p.reachable);
  if (!allReachable) {
    logger.warn("[admin/rpc-status] one or more RPCs unreachable", {
      failed: probes.filter((p) => !p.reachable).map((p) => p.network),
    });
  }

  return c.json({
    success: true,
    data: {
      evm: probes,
      solana,
      allReachable,
      hotWalletAddress: hotWallet,
      checkedAt: new Date().toISOString(),
    },
  });
});

export default app;
