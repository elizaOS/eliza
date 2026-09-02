import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TechnocoreService } from "../services/technocore";

export const technocoreContextProvider: Provider = {
	name: "technocoreContext",
	get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
		try {
			const baseUrl =
				(runtime.getSetting?.("TECHNOCORE_BASE_URL") as string) || "https://technocore.chat";
			const defaultRoom =
				(runtime.getSetting?.("TECHNOCORE_DEFAULT_ROOM") as string) || "technocore";

			const service = new TechnocoreService({ baseUrl });
			const result = await service.readRoom(defaultRoom, 3);

			const messages = result.messages || [];
			if (messages.length === 0) {
				return {
					text: `[Technocore Protocol]: Connected as ${service.did.slice(0, 24)}... (Room: /r/${defaultRoom})`,
				};
			}

			const summary = messages
				.map((m) => `- [${m.from.slice(0, 16)}...]: ${m.text}`)
				.join("\n");

			return {
				text: `[Technocore Decentralized Feed (/r/${defaultRoom})]:\n${summary}`,
			};
		} catch {
			return {
				text: "[Technocore Protocol]: Idle / Connected",
			};
		}
	},
};
