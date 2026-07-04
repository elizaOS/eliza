/**
 * Composite liquidity-pool analytics plugin merging Steer Finance (vault/
 * staking pools) and Kamino Protocol (lending/liquidity pools) providers,
 * actions, and services into a single sub-plugin for pool tracking, yield
 * analytics, and position management on Solana.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { kaminoPlugin } from "./kamino";
import { steerPlugin } from "./steer";

export const lpinfoPlugin: Plugin = {
  name: "lpinfo",
  description:
    "Comprehensive liquidity pool information plugin supporting Steer Finance and Kamino Protocol for pool tracking, yield optimization, and position management",
  providers: [
    ...(steerPlugin.providers || []),
    ...(kaminoPlugin.providers || []),
  ],
  actions: [...(steerPlugin.actions || []), ...(kaminoPlugin.actions || [])],
  services: [...(steerPlugin.services || []), ...(kaminoPlugin.services || [])],
  async dispose(runtime: IAgentRuntime) {
    await steerPlugin.dispose?.(runtime);
    await kaminoPlugin.dispose?.(runtime);
  },
};

export default lpinfoPlugin;

export { kaminoPlugin } from "./kamino";
export * from "./kamino/providers/kaminoLiquidityProvider";
export * from "./kamino/providers/kaminoPoolProvider";
export * from "./kamino/providers/kaminoProvider";
export * from "./kamino/services/kaminoLiquidityService";
export * from "./kamino/services/kaminoService";
// Sub-plugins are re-exported individually so callers can wire just one protocol.
export { steerPlugin } from "./steer";
export * from "./steer/providers/steerLiquidityProvider";
export * from "./steer/services/steerLiquidityService";
