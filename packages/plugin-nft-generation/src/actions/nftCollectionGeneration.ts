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
import { createCollectionMetadata } from "../handlers/createSolanaCollection.ts";
import { CreateCollectionSchema } from "../types.ts";
import { createCollectionTemplate } from "../templates.ts";
import * as viemChains from "viem/chains";
import WalletSolana from "../provider/wallet/walletSolana.ts";
import { PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
    compileContract,
    deployContract,
    encodeConstructorArguments,
    generateERC721ContractCode,
} from "../utils/deployEVMContract.ts";
import { verifyEVMContract } from "../utils/verifyEVMContract.ts";

const _SupportedChainList = Object.keys(viemChains) as Array<
    keyof typeof viemChains
>;

const nftCollectionGeneration: Action = {
    name: "GENERATE_COLLECTION",
    similes: [
        "COLLECTION_GENERATION",
        "COLLECTION_GEN",
        "CREATE_COLLECTION",
        "MAKE_COLLECTION",
        "GENERATE_COLLECTION",
    ],
    description: "Generate an NFT collection for the message",
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const awsAccessKeyIdOk = !!runtime.getSetting("AWS_ACCESS_KEY_ID");
        const awsSecretAccessKeyOk = !!runtime.getSetting(
            "AWS_SECRET_ACCESS_KEY"
        );
        const awsRegionOk = !!runtime.getSetting("AWS_REGION");
        const awsS3BucketOk = !!runtime.getSetting("AWS_S3_BUCKET");
        const solanaPrivateKeyOk = !!runtime.getSetting("SOLANA_PRIVATE_KEY");
        const solanaPublicKeyOk = !!runtime.getSetting("SOLANA_PUBLIC_KEY");

        return (
            awsAccessKeyIdOk ||
            awsSecretAccessKeyOk ||
            awsRegionOk ||
            awsS3BucketOk ||
            solanaPrivateKeyOk ||
            solanaPublicKeyOk
        );
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        try {
            elizaLogger.log("Composing state for message:", message);

            const state = await runtime.composeState(message);

            // Compose transfer context
            const context = composeContext({
                state,
                template: createCollectionTemplate,
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
                schema: CreateCollectionSchema,
            });

            const content = res.object as {
                chainName: (typeof supportedChains)[number];
            };

            if (content?.chainName === "solana") {
                const collectionInfo = await createCollectionMetadata({
                    runtime,
                    collectionName: runtime.character.name,
                });
                if (!collectionInfo) return null;
                const publicKey = runtime.getSetting("SOLANA_PUBLIC_KEY");
                const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");
                const wallet = new WalletSolana(
                    new PublicKey(publicKey),
                    privateKey
                );

                const collectionAddressRes = await wallet.createCollection({
                    ...collectionInfo,
                });
                elizaLogger.log("Collection Info:", collectionAddressRes);
                if (callback) {
                    callback({
                        text: `Congratulations to you! 🎉🎉🎉 \nCollection Link : ${collectionAddressRes.link}\n Address: ${collectionAddressRes.address}`, //caption.description,
                        attachments: [],
                    });
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

                // const collectionInfo = await createCollectionMetadata({
                //     runtime,
                //     collectionName: runtime.character.name,
                // });

                const contractName = runtime.character.name.replace('.', '_');
                const contractSymbol = `${contractName.toUpperCase()[0]}`;
                const contractMaxSupply = 5000;
                const royalty = 0;
                const params = [
                    contractName,
                    contractSymbol,
                    contractMaxSupply,
                    royalty,
                ];
                const sourceCode = generateERC721ContractCode(contractName);

                const { abi, bytecode, metadata } = compileContract(
                    contractName,
                    sourceCode
                );
                elizaLogger.log("ABI and Bytecode generated.");
                const contractAddress = await deployContract({
                    walletClient,
                    publicClient,
                    abi,
                    bytecode,
                    args: params,
                });
                elizaLogger.log(
                    `Deployed contract address: ${contractAddress}`
                );
                const constructorArgs = encodeConstructorArguments(abi, params);
                const blockExplorers = chain.blockExplorers?.default
                await verifyEVMContract({
                    contractAddress: contractAddress,
                    sourceCode,
                    metadata,
                    constructorArgs,
                    apiEndpoint: (blockExplorers as typeof blockExplorers & { apiUrl?: string })?.apiUrl || `${chain.blockExplorers.default.url}/api`,
                });
                if (callback) {
                    callback({
                        text: `Congratulations to you! 🎉🎉🎉 \nCollection Link : ${chain.blockExplorers.default.url}/address/${contractAddress}\n Address: ${contractAddress}`, //caption.description,
                        attachments: [],
                    });
                }
            }

            return [];
        } catch (e: any) {
            console.log(e);
            throw e;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Generate a collection on Solana" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's the collection you requested.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Generate a collection using {{agentName}} on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "We've successfully created a collection on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a collection using {{agentName}} on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Here's the collection you requested.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Build a Collection on Solana" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been successfully built.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Assemble a collection with {{agentName}} on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been assembled",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Make a collection on Solana" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "The collection has been produced successfully.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Could you create a new collection for my photos on Solana?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've created a new collection for your photos on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I need a collection for organizing my music on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your music collection has been generated on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please set up a collection for my documents on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've set up a new collection for your documents on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Start a new collection for me on Solana" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your new collection has been created on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I'd like to make a collection of my recipes on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've generated a collection for your recipes on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you generate a collection for my artwork on Solana?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your artwork collection has been generated on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Initialize a new collection please on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've initialized a new collection for you on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Create a collection for my travel memories on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your travel memories collection has been created on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Would you make a collection for my projects on Solana?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've made a collection for your projects on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Set up a collection for my bookmarks on Solana",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your bookmarks collection has been set up on Solana.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
    ],
} as Action;

export default nftCollectionGeneration;
