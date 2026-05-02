import type { Plugin, IAgentRuntime, ServiceTypeName } from "@elizaos/core";

import { JupiterService } from "./service";

export const jupiterPlugin: Plugin = {
  name: "jupiter",
  description: "jupiter dex swap plugin",
  services: [JupiterService],
  init: async (_, runtime: IAgentRuntime) => {
    // extensions
    Promise.all(
      ["chain_solana", "JUPITER_SERVICE"].map((p) =>
        runtime.getServiceLoadPromise(p as ServiceTypeName),
      ),
    )
      .then(() => {
        //runtime.logger.log('Registering jupiter as a solana exchange')
        const solanaService = runtime.getService("chain_solana") as any;
        const me = {
          name: "Jupiter DEX services",
          service: "JUPITER_SERVICE",
        };
        solanaService.registerExchange(me);
      })
      .catch((e) => {
        console.error("jupiter::init - err", e);
      });
  },
};

export default jupiterPlugin;
