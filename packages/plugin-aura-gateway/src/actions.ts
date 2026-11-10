import { Action, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import axios from "axios";

const AURA_BASE_URL = "https://auragateway.app";

// Action for Travel Aggregation
export const travelAggregateAction: Action = {
    name: "AURA_TRAVEL_AGGREGATE",
    similes: [
        "FETCH_TRAVEL_DATA",
        "AGGREGATE_FLIGHTS_HOTELS",
        "SABRE_TRAVEL_LOOKUP",
        "GET_TRAVEL_ITINERARY"
    ],
    description: "Queries the AURA M2M Gateway to aggregate decentralized travel routes and Sabre data lines.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return !!runtime.getSetting("WALLET_PRIVATE_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            const response = await axios.post(`${AURA_BASE_URL}/travel/aggregate`, {
                prompt: message.content.text,
                agentWallet: runtime.getSetting("WALLET_PUBLIC_KEY")
            }, {
                headers: { "Content-Type": "application/json" }
            });

            if (callback) {
                callback({
                    text: `AURA Travel Data Retrieved: ${JSON.stringify(response.data)}`
                });
            }
            return true;
        } catch (error: any) {
            if (error.response && error.response.status === 402) {
                const paymentMetadata = error.response.headers["x-402-payment-required"];
                if (callback) {
                    callback({
                        text: `AURA Gateway requested M2M payment of 0.010 USDC on Base. Processing settlement...`,
                        content: { error: "402_PAYMENT_REQUIRED", metadata: paymentMetadata }
                    });
                }
                return false;
            }
            return false;
        }
    },
    examples: [
        [
            { user: "{{user1}}", content: { text: "Aggregate travel options from NYC to London for next week." } },
            { agent: "{{user2}}", content: { text: "Querying the AURA M2M Gateway for travel options...", action: "AURA_TRAVEL_AGGREGATE" } }
        ]
    ]
};

// Action for Vision Frame Processing
export const visionProcessAction: Action = {
    name: "AURA_VISION_PROCESS",
    similes: [
        "ANALYZE_IMAGE_FRAME",
        "PROCESS_AURAVISION",
        "IMAGE_AI_METADATA",
        "RUN_VISION_GATEWAY"
    ],
    description: "Sends image frames to AuraVision AI engine via the M2M gateway for analytical processing.",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        return !!runtime.getSetting("WALLET_PRIVATE_KEY");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ): Promise<boolean> => {
        try {
            const imageUrl = message.content.attachments?.[0]?.url || options.imageUrl;
            
            if (!imageUrl) {
                if (callback) callback({ text: "No image found to process with AuraVision." });
                return false;
            }

            const response = await axios.post(`${AURA_BASE_URL}/vision/process-frame`, {
                frameUrl: imageUrl,
                agentWallet: runtime.getSetting("WALLET_PUBLIC_KEY")
            }, {
                headers: { "Content-Type": "application/json" }
            });

            if (callback) {
                callback({
                    text: `AuraVision Processing Complete: ${JSON.stringify(response.data)}`
                });
            }
            return true;
        } catch (error: any) {
            if (error.response && error.response.status === 402) {
                if (callback) callback({ text: "AuraVision endpoint requires a 0.010 USDC M2M stream settlement." });
            }
            return false;
        }
    },
    examples: [
        [
            { user: "{{user1}}", content: { text: "Process this camera frame with AuraVision AI." } },
            { agent: "{{user2}}", content: { text: "Routing image assets to AuraVision via AURA M2M Gateway...", action: "AURA_VISION_PROCESS" } }
        ]
    ]
};
