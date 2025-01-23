import {
    type Action,
    type IAgentRuntime,
    type Memory,
    type HandlerCallback,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { createSession } from "../providers/devinRequests";

export const startSessionAction: Action = {
    name: "START_DEVIN_SESSION",
    description: "Creates a new Devin session and returns session info",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.getSetting("DEVIN_API_TOKEN");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: Record<string, unknown>,
        callback?: HandlerCallback
    ) => {
        try {
            if (!callback) {
                elizaLogger.error("No callback provided for startSessionAction");
                return;
            }

            const prompt = message.content.text;
            if (!prompt) {
                callback({ text: "No prompt provided for session creation" }, []);
                return;
            }

            const sessionInfo = await createSession(runtime, prompt);
            callback(
                {
                    text: `New Devin session created successfully:
Session ID: ${sessionInfo.session_id}
Status: ${sessionInfo.status_enum}
URL: ${sessionInfo.url}`,
                    action: "START_SESSION",
                },
                []
            );
        } catch (error) {
            elizaLogger.error("Error creating Devin session:", error);
            if (!callback) {
                return;
            }
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            callback(
                {
                    text: `Failed to create Devin session: ${errorMessage}`,
                    error: errorMessage,
                },
                []
            );
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Start a new Devin session with prompt: Help me with my code" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "New Devin session created successfully:\nSession ID: abc123\nStatus: running\nURL: https://app.devin.ai/sessions/abc123",
                    action: "START_SESSION"
                },
            },
        ],
    ],
    similes: ["create devin session", "start devin session", "begin devin session"],
};
