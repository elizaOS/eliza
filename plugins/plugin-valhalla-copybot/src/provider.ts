import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import { getValhallaService } from "./service.ts";

export const valhallaStatusProvider: Provider = {
  name: "VALHALLA_STATUS",
  description: "Open Mech positions, mode, and realized P&L. Read only.",
  descriptionCompressed: "Mech book status",
  dynamic: true,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State): Promise<ProviderResult> => {
    try {
      const service = getValhallaService(runtime);
      const text = service.status();
      return { text, values: { valhallaStatus: text }, data: { live: service.live() } };
    } catch {
      return {
        text: "Valhalla Mech is not running. Live trading defaults to off.",
        values: { valhallaStatus: "unavailable" },
        data: { live: false },
      };
    }
  },
};
