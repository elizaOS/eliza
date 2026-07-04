/** Kamino Protocol sub-plugin: lending/liquidity providers and services, composed into `lpinfoPlugin`. */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { kaminoLiquidityProvider } from "./providers/kaminoLiquidityProvider";
import { kaminoPoolProvider } from "./providers/kaminoPoolProvider";
import { kaminoProvider } from "./providers/kaminoProvider";
import { KaminoLiquidityService } from "./services/kaminoLiquidityService";
import { KaminoService } from "./services/kaminoService";

export const kaminoPlugin: Plugin = {
  name: "kamino-protocol",
  description:
    "Comprehensive Kamino protocol integration for viewing lending positions, liquidity pools, and market analytics. Supports position tracking and yield optimization.",
  providers: [kaminoProvider, kaminoLiquidityProvider, kaminoPoolProvider],
  actions: [],
  services: [KaminoService, KaminoLiquidityService],
  async dispose(runtime: IAgentRuntime) {
    const kamino = runtime.getService<KaminoService>(KaminoService.serviceType);
    await kamino?.stop();
    const liquidity = runtime.getService<KaminoLiquidityService>(
      KaminoLiquidityService.serviceType,
    );
    await liquidity?.stop();
  },
};

export default kaminoPlugin;
