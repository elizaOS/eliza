import { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

const DEFAULT_AURA_BASE_URL = "https://auragateway.app";
const MAX_PROMPT_LENGTH = 2000;

function getGatewayBaseUrl(runtime: IAgentRuntime): string {
    const configured = runtime.getSetting("AURA_BASE_URL");
    return (configured || DEFAULT_AURA_BASE_URL).replace(/\/+$/, "");
}

function validateSafeHttpsUrl(rawUrl: unknown): string | null {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        return null;
    }
    try {
        const parsed = new URL(rawUrl.trim());
        if (parsed.protocol !== "https:") {
            return null;
        }
        const host = parsed.hostname.toLowerCase();
        if (
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "0.0.0.0" ||
            host === "::1" ||
            host.startsWith("10.") ||
            host.startsWith("192.168.") ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
        ) {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

export const travelAggregateAction: Action = {
    name: "AURA_TRAVEL_AGGREGATE",
    similes: [
        "FETCH_TRAVEL_DATA",
        "AGGREGATE_FLIGHTS_HOTELS",
        "SABRE_TRAVEL_LOOKUP",
        "GET_TRAVEL_ITINERARY"
    ],
    description:
        "Queries the AURA M2M Gateway to aggregate decentralized travel routes and Sabre data lines.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.getSetting("WALLET_PUBLIC_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const rawPrompt = typeof message.content?.text === "string" ? message.content.text.trim() : "";
        if (!rawPrompt) {
            if (callback) {
                callback({ text: "Travel query prompt cannot be empty." });
            }
            return false;
        }
        if (rawPrompt.length > MAX_PROMPT_LENGTH) {
            if (callback) {
                callback({
                    text: `Travel query exceeds maximum length of ${MAX_PROMPT_LENGTH} characters.`
                });
            }
            return false;
        }

        const baseUrl = getGatewayBaseUrl(runtime);
        const agentWallet = runtime.getSetting("WALLET_PUBLIC_KEY");

        try {
            const response = await fetch(`${baseUrl}/api/public/v1/travel/aggregate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: rawPrompt,
                    agentWallet
                })
            });

            if (response.status === 402) {
                const paymentMetadata = response.headers.get("x-402-payment-required");
                if (callback) {
                    callback({
                        text: "AURA Gateway requested M2M payment of 0.010 USDC on Base. Processing settlement...",
                        content: { error: "402_PAYMENT_REQUIRED", metadata: paymentMetadata }
                    });
                }
                return false;
            }

            if (!response.ok) {
                if (callback) {
                    callback({
                        text: `AURA Travel Gateway returned HTTP ${response.status}: ${response.statusText}`
                    });
                }
                return false;
            }

            const data = await response.json();
            if (callback) {
                callback({
                    text: `AURA Travel Data Retrieved: ${JSON.stringify(data)}`
                });
            }
            return true;
        } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : "Unknown network error";
            if (callback) {
                callback({
                    text: `AURA Travel Gateway request failed: ${reason}`
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Aggregate travel options from NYC to London for next week." }
            },
            {
                agent: "{{user2}}",
                content: {
                    text: "Querying the AURA M2M Gateway for travel options...",
                    action: "AURA_TRAVEL_AGGREGATE"
                }
            }
        ]
    ]
};

export const visionProcessAction: Action = {
    name: "AURA_VISION_PROCESS",
    similes: [
        "ANALYZE_IMAGE_FRAME",
        "PROCESS_AURAVISION",
        "IMAGE_AI_METADATA",
        "RUN_VISION_GATEWAY"
    ],
    description:
        "Sends image frames to AuraVision AI engine via the M2M gateway for analytical processing.",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        return !!runtime.getSetting("WALLET_PUBLIC_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        const candidateUrl = message.content?.attachments?.[0]?.url || options?.imageUrl;
        const safeFrameUrl = validateSafeHttpsUrl(candidateUrl);

        if (!safeFrameUrl) {
            if (callback) {
                callback({
                    text: "Invalid or missing image URL. Only public HTTPS URLs are permitted for AuraVision."
                });
            }
            return false;
        }

        const baseUrl = getGatewayBaseUrl(runtime);
        const agentWallet = runtime.getSetting("WALLET_PUBLIC_KEY");

        try {
            const response = await fetch(`${baseUrl}/api/public/v1/vision/process-frame`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    frameUrl: safeFrameUrl,
                    agentWallet
                })
            });

            if (response.status === 402) {
                const paymentMetadata = response.headers.get("x-402-payment-required");
                if (callback) {
                    callback({
                        text: "AuraVision endpoint requires a 0.010 USDC M2M stream settlement.",
                        content: { error: "402_PAYMENT_REQUIRED", metadata: paymentMetadata }
                    });
                }
                return false;
            }

            if (!response.ok) {
                if (callback) {
                    callback({
                        text: `AuraVision Gateway returned HTTP ${response.status}: ${response.statusText}`
                    });
                }
                return false;
            }

            const data = await response.json();
            if (callback) {
                callback({
                    text: `AuraVision Processing Complete: ${JSON.stringify(data)}`
                });
            }
            return true;
        } catch (error: unknown) {
            const reason = error instanceof Error ? error.message : "Unknown network error";
            if (callback) {
                callback({
                    text: `AuraVision Gateway request failed: ${reason}`
                });
            }
            return false;
        }
    },
    examples: [
        [
            { user: "{{user1}}", content: { text: "Process this camera frame with AuraVision AI." } },
            {
                agent: "{{user2}}",
                content: {
                    text: "Routing image assets to AuraVision via AURA M2M Gateway...",
                    action: "AURA_VISION_PROCESS"
                }
            }
        ]
    ]
};
