import routes from "./apis";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { registerTasks } from "./tasks";

// create a new plugin
export const degenIntelPlugin: Plugin = {
	name: "degen-intel",
    description: "Degen Intel plugin",
	routes,
	init: async (_, runtime: IAgentRuntime) => {
		await registerTasks(runtime);
	}
};
