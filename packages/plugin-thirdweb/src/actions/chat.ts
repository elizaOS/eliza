import {
    elizaLogger,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    type Action,
} from "@elizaos/core";

const BASE_URL = "https://nebula-api.thirdweb.com";

// If chat is a stream, wait for stream to complete before returning response
async function handleStreamResponse(
    response: Response
): Promise<ReadableStream> {
    elizaLogger.log("Starting stream response handling");
    const reader = response.body?.getReader();
    if (!reader) {
        elizaLogger.error("No readable stream available");
        throw new Error("No readable stream available");
    }

    return new ReadableStream({
        async start(controller) {
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        elizaLogger.log("Stream reading completed");
                        break;
                    }

                    const events = new TextDecoder()
                        .decode(value)
                        .split("\n\n");
                    elizaLogger.debug(
                        `Processing ${events.length} stream events`
                    );
                    for (const event of events) {
                        if (!event.trim()) continue;
                        controller.enqueue(event);
                    }
                }
            } finally {
                reader.releaseLock();
                controller.close();
                elizaLogger.log("Stream controller closed");
            }
        },
    });
}

// Process & return a response to the current message with thirdweb Nebula
export const blockchainChatAction: Action = {
    name: "BLOCKCHAIN_CHAT",
    similes: [
        "QUERY_BLOCKCHAIN",
        "CHECK_BLOCKCHAIN",
        "BLOCKCHAIN_SEARCH",
        "CRYPTO_LOOKUP",
        "WEB3_SEARCH",
        "BLOCKCHAIN_HISTORY_EXPLORER",
        "UNIVERSAL_BLOCKCHAIN_TRANSALTOR",
        "BLOCKCHAIN_DATA_PROVIDER",
        "HISTORICAL_BLOCKCHAIN_DATA",
        "TRACK_BLOCKCHAIN_TRANSACTIONS",
        "BLOCKCHAIN_INTERPRETER",
        "BLOCKCHAIN_TRANSACTION_DETAILS",
    ],
    validate: async (
        runtime: IAgentRuntime,
        _message: Memory
    ): Promise<boolean> => {
        const secretKey =
            runtime.getSetting("THIRDWEB_SECRET_KEY") ??
            process.env.THIRDWEB_SECRET_KEY;
        return Boolean(secretKey);
    },
    description:
        "Query blockchain data and execute transactions through natural language interaction with the Nebula API",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,  // Replaced any with Record<string, unknown>
        callback: HandlerCallback
    ): Promise<Record<string, unknown> | ReadableStream> => { 
        try {
            elizaLogger.log("Starting blockchain chat handler");
            const secretKey =
                runtime.getSetting("THIRDWEB_SECRET_KEY") ??
                process.env.THIRDWEB_SECRET_KEY;

            if (!secretKey) {
                elizaLogger.error("THIRDWEB_SECRET_KEY not configured");
                throw new Error("THIRDWEB_SECRET_KEY is not configured");
            }

            const request = {
                message: message.content.text,
                stream: false,
            };

            elizaLogger.log("NEBULA CHAT REQUEST: ", request);

            elizaLogger.debug("Sending request to Nebula API");
            const response = await fetch(`${BASE_URL}/chat`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-secret-key": secretKey,
                },
                body: JSON.stringify(request),
            });
            elizaLogger.debug("Received response from Nebula API");

            if (!request.stream) {
                const text = await response.text();
                elizaLogger.debug("Raw response text:", text);

                try {
                    const cleanedText = text.trim().split("\n").pop() || text;
                    const parsed = JSON.parse(cleanedText);
                    elizaLogger.log("Successfully parsed response:", parsed);

                    console.log(parsed.message);

                    await callback({ text: parsed.message });

                    return parsed;
                } catch (parseError) {
                    elizaLogger.error("Parse error details:", parseError);
                    elizaLogger.error(
                        "Failed to parse JSON response. Raw text:",
                        text
                    );
                    return { text: text };
                }
            }

            elizaLogger.log("Handling streaming response");
            return handleStreamResponse(response);
        } catch (error) {
            elizaLogger.error("Blockchain chat failed:", error);
            throw new Error(`Blockchain chat failed: ${error.message}`);
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "What's the ETH balance of vitalik.eth?",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The current ETH balance of vitalik.eth (0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045) is 1,123.45 ETH",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "send 0.1 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "I'll help you send 0.1 ETH. Please review and sign the transaction.",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me the floor price of BAYC",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "The current floor price for BAYC is 32.5 ETH with 3 sales in the last 24h",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show me my recent transactions",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Here are your recent transactions: 1. Sent 1.5 ETH 2. Swapped tokens on Uniswap 3. Received 0.5 ETH",
                    action: "BLOCKCHAIN_CHAT",
                },
            },
        ],
    ],
} as Action;
