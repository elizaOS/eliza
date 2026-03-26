/**
 * @elizaos/plugin-gas-station
 *
 * ElizaOS plugin that lets AI agents swap USDC for native gas tokens (POL/ETH)
 * via the GasStation trustless contract on Polygon.
 *
 * Contract: https://github.com/pino12033/gas-station-sol
 *
 * ## Quick start
 *
 * ```ts
 * import { gasStationPlugin } from "@elizaos/plugin-gas-station";
 *
 * const runtime = new AgentRuntime({
 *   plugins: [gasStationPlugin],
 *   // ...
 * });
 * ```
 *
 * ## Configuration (environment variables or character settings)
 *
 * | Variable                   | Description                                      | Default                          |
 * |----------------------------|--------------------------------------------------|----------------------------------|
 * | GAS_STATION_ADDRESS        | Deployed contract address (Polygon)              | (empty → mock mode)              |
 * | GAS_STATION_PRIVATE_KEY    | Agent wallet private key (0x...)                 | (empty → mock mode)              |
 * | GAS_STATION_RPC_URL        | Polygon RPC endpoint                             | https://polygon-rpc.com          |
 * | GAS_STATION_USDC           | USDC token address on Polygon                    | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 |
 * | GAS_STATION_MOCK           | Force mock mode ("true"/"false")                 | "true" when address not set      |
 *
 * ## Actions
 *
 * - **BUY_GAS** — swap a specified USDC amount for native gas.
 *   Triggers on phrases like "buy gas for 2 USDC", "get me 5 USDC worth of POL", etc.
 */

import type { Plugin } from "@elizaos/core";
import { buyGasAction } from "./actions/buyGas.js";

export { buyGasAction } from "./actions/buyGas.js";

/**
 * GasStation plugin for ElizaOS.
 *
 * Registers the BUY_GAS action and a status provider showing current
 * contract liquidity.
 */
export const gasStationPlugin: Plugin = {
  name: "gas-station",
  description:
    "Swap USDC for native gas (POL/ETH) using the GasStation trustless contract on Polygon. " +
    "Solves the cold-start gas problem for AI agents that receive USDC but need gas to transact.",

  actions: [buyGasAction],

  // Optional: expose a /gas-station/status HTTP route for monitoring dashboards
  routes: [
    {
      type: "GET",
      public: true,
      name: "status",
      path: "/status",
      handler: async (_req, res, runtime) => {
        const contractAddress = runtime.getSetting("GAS_STATION_ADDRESS");
        const isMock =
          runtime.getSetting("GAS_STATION_MOCK") === "true" || !contractAddress;

        if (isMock) {
          res.status(200).json({
            mode: "mock",
            contractAddress: null,
            message: "Set GAS_STATION_ADDRESS to enable live mode",
            contractRepo: "https://github.com/pino12033/gas-station-sol",
          });
          return;
        }

        // Try to fetch live liquidity
        try {
          const { createPublicClient, http } = await import("viem");
          const { polygon } = await import("viem/chains");

          const rpcUrl =
            runtime.getSetting("GAS_STATION_RPC_URL") ??
            "https://polygon-rpc.com";

          const client = createPublicClient({
            chain: polygon,
            transport: http(rpcUrl),
          });

          const liquidity = await client.readContract({
            address: contractAddress as `0x${string}`,
            abi: [
              {
                name: "liquidity",
                type: "function",
                stateMutability: "view",
                inputs: [],
                outputs: [{ name: "", type: "uint256" }],
              },
            ] as const,
            functionName: "liquidity",
          });

          const { formatEther } = await import("viem");
          res.status(200).json({
            mode: "live",
            contractAddress,
            liquidityPol: formatEther(liquidity as bigint),
            polygonScan: `https://polygonscan.com/address/${contractAddress}`,
          });
        } catch (err) {
          res.status(500).json({
            mode: "live",
            contractAddress,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
  ],
};

export default gasStationPlugin;
