import { ethers } from 'ethers'; // Import ethers
import {
    Action,
    type IAgentRuntime,
    type Memory,
    type State,
    HandlerCallback,
} from "@elizaos/core";
import LitJsSdk from '@lit-protocol/lit-node-client';
import { LIT_NETWORK, LIT_ABILITY } from '@lit-protocol/constants';
import {
  LitActionResource,
  createSiweMessage,
  generateAuthSig,
} from "@lit-protocol/auth-helpers";
import { litActionCode } from "./helloLitAction";

export const HELLO_LIT_ACTION: Action = {
    name: "hello",
    similes: ["Hello World", "Basic Lit Action"],
    description: "This interacts with Lit",
    validate: async (runtime: IAgentRuntime, message: Memory) => {
        const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
        return typeof privateKey === "string" && privateKey.startsWith("0x");
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options?: any,
        callback?: HandlerCallback
    ) => {
        try {
            const litNodeClient = new LitJsSdk.LitNodeClient({
                alertWhenUnauthorized: false,
                litNetwork: LIT_NETWORK.DatilDev,
                debug: false,
            });

            await litNodeClient.connect();
            console.log("Connected to Lit Network");

            const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
            const ethersWallet = new ethers.Wallet(privateKey);
            console.log("Wallet Address:", ethersWallet.address);

            const sessionSignatures = await litNodeClient.getSessionSigs({
                chain: "ethereum",
                expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
                resourceAbilityRequests: [
                    {
                        resource: new LitActionResource("*"),
                        ability: LIT_ABILITY.LitActionExecution,
                    },
                ],
                authNeededCallback: async ({
                    uri,
                    expiration,
                    resourceAbilityRequests,
                }) => {
                    const toSign = await createSiweMessage({
                        uri,
                        expiration,
                        resources: resourceAbilityRequests,
                        walletAddress: ethersWallet.address,
                        nonce: await litNodeClient.getLatestBlockhash(),
                        litNodeClient,
                    });
    
                    return await generateAuthSig({
                        signer: ethersWallet,
                        toSign,
                    });
                },
            });
            
            // Execute the Lit Action
            const response = await litNodeClient.executeJs({
                sessionSigs: sessionSignatures,
                code: litActionCode,
                jsParams: {
                    magicNumber: 43, // Example parameter
                },
            });

            console.log("Lit Action Response:", response);

            // Use the callback (if provided) to send the response to the chat UI
            if (callback) {
                callback({
                    text: `Lit Action executed successfully. Response: ${JSON.stringify(response)}`,
                    content: {
                        success: true,
                        response: response,
                    },
                });
            }

            return true;

        } catch (error) {
            console.error("Error in lit action handler:", error);

            // Use the callback (if provided) to send the error message to the chat UI
            if (callback) {
                callback({
                    text: `Error executing Lit Action: ${error.message}`,
                    content: {
                        error: error.message,
                    },
                });
            }

            throw error;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "I'd like to deploy a lit action" },
            },
            {
                user: "{{user2}}",
                content: { text: "Deploying a basic Lit Action", action: "HELLO_LIT_ACTION" },
            },
        ],
    ],
};
