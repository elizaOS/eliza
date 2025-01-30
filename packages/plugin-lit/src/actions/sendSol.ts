import {
    Action,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
    Content,
} from "@elizaos/core";
import { LitNodeClient } from "@lit-protocol/lit-node-client";
import { LIT_ABILITY } from "@lit-protocol/constants";
import { LitActionResource } from "@lit-protocol/auth-helpers";
import { EthWalletProvider } from "@lit-protocol/lit-auth-client";
import { api } from "@lit-protocol/wrapped-keys";
import * as web3 from "@solana/web3.js";
import * as ethers from "ethers";
import { LitConfigManager } from "../config/configManager";
import { composeContext, generateObject, ModelClass } from "@elizaos/core";
import { z } from "zod";
import { sendUsdcSchema } from "./sendUSDC";

const { importPrivateKey, signTransactionWithEncryptedKey } = api;

interface LitState {
    nodeClient: LitNodeClient;
    evmWallet?: ethers.Wallet;
    pkp?: {
        publicKey: string;
        ethAddress: string;
        solanaAddress?: string;
    };
    capacityCredit?: {
        tokenId: string;
    };
    wrappedKeyId?: string;
}

// Add template for content extraction
const sendSolTemplate = `Respond with a JSON markdown block containing only the extracted values. Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "amount": "0.1",
    "to": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
}
\`\`\`

{{recentMessages}}

Given the recent messages, extract the following information about the SOL transfer:
- amount (the amount of SOL to send)
- to (the destination address)

Respond with a JSON markdown block containing only the extracted values.`;

// Define the schema type
const sendSolSchema = z.object({
    amount: z.string().nullable(),
    to: z.string().nullable()
});

// Add type guard function
function isSendSolContent(content: Content): content is SendSolContent {
    return (
        (typeof content.amount === "string" || content.amount === null) &&
        (typeof content.to === "string" || content.to === null)
    );
}

interface SendSolContent extends Content {
    amount: string | null;
    to: string | null;
}

export const sendSol: Action = {
    name: "SEND_SOL",
    description: "Sends SOL to an address using Lit Wrapped Keys",
    similes: [
        "send sol",
        "send * sol to *",
        "send solana",
        "send * SOL to *",
        "transfer * sol to *",
        "transfer * SOL to *",
    ],
    validate: async (_runtime: IAgentRuntime) => true,
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<boolean> => {
        console.log("SEND_SOL handler started");
        try {
            // Initialize or update state
            let currentState: State;
            if (!state) {
                currentState = (await runtime.composeState(message)) as State;
            } else {
                currentState = await runtime.updateRecentMessageState(state);
            }

            // Compose context and generate content
            const sendSolContext = composeContext({
                state: currentState,
                template: sendSolTemplate,
            });

            // Generate content with the schema
            // Generate content with the schema
            const content = await generateObject({
                runtime,
                context: sendSolContext,
                schema: sendSolSchema as any,
                modelClass: ModelClass.LARGE,
            });

            const sendSolContent = content.object as SendSolContent;

            // Validate content
            if (!isSendSolContent(sendSolContent)) {
                console.error("Invalid content for SEND_SOL action.");
                callback?.({
                    text: "Unable to process SOL transfer request. Invalid content provided.",
                    content: { error: "Invalid send SOL content" }
                });
                return false;
            }

            if (!sendSolContent.amount) {
                console.log("Amount is not provided, skipping transfer");
                callback?.({ text: "The amount must be provided" });
                return false;
            }

            if (!sendSolContent.to) {
                console.log("Destination address is not provided, skipping transfer");
                callback?.({ text: "The destination address must be provided" });
                return false;
            }

            // Validate Lit environment
            const litState = (state.lit || {}) as LitState;
            if (!litState.nodeClient || !litState.pkp || !litState.evmWallet) {
                throw new Error("Lit environment not fully initialized");
            }

            // Initialize Solana connection
            const connection = new web3.Connection(
                web3.clusterApiUrl("mainnet-beta"),
                "confirmed"
            );

            // Get the private key from config
            const configManager = new LitConfigManager();
            const config = configManager.loadConfig();
            if (!config?.solanaWalletPrivateKey) {
                throw new Error("Solana wallet private key not found in config");
            }

            // Check for existing wrapped key ID in config
            if (config?.wrappedKeyId) {
                litState.wrappedKeyId = config.wrappedKeyId;
            } else {
                // Only create new wrapped key if one doesn't exist
                const ethersSigner = litState.evmWallet;

                console.log("Getting PKP Session Sigs for wrapped key creation...");
                const pkpSessionSigs = await litState.nodeClient.getPkpSessionSigs({
                    pkpPublicKey: litState.pkp.publicKey,
                    authMethods: [
                        await EthWalletProvider.authenticate({
                            signer: ethersSigner,
                            litNodeClient: litState.nodeClient,
                            expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
                        }),
                    ],
                    resourceAbilityRequests: [
                        {
                            resource: new LitActionResource("*"),
                            ability: LIT_ABILITY.LitActionExecution,
                        },
                    ],
                    expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
                });
                console.log("✅ Successfully created PKP Session Sigs:", !!pkpSessionSigs);

                // Decode and import the private key
                const privateKeyBytes = Buffer.from(config.solanaWalletPrivateKey, 'base64');
                const keypair = web3.Keypair.fromSecretKey(privateKeyBytes);

                console.log("Importing Solana private key as wrapped key...");
                const importResponse = await importPrivateKey({
                    pkpSessionSigs,
                    litNodeClient: litState.nodeClient,
                    privateKey: Buffer.from(keypair.secretKey).toString('hex'),
                    publicKey: keypair.publicKey.toBase58(),
                    keyType: "ed25519",
                    memo: "Solana PKP Wallet",
                });
                console.log("✅ Successfully imported Solana private key as wrapped key:", importResponse.id);

                // Save wrapped key ID to both state and config
                litState.wrappedKeyId = importResponse.id;
                configManager.saveConfig({
                    ...config,
                    wrappedKeyId: importResponse.id,
                });
            }

            // Fund the wallet with 2 devnet SOL if needed
            if (!litState.pkp.solanaAddress) {
                throw new Error("Solana address not found in PKP");
            }
            const fromPubkey = new web3.PublicKey(litState.pkp.solanaAddress);
            const toPubkey = new web3.PublicKey(sendSolContent.to);

            console.log("Sending from wallet address:", fromPubkey.toString());

            // Check current balance
            const balance = await connection.getBalance(fromPubkey);
            console.log("Current wallet balance:", balance / web3.LAMPORTS_PER_SOL, "SOL");

            /* DEVNET ONLY: Uncomment this block when using devnet
            if (balance === 0) {
                try {
                    console.log("Wallet empty, requesting 2 SOL airdrop...");
                    const airdropSignature = await connection.requestAirdrop(
                        fromPubkey,
                        2 * web3.LAMPORTS_PER_SOL
                    );
                    const latestBlockhash = await connection.getLatestBlockhash();
                    await connection.confirmTransaction({
                        signature: airdropSignature,
                        blockhash: latestBlockhash.blockhash,
                        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                    });
                    console.log("Airdrop successful");
                } catch (error) {
                    console.error("Airdrop failed:", error);
                    throw new Error("Failed to fund wallet with devnet SOL");
                }
            } else {
                console.log("Wallet already has sufficient balance, skipping airdrop");
            }
            */

            // Mainnet balance check (comment this out if using devnet airdrop logic)
            if (balance === 0) {
                throw new Error("Wallet has insufficient balance");
            }

            const transaction = new web3.Transaction().add(
                web3.SystemProgram.transfer({
                    fromPubkey,
                    toPubkey,
                    lamports: web3.LAMPORTS_PER_SOL * Number.parseFloat(sendSolContent.amount),
                })
            );

            // Get recent blockhash
            const { blockhash } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = fromPubkey;

            // Get session sigs for transaction signing
            const pkpSessionSigs = await litState.nodeClient.getPkpSessionSigs({
                pkpPublicKey: litState.pkp.publicKey,
                authMethods: [
                    await EthWalletProvider.authenticate({
                        signer: litState.evmWallet,
                        litNodeClient: litState.nodeClient,
                        expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
                    }),
                ],
                resourceAbilityRequests: [
                    {
                        resource: new LitActionResource("*"),
                        ability: LIT_ABILITY.LitActionExecution,
                    },
                ],
                expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(),
            });

            // Sign and send transaction
            // For devnet: change 'mainnet-beta' to 'devnet'
            if (!litState.wrappedKeyId) {
                throw new Error("Wrapped key ID not found");
            }
            const signedTx = await signTransactionWithEncryptedKey({
                pkpSessionSigs,
                network: "solana",
                id: litState.wrappedKeyId,
                unsignedTransaction: {
                    chain: 'mainnet-beta',
                    serializedTransaction: transaction.serialize({
                        requireAllSignatures: false,
                    }).toString('base64')
                },
                broadcast: true,
                litNodeClient: litState.nodeClient,
            });

            callback?.({
                text: `Successfully sent ${sendSolContent.amount} SOL to ${sendSolContent.to}. Transaction signature: ${signedTx}`,
                content: {
                    success: true,
                    signature: signedTx,
                    amount: sendSolContent.amount,
                    to: sendSolContent.to,
                },
            });

            return true;
        } catch (error) {
            console.error("Error in sendSol:", error);
            callback?.({
                text: `Failed to send SOL: ${error instanceof Error ? error.message : "Unknown error"
                    }`,
                content: {
                    success: false,
                    error: error instanceof Error ? error.message : "Unknown error",
                },
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Send 0.1 SOL to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
                },
            },
            {
                user: "{{user2}}",
                content: {
                    text: "Successfully sent SOL",
                },
            },
        ],
    ],
};