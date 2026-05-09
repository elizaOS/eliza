// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  createSolanaLpProtocolProvider,
  registerLpProtocolProvider,
} from "../../../../lp/services/LpManagementService.ts";
import { positionProvider } from "./providers/positionProvider.ts";
import { OrcaService } from "./services/srv_orca.ts";

export const orcaPlugin: Plugin = {
  name: "@elizaos/plugin-lp-manager/orca",
  description: "Orca Whirlpool LP management plugin for Solana",
  providers: [positionProvider],
  actions: [],
  services: [OrcaService],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    console.info("Orca Plugin initialized");
    const service =
      runtime.getService<OrcaService>(OrcaService.serviceType) ??
      (await OrcaService.start(runtime));
    await registerLpProtocolProvider(
      runtime,
      createSolanaLpProtocolProvider({
        dex: "orca",
        label: "Orca",
        service,
      })
    );
  },
};

export * from "./types.ts";
export { OrcaService };

export default orcaPlugin;
