import { JeeterPostClient } from "./jeeter/post.ts";
import { JeeterSearchClient } from "./jeeter/search.ts";
import { JeeterInteractionClient } from "./jeeter/interactions.ts";
import { IAgentRuntime, Client, elizaLogger } from "@elizaos/core";
import { validateJeeterConfig } from "./jeeter/environment.ts";
import { ClientBase } from "./jeeter/base.ts";

class SimsAIManager {
    client: ClientBase;
    post: JeeterPostClient;
    search: JeeterSearchClient;
    interaction: JeeterInteractionClient;

    constructor(runtime: IAgentRuntime) {
        this.client = new ClientBase(runtime);
        this.post = new JeeterPostClient(this.client, runtime);
        this.search = new JeeterSearchClient(this.client, runtime);
        this.interaction = new JeeterInteractionClient(this.client, runtime);
    }
}

let activeManager: SimsAIManager | null = null;

export const JeeterClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        if (activeManager) {
            elizaLogger.warn("SimsAI client already started");
            return activeManager;
        }

        await validateJeeterConfig(runtime);

        elizaLogger.log("SimsAI client started");

        activeManager = new SimsAIManager(runtime);

        await activeManager.client.init();

        await activeManager.post.start();

        await activeManager.search.start();

        await activeManager.interaction.start();

        return activeManager;
    },
    async stop(_runtime: IAgentRuntime) {
        elizaLogger.log("Stopping SimsAI client");
        if (activeManager) {
            try {
                await activeManager.interaction.stop();
                await activeManager.search.stop();
                await activeManager.post.stop();
                activeManager = null;
                elizaLogger.log("SimsAI client stopped successfully");
            } catch (error) {
                elizaLogger.error("Error stopping SimsAI client:", error);
                throw error;
            }
        }
        elizaLogger.log("SimsAI client stopped");
    },
};

export default JeeterClientInterface;
