import type { Action } from "@elizaos/core";
import { verifyAndAttestOnChain } from "../dcap.js";
import { getQuote } from "../quote.js";
import { DCAPMode } from "../types.js";
import {
    getDCAPMode,
    getTEEMode,
    hasPrivateKey,
    hasTEEMode,
} from "../utils.js";

export const dcapOnChainVerifyAction: Action = {
    name: "DCAP_ON_CHAIN",
    description:
        "This plugin is used to generate DCAP attestation and verify it on-chain. The user can also use the keyword DCAP_ON_CHAIN to trigger this action.",
    similes: [
        "DCAP",
        "DCAP_ATTESTATION",
        "DCAP_TEE",
        "DCAP_SGX",
        "DCAP_TDX",
        "VERIFY_ATTESTATION",
        "VERIFY_DCAP",
        "DCAP_VERIFICATION",
        "ATTESTATION",
        "GENERATE_ATTESTATION",
    ],
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate a DCAP attestation and verify it on-chain",
                    action: "DCAP_ON_CHAIN",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Of course, hanlding it now...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Verify the DCAP attestation on-chain" },
                action: "DCAP_ON_CHAIN",
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Of course, hanlding it now...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "DCAP_ON_CHAIN" },
                action: "DCAP_ON_CHAIN",
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Of course, hanlding it now...",
                },
            },
        ],
    ],
    async validate(runtime, message) {
        if (!hasPrivateKey(runtime)) return false;
        const mode = getDCAPMode(runtime);
        if (!mode) return false;
        if (mode === DCAPMode.PLUGIN_TEE) return hasTEEMode(runtime);
        return true;
    },
    async handler(runtime, message, state, options, callback) {
        const { agentId } = runtime;
        const { userId, roomId, content } = message;
        const quote = await getQuote(
            // Attestation will be generated based on the message info
            JSON.stringify({
                agentId,
                timestamp: Date.now(),
                message: { userId, roomId, content: content.text },
            }),
            getDCAPMode(runtime),
            getTEEMode(runtime)
        );

        const reply = (text: string) =>
            callback({
                text,
                // source: quote,
                action: "DCAP_ON_CHAIN",
            });
        try {
            const tx = await verifyAndAttestOnChain(
                runtime.getSetting("EVM_PRIVATE_KEY")!,
                quote
            );
            reply("Verified! Transaction hash: " + tx.hash);
            return true;
        } catch (e) {
            reply(e instanceof Error ? e.message : "Attestation failed");
            return false;
        }
    },
    suppressInitialMessage: true,
};
