/** Steer Finance sub-plugin: vault/staking-pool provider and service, composed into `lpinfoPlugin`. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { steerLiquidityProvider } from "./providers/steerLiquidityProvider";
import { SteerLiquidityService } from "./services/steerLiquidityService";

export const steerPlugin: Plugin = {
  name: "steer-protocol",
  description:
    "Comprehensive Steer Finance protocol integration for viewing vaults, staking pools, and market analytics. Supports multi-chain liquidity pool tracking and yield optimization.",
  providers: [steerLiquidityProvider],
  actions: [],
  services: [SteerLiquidityService],
  async dispose(runtime: IAgentRuntime) {
    const svc = runtime.getService<SteerLiquidityService>(
      SteerLiquidityService.serviceType,
    );
    await svc?.stop();
  },
};

export default steerPlugin;
