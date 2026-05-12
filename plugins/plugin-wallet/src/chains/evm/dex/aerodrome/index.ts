import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createEvmLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { AerodromeLpService } from "./services/AerodromeLpService.ts";

export const aerodromePlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/aerodrome",
  description: "Aerodrome DEX liquidity pool management plugin for Base chain",
  services: [AerodromeLpService],
  actions: [],
  providers: [],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Aerodrome Plugin initialized");
    const service =
      runtime.getService<AerodromeLpService>(AerodromeLpService.serviceType) ??
      (await AerodromeLpService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createEvmLpProtocolProvider({
        dex: "aerodrome",
        label: "Aerodrome",
        service,
      }),
    );
  },
};

export * from "./types.ts";
export { AerodromeLpService };

export default aerodromePlugin;
