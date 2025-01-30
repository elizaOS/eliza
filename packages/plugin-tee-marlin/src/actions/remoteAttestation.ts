import type { IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";

export const remoteAttestationAction = {
    name: "REMOTE_ATTESTATION",
    similes: ["REMOTE_ATTESTATION", "TEE_REMOTE_ATTESTATION", "TEE_ATTESTATION"],
    description: "Generate a remote attestation to prove that the agent is running in a TEE",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: Record<string, unknown>,  // Replaced any with Record<string, unknown>
        callback: HandlerCallback,
    ) => {
        try {
            const endpoint = runtime.getSetting("TEE_MARLIN_ATTESTATION_ENDPOINT") ?? "http://127.0.0.1:1350";
            const response = await fetch(`${endpoint}/attestation/hex`);
            callback({
                text: `Here you go - ${await response.text()}`,
                action: "NONE",
            });
            return true;
        } catch (error) {
            console.error("Failed to fetch remote attestation: ", error);
            return false;
        }
    },
    validate: async (_runtime: IAgentRuntime) => {
        return true;
    },
    examples: [
        [
            {
                user: "user",
                content: {
                    text: "Attest yourself",
                    action: "REMOTE_ATTESTATION",
                },
            },
            {
                user: "user",
                content: {
                    text: "Generate a remote attestation",
                    action: "REMOTE_ATTESTATION",
                },
            },
        ],
    ],
};
