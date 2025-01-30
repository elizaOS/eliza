import { ethers } from 'ethers';
import {
    Action,
    composeContext,
    generateObjectDeprecated,
    HandlerCallback,
    ModelClass,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { LIT_NETWORK, LIT_ABILITY } from '@lit-protocol/constants';
import { ERC20Transfer } from "./tool";
import { litWalletTransferTemplate } from "../../../templates";
import { ERC20TransferPolicy } from './policy';
import { IPFS_CIDS } from './ipfs';
import LitJsSdk from '@lit-protocol/lit-node-client';
import {
    LitActionResource,
    createSiweMessage,
    generateAuthSig,
} from "@lit-protocol/auth-helpers";

const buildLitWalletTransferDetails = async (
    state: State,
    runtime: IAgentRuntime
): Promise<{
    pkpEthAddress: string;
    rpcUrl: string;
    chainId: string;
    tokenIn: string;
    recipientAddress: string;
    amountIn: string;
}> => {
    const context = composeContext({
        state,
        template: litWalletTransferTemplate,
    });

    const transferDetails = (await generateObjectDeprecated({
        runtime,
        context,
        modelClass: ModelClass.SMALL,
    })) as {
        pkpEthAddress: string;
        rpcUrl: string;
        chainId: number;
        tokenIn: string;
        recipientAddress: string;
        amountIn: string;
    };

    return {
        ...transferDetails,
        chainId: transferDetails.chainId.toString()
    };
};

export const WALLET_TRANSFER_LIT_ACTION: Action = {
    name: "lit-wallet-transfer",
    similes: ["Lit Wallet Transfer", "Lit Protocol Transfer", "Transfer tokens"],
    description: "This interacts with Lit Protocol to execute a wallet transfer using the ERC20Transfer tool",
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
            const transferDetails = await buildLitWalletTransferDetails(state, runtime);
            
            // Get the appropriate tool for the network
            const tool = ERC20Transfer[LIT_NETWORK.DatilDev];
            
            // Validate the parameters
            const validationResult = tool.parameters.validate(transferDetails);
            if (validationResult !== true) {
                const errors = validationResult.map(err => `${err.param}: ${err.error}`).join(', ');
                throw new Error(`Invalid parameters: ${errors}`);
            }

            // Create and validate policy
            const policy = {
                type: "ERC20Transfer" as const,
                version: ERC20TransferPolicy.version,
                erc20Decimals: "18",
                maxAmount: transferDetails.amountIn,
                allowedTokens: [transferDetails.tokenIn],
                allowedRecipients: [transferDetails.recipientAddress]
            };

            // Validate policy against schema
            ERC20TransferPolicy.schema.parse(policy);

            // Encode policy for execution
            const encodedPolicy = ERC20TransferPolicy.encode(policy);

            // Get IPFS CID for the network
            const ipfsCid = IPFS_CIDS['datil-dev'].tool;

            // Initialize Lit client
            const litNodeClient = new LitJsSdk.LitNodeClient({
                alertWhenUnauthorized: false,
                litNetwork: LIT_NETWORK.DatilDev,
                debug: false,
            });
            await litNodeClient.connect();

            // Get wallet from private key
            const wallet = new ethers.Wallet(runtime.getSetting("EVM_PRIVATE_KEY"));

            // Get session signatures
            const sessionSigs = await litNodeClient.getSessionSigs({
                chain: "ethereum",
                expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
                resourceAbilityRequests: [
                    {
                        resource: new LitActionResource("*"),
                        ability: LIT_ABILITY.LitActionExecution,
                    },
                ],
                authNeededCallback: async ({ uri, expiration, resourceAbilityRequests }) => {
                    const toSign = await createSiweMessage({
                        uri,
                        expiration,
                        resources: resourceAbilityRequests,
                        walletAddress: wallet.address,
                        nonce: await litNodeClient.getLatestBlockhash(),
                        litNodeClient,
                    });

                    return await generateAuthSig({
                        signer: wallet,
                        toSign,
                    });
                },
            });
            
            // Execute the Lit Action
            const response = await litNodeClient.executeJs({
                sessionSigs,
                ipfsId: ipfsCid,
                jsParams: {
                    params: {
                        ...transferDetails,
                        encodedPolicy
                    }
                },
            });

            console.log("ERC20Transfer Response:", response);

            if (callback) {
                callback({
                    text: `Token transfer executed successfully. Response: ${JSON.stringify(response)}`,
                    content: {
                        success: true,
                        response: response,
                    },
                });
            }

            return true;

        } catch (error) {
            console.error("Error in ERC20Transfer handler:", error);

            if (callback) {
                callback({
                    text: `Error executing token transfer: ${error.message}`,
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
                content: { text: "please attempt a lit wallet transfer pkp addy: 0xc8BB61FB32cbfDc0534136798099709d779086b4 rpc: https://base-sepolia-rpc.publicnode.com chain ID 84532 token address 0x00cdfea7e11187BEB4a0CE835fea1745b124B26e sending 1 token to 0xDFdC570ec0586D5c00735a2277c21Dcc254B3917" },
            },
            {
                user: "{{user2}}",
                content: { text: "Executing ERC20 token transfer", action: "WALLET_TRANSFER_LIT_ACTION" },
            },
        ],
    ],
};
