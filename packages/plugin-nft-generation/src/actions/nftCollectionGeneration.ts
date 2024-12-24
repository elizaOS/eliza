import {
    Action,
    elizaLogger,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    State,
} from "@elizaos/core";
import { createCollection } from "../handlers/createCollection.ts";

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
        state: State,
        options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        try {
            elizaLogger.log("Composing state for message:", message);
            const collectionAddressRes = await createCollection({
                runtime,
                collectionName: runtime.character.name,
            });
            elizaLogger.log("Collection Info:", collectionAddressRes);
            if (callback) {
                callback({
                    text: `Congratulations to you! 🎉🎉🎉 \nCollection Link : ${collectionAddressRes.link}\n Address: ${collectionAddressRes.address}`, //caption.description,
                    attachments: [],
                });
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
                content: { text: "Generate a collection" },
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
                content: { text: "Generate a collection using {{agentName}}" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "We've successfully created a collection.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Create a collection using {{agentName}}" },
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
                content: { text: "Build a Collection" },
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
                content: { text: "Assemble a collection with {{agentName}}" },
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
                content: { text: "Make a collection" },
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
                    text: "Could you create a new collection for my photos?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've created a new collection for your photos.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I need a collection for organizing my music",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your music collection has been generated.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Please set up a collection for my documents",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've set up a new collection for your documents.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Start a new collection for me" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your new collection has been created.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I'd like to make a collection of my recipes",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've generated a collection for your recipes.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you generate a collection for my artwork?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your artwork collection has been generated.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Initialize a new collection please" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've initialized a new collection for you.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Create a collection for my travel memories" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your travel memories collection has been created.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Would you make a collection for my projects?",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "I've made a collection for your projects.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "Set up a collection for my bookmarks" },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "Your bookmarks collection has been set up.",
                    action: "GENERATE_COLLECTION",
                },
            },
        ],
    ],
} as Action;

export default nftCollectionGeneration;
