import {
    type Action,
    elizaLogger,
    type IAgentRuntime,
    type Memory,
    type HandlerCallback,
    type State,
    getEmbeddingZeroVector,
    composeContext,
    generateMessageResponse,
    ModelClass,
} from "@elizaos/core";

interface PassportScore {
    address: string;
    score: string;
    threshold: string;
    passing_score: string;
}

const createTokenMemory = async (
    runtime: IAgentRuntime,
    _message: Memory,
    formattedOutput: string
) => {
    const memory: Memory = {
        userId: _message.userId,
        agentId: _message.agentId,
        roomId: _message.roomId,
        content: { text: formattedOutput },
        createdAt: Date.now(),
        embedding: getEmbeddingZeroVector(),
    };
    await runtime.messageManager.createMemory(memory);
};

export const addressTemplate = `From previous sentence extract only the Ethereum address being asked about.
Respond with a JSON markdown block containing only the extracted value:

\`\`\`json
{
"address": string | null
}
\`\`\`
`;

export const getPassportScoreAction: Action = {
    name: "GET_PASSPORT_SCORE",
    description: "Get score from Passport API for an address",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Validating runtime for GET_PASSPORT_SCORE...");
        const apiKey = runtime.getSetting("PASSPORT_API_KEY");
        const scorerId = runtime.getSetting("PASSPORT_SCORER");
        if (!apiKey || !scorerId) {
            elizaLogger.error(
                "Missing PASSPORT_API_KEY or PASSPORT_SCORER settings"
            );
            return false;
        }
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback: HandlerCallback
    ) => {
        elizaLogger.log("Starting GET_PASSPORT_SCORE handler...");
        const apiKey = runtime.getSetting("PASSPORT_API_KEY");
        const scorerId = runtime.getSetting("PASSPORT_SCORER");

        // Initialize or update state
        let currentState = state;
        if (!currentState) {
            currentState = (await runtime.composeState(_message)) as State;
        } else {
            currentState = await runtime.updateRecentMessageState(currentState);
        }

        const context = composeContext({
            state: currentState,
            template: `${_message.content.text}\n${addressTemplate}`,
        });

        const addressRequest = await generateMessageResponse({
            runtime,
            context,
            modelClass: ModelClass.SMALL,
        });

        const address = addressRequest.address as string;

        if (!address) {
            callback({ text: "Address is required." }, []);
            return;
        }

        try {
            const response = await fetch(
                `https://api.passport.xyz/v2/stamps/${scorerId}/score/${address}`,
                {
                    method: "GET",
                    headers: {
                        "X-API-KEY": apiKey,
                        accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data: PassportScore = await response.json();
            const formattedOutput = `Address: ${data.address}\nScore: ${data.score}${data.passing_score ? "\nScore is above threshold" : `\nScore is below threshold (${data.threshold})`}`;

            await createTokenMemory(runtime, _message, formattedOutput);

            callback({ text: formattedOutput }, []);
        } catch (error) {
            elizaLogger.error("Error fetching Passport score:", error);
            callback(
                {
                    text: "Failed to fetch Passport score. Please check the logs for more details.",
                },
                []
            );
        }
    },
    examples: [],
    similes: [
        "GET_PASSPORT_SCORE",
        "FETCH_PASSPORT_SCORE",
        "CHECK_PASSPORT_SCORE",
        "VIEW_PASSPORT_SCORE",
    ],
};
