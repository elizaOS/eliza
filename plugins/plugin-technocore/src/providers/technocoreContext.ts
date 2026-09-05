import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { cleanText, type TechnocoreService } from "../services/technocore";

export const technocoreContextProvider: Provider = {
  name: "technocoreContext",
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    try {
      const service = runtime.getService?.("technocore") as
        | TechnocoreService
        | undefined;
      if (!service) {
        return {
          text: "[Technocore Protocol]: Service not initialized",
        };
      }

      const defaultRoom =
        (runtime.getSetting?.("TECHNOCORE_DEFAULT_ROOM") as string) ||
        "technocore";

      const result = await service.readRoom(defaultRoom, 3);

      const messages = result.messages || [];
      if (messages.length === 0) {
        return {
          text: `[Technocore Protocol]: Connected as ${service.did.slice(0, 24)}... (Room: /r/${defaultRoom})`,
        };
      }

      const summary = messages
        .map((m) => `- [${m.from.slice(0, 16)}...]: ${cleanText(m.text)}`)
        .join("\n");

      return {
        text: `[Technocore Decentralized Feed (/r/${defaultRoom})]:\n${summary}`,
      };
    } catch (error) {
      // error-policy:J4 provider failure becomes an explicit unavailable state.
      runtime.reportError?.("TechnocoreContextProvider.get", error);
      return {
        text: "[Technocore Protocol]: Feed unavailable",
      };
    }
  },
};
