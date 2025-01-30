import {
    type Action,
    composeContext,
    elizaLogger,
    generateObject,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
} from "@elizaos/core";
import { createNFT } from "../handlers/createNFT.ts";
import { verifyNFT } from "../handlers/verifyNFT.ts";
import { sleep } from "../index.ts";
import WalletSolana from "../provider/wallet/walletSolana.ts";
import { PublicKey } from "@solana/web3.js";
import { mintNFTTemplate } from "../templates.ts";
import { type MintNFTContent, MintNFTSchema } from "../types.ts";
import * as viemChains from "viem/chains";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mintNFT } from "../utils/deployEVMContract.ts";
const _SupportedChainList = Object.keys(viemChains) as Array<
    keyof typeof viemChains
>;


function isMintNFTContent(content: any): content is MintNFTContent {
    return typeof content.collectionAddress === "string" && typeof content.collectionAddress === "string";
}

const mintNFTAction: Action = {
    name: "MINT_NFT",
    similes: [
        "NFT_MINTING",
        "NFT_CREATION",
        "CREATE_NFT",
        "GENERATE_NFT",
        "MINT_TOKEN",
        "CREATE_TOKEN",
        "MAKE_NFT",
        "TOKEN_GENERATION",
    ],
    description: "Mint NFTs for the collection",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const awsAccessKeyIdOk = !!runtime.getSetting("AWS_ACCESS_KEY_ID");
        const awsSecretAccessKeyOk = !!runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY"
        );
        const awsRegionOk = !!runtime.getSetting("AWS_REGION");
        const awsS3BucketOk = !!runtime.getSetting("AWS_S3_BUCKET");
        const solanaAdminPrivateKeyOk = !!runtime.getSetting(
            "SOLANA_ADMIN_PRIVATE_KEY"
        );
        const solanaAdminPublicKeyOk = !!runtime.getSetting(
            "SOLANA_ADMIN_PUBLIC_KEY"
        );

        return (
            awsAccessKeyIdOk ||
            awsSecretAccessKeyOk ||
            awsRegionOk ||
            awsS3BucketOk ||
            solanaAdminPrivateKeyOk ||
            solanaAdminPublicKeyOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        try {
            elizaLogger.log("Composing state for message:", message);

            // if (!state) {
            //     state = (await runtime.composeState(message)) as State;
            // } else {
            //     state = await runtime.updateRecentMessageState(state);
            // }

            let currentState: State;
            if (!state) {
                currentState = (await runtime.composeState(message)) as State;
            } else {
                currentState = await runtime.updateRecentMessageState(state);
            }
            
            const context = composeContext({
                state: currentState,
                template: mintNFTTemplate,
            });

            const chains = _SupportedChainList;

            const supportedChains: (
                | (typeof chains)[number]
                | "solana"
                | null
                )[] = [...chains, "solana", null];
            const contextWithChains = context.replace(
                "SUPPORTED_CHAINS",
                supportedChains
                    .map((item) => (item ? `"${item}"` : item))
                    .join("|")
            );

            const res = await generateObject({
                runtime,
                context: contextWithChains,
                modelClass: ModelClass.LARGE,
                schema: MintNFTSchema,
            });
            const content = res.object as {
                collectionAddress: string,
                chainName: (typeof supportedChains)[number];
            };

            elizaLogger.log("Generate Object:", content);

            if (!isMintNFTContent(content)) {
                elizaLogger.error("Invalid content for MINT_NFT action.");
                if (callback) {
                    callback({
                        text: "Unable to process mint request. Invalid content provided.",
                        content: { error: "Invalid mint content" },
                    });
                }
                return false;
            }

            if (content?.chainName === "solana") {
                const publicKey = runtime.getSetting("SOLANA_PUBLIC_KEY");
                const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");

                const wallet = new WalletSolana(
                    new PublicKey(publicKey),
                    privateKey
                );

                const collectionInfo = await wallet.fetchDigitalAsset(
                    content.collectionAddress
                );
                elizaLogger.log("Collection Info", collectionInfo);
                const metadata = collectionInfo.metadata;
                if (metadata.collection?.["value"]) {
                    callback({
                        text: `Unable to process mint request. Invalid collection address ${content.collectionAddress}.`,
                        content: { error: "Invalid collection address." },
                    });
                    return false;
                }
                if (metadata) {
                    const nftRes = await createNFT({
                        runtime,
                        collectionName: metadata.name,
                        collectionAddress: content.collectionAddress,
                        collectionAdminPublicKey: metadata.updateAuthority,
                        collectionFee: metadata.sellerFeeBasisPoints,
                        tokenId: 1,
                    });

                    elizaLogger.log("NFT Address:", nftRes);

                    if (nftRes) {
                        callback({
                            text: `Congratulations to you! 🎉🎉🎉 \nCollection Address: ${content.collectionAddress}\n NFT Address: ${nftRes.address}\n NFT Link: ${nftRes.link}`, //caption.description,
                            attachments: [],
                        });
                        await sleep(15000);
                        await verifyNFT({
                            runtime,
                            collectionAddress: content.collectionAddress,
                            NFTAddress: nftRes.address,
                        });
                    } else {
                        callback({
                            text: `Mint NFT Error in ${content.collectionAddress}.`,
                            content: { error: "Mint NFT Error." },
                        });
                        return false;
                    }
                } else {
                    callback({
                        text: "Unable to process mint request. Invalid collection address.",
                        content: { error: "Invalid collection address." },
                    });
                    return false;
                }
            } else if (chains.indexOf(content.chainName)) {
                const privateKey = runtime.getSetting(
                    "WALLET_PRIVATE_KEY"
                ) as `0x${string}`;
                if (!privateKey) return null;
                const rpcUrl =
                    viemChains[content.chainName].rpcUrls.default.http[0];
                const chain = viemChains[content.chainName]; // 替换为目标链
                const provider = http(rpcUrl);
                const account = privateKeyToAccount(privateKey);
                const walletClient = createWalletClient({
                    account,
                    chain: chain,
                    transport: provider,
                });

                const publicClient = createPublicClient({
                    chain: chain,
                    transport: provider,
                });
                await mintNFT({
                    walletClient,
                    publicClient,
                    contractAddress: content.collectionAddress,
                    abi: [
                        {
                            "inputs": [
                                {
                                    "internalType": "address",
                                    "name": "_to",
                                    "type": "address"
                                }
                            ],
                            "name": "mint",
                            "outputs": [],
                            "stateMutability": "nonpayable",
                            "type": "function"
                        }
                    ],
                    recipient: account.address,
                })
                if (callback) {
                    callback({
                        text: `Congratulations to you! 🎉🎉🎉 \nCollection Address: ${content.collectionAddress}\n `, //caption.description,
                        attachments: [],
                    });
                }
            }
            return [];
        } catch (e: unknown) {
            elizaLogger.log(e);
            throw e;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "mint nft for collection: D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've minted a new NFT in your specified collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Could you create an NFT in collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Successfully minted your NFT in the specified collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please mint a new token in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your NFT has been minted in the collection successfully on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate NFT for D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've generated and minted your NFT in the collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to mint an NFT in collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your NFT has been successfully minted in the collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a new NFT token in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The NFT has been created in your specified collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Issue an NFT for collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've issued your NFT in the requested collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Make a new NFT in D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your new NFT has been minted in the collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you mint an NFT for D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS collection on Solana?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've completed minting your NFT in the collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Add a new NFT to collection D8j4ubQ3MKwmAqiJw83qT7KQNKjhsuoC7zJJdJa5BkvS on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "A new NFT has been added to your collection on Solana.",
                    action: "MINT_NFT",
                },
            },
        ],
    ],
} as Action;

export default mintNFTAction;
