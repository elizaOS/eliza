import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TechnocoreService } from "../services/technocore";

function getTechnocoreService(runtime: IAgentRuntime): TechnocoreService {
	return (
		(runtime.getService?.("technocore") as TechnocoreService) ||
		new TechnocoreService(runtime)
	);
}

export const technocoreContextProvider: Provider = {
	name: "technocoreContext",
	get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
		try {
			const defaultRoom =
				(runtime.getSetting?.("TECHNOCORE_DEFAULT_ROOM") as string) || "technocore";

			const service = getTechnocoreService(runtime);
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
		} catch (error) {
			// error-policy:J4 provider failure becomes an explicit unavailable state.
			runtime.reportError?.("TechnocoreContextProvider.get", error);
			return {
				text: "[Technocore Protocol]: Feed unavailable",
			};
		}
	},
};
