import { Client, IAgentRuntime, elizaLogger } from "@elizaos/core";
import { AlexaClient } from "./alexa-client";

export const AlexaClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        const alexaClient = new AlexaClient(runtime);

        await alexaClient.start();

        elizaLogger.success(
            `✅ Alexa client successfully started for character ${runtime.character.name}`
        );
        return alexaClient;
    },
    stop: async (runtime: IAgentRuntime) => {
        try {
            // stop it
            elizaLogger.log("Stopping alexa client", runtime.agentId);
            await runtime.clients.alexa.stop();
        } catch (e) {
            elizaLogger.error("client-alexa interface stop error", e);
        }
    },
};

export default AlexaClientInterface;
