/** Host configuration and credential adapter for the wallet-owned watcher. */

import type { WalletBalancesResponse } from "@elizaos/contracts";
import type { AgentRuntime } from "@elizaos/core";
import {
  registerWalletBalanceDeltaProducer as registerProducer,
  type WalletBalanceSampleSource,
} from "@elizaos/plugin-wallet/watcher";

export * from "@elizaos/plugin-wallet/watcher";

/**
 * Production balance source: the same address resolution, RPC readiness, and
 * fetchers the `/api/wallet/balances` route uses, with fail-fast legs (a leg
 * that is configured but unreadable throws instead of reading as empty).
 * Modules are imported lazily so agent boot does not pay for the wallet stack
 * until the first watcher fire.
 */
export function createAgentWalletBalanceSource(
  agentId?: string | null,
): WalletBalanceSampleSource {
  return async () => {
    const [walletApi, walletRpc, configModule] = await Promise.all([
      import("../api/wallet.ts"),
      import("../api/wallet-rpc.ts"),
      import("../config/config.ts"),
    ]);
    const addresses = walletApi.getWalletAddresses(agentId);
    const readiness = walletRpc.resolveWalletRpcReadiness(
      configModule.loadEffectiveElizaConfig(),
    );
    const evmReady = Boolean(addresses.evmAddress && readiness.evmBalanceReady);
    const solReady = Boolean(
      addresses.solanaAddress && readiness.solanaBalanceReady,
    );
    if (!evmReady && !solReady) return null;

    const alchemyKey = process.env.ALCHEMY_API_KEY?.trim() || null;
    const ankrKey = process.env.ANKR_API_KEY?.trim() || null;
    const heliusKey = process.env.HELIUS_API_KEY?.trim() || null;

    const result: WalletBalancesResponse = { evm: null, solana: null };
    const legs: Promise<void>[] = [];
    if (evmReady && addresses.evmAddress) {
      const evmAddress = addresses.evmAddress;
      legs.push(
        walletApi
          .fetchEvmBalances(evmAddress, {
            alchemyKey,
            ankrKey,
            cloudManagedAccess: readiness.cloudManagedAccess,
            bscRpcUrls: readiness.bscRpcUrls,
            ethereumRpcUrls: readiness.ethereumRpcUrls,
            baseRpcUrls: readiness.baseRpcUrls,
            avaxRpcUrls: readiness.avalancheRpcUrls,
            nodeRealBscRpcUrl: process.env.NODEREAL_BSC_RPC_URL,
            quickNodeBscRpcUrl: process.env.QUICKNODE_BSC_RPC_URL,
            bscRpcUrl: process.env.BSC_RPC_URL,
            ethereumRpcUrl: process.env.ETHEREUM_RPC_URL,
            baseRpcUrl: process.env.BASE_RPC_URL,
            avaxRpcUrl: process.env.AVALANCHE_RPC_URL,
          })
          .then((chains) => {
            result.evm = { address: evmAddress, chains };
          }),
      );
    }
    if (solReady && addresses.solanaAddress) {
      const solanaAddress = addresses.solanaAddress;
      legs.push(
        (heliusKey
          ? walletApi.fetchSolanaBalances(solanaAddress, heliusKey)
          : walletApi.fetchSolanaNativeBalanceViaRpc(
              solanaAddress,
              readiness.solanaRpcUrls,
            )
        ).then((solanaData) => {
          result.solana = { address: solanaAddress, ...solanaData };
        }),
      );
    }
    // Promise.all: a single failed configured leg fails the whole sample —
    // the dispatcher translates that into a typed retryable failure rather
    // than treating the missing leg as an empty wallet.
    await Promise.all(legs);
    return result;
  };
}

export async function registerWalletBalanceDeltaProducer(
  runtime: AgentRuntime,
  options: { source?: WalletBalanceSampleSource } = {},
): Promise<void> {
  return registerProducer(runtime, {
    source: options.source ?? createAgentWalletBalanceSource(runtime.agentId),
  });
}
