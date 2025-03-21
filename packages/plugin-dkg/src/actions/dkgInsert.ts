import dotenv from "dotenv";
dotenv.config();
import {
    IAgentRuntime,
    Memory,
    State,
    elizaLogger,
    ModelClass,
    HandlerCallback,
    ActionExample,
    type Action,
    composeContext,
    generateText,
} from "@elizaos/core";
import { DKG_EXPLORER_LINKS } from "../constants.ts";
import { createDKGMemoryTemplate } from "../templates.ts";
// @ts-ignore
import DKG from "dkg.js";
import { DKGMemorySchema, isDKGMemoryContent } from "../types.ts";

let DkgClient: any = null;

export const dkgInsert: Action = {
    name: "INSERT_MEMORY_ACTION",
    similes: ["NO_ACTION", "NO_RESPONSE", "NO_REACTION", "NONE"], // we want to always run this action
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        const requiredEnvVars = [
            "DKG_ENVIRONMENT",
            "DKG_HOSTNAME",
            "DKG_PORT",
            "DKG_BLOCKCHAIN_NAME",
            "DKG_PUBLIC_KEY",
            "DKG_PRIVATE_KEY",
        ];

        const missingVars = requiredEnvVars.filter(
            (varName) => !runtime.getSetting(varName),
        );

        if (missingVars.length > 0) {
            elizaLogger.error(
                `Missing required environment variables: ${missingVars.join(", ")}`,
            );
            return false;
        }

        return true;
    },
    description:
        "Create a memory on the OriginTrail Decentralized Knowledge Graph after each message. You should run this action for ALL generic messages EXCEPT when the user asks you about your thoughts on stock, cryptocurrency, token or a financial asset.",
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback,
    ): Promise<boolean> => {
        DkgClient = new DKG({
            environment: runtime.getSetting("DKG_ENVIRONMENT"),
            endpoint: runtime.getSetting("DKG_HOSTNAME"),
            port: runtime.getSetting("DKG_PORT"),
            blockchain: {
                name: runtime.getSetting("DKG_BLOCKCHAIN_NAME"),
                publicKey: runtime.getSetting("DKG_PUBLIC_KEY"),
                privateKey: runtime.getSetting("DKG_PRIVATE_KEY"),
            },
            maxNumberOfRetries: 300,
            frequency: 2,
            contentType: "all",
            nodeApiVersion: "/v1",
        });

        const currentPost = String(state.currentPost);
        elizaLogger.log(`currentPost: ${currentPost}`);

        const userRegex = /From:.*\(@(\w+)\)/;
        let match = currentPost.match(userRegex);
        let twitterUser = "";

        if (match && match[1]) {
            twitterUser = match[1];
            elizaLogger.log(`Extracted user: @${twitterUser}`);
        } else {
            elizaLogger.log("No user mention found or invalid input.");
        }

        const createDKGMemoryContext = composeContext({
            state,
            template: createDKGMemoryTemplate,
        });

        const memoryKnowledgeGraphText = await generateText({
            runtime,
            context: createDKGMemoryContext,
            modelClass: ModelClass.LARGE,
        });

        const jsonMatch = memoryKnowledgeGraphText.match(/\{[\s\S]*\}/);

        let memoryKnowledgeGraph = null;
        if (jsonMatch) {
            try {
                memoryKnowledgeGraph = JSON.parse(jsonMatch[0].trim());
                elizaLogger.log(
                    "Parsed Memory Knowledge Graph:\n",
                    memoryKnowledgeGraph,
                );
            } catch (error) {
                elizaLogger.error("Failed to parse JSON-LD:", error);
            }
        } else {
            elizaLogger.error("No valid JSON-LD object found in the response.");
        }

        let createAssetResult;

        // TODO: also store reply to the KA, aside of the question

        try {
            elizaLogger.log("Publishing message to DKG");

            memoryKnowledgeGraph.author = {
                "@type": "Person",
                "@id": `https://x.com/${twitterUser}`,
                username: twitterUser,
            };

            elizaLogger.log(
                `KA: ${JSON.stringify(memoryKnowledgeGraph, null, 2)}`,
            );

            createAssetResult = await DkgClient.asset.create(
                {
                    public: memoryKnowledgeGraph,
                },
                { epochsNum: 12 },
            );

            elizaLogger.log("======================== ASSET CREATED");
            elizaLogger.log(JSON.stringify(createAssetResult));
        } catch (error) {
            elizaLogger.error(
                "Error occurred while publishing message to DKG:",
                error.message,
            );

            if (error.stack) {
                elizaLogger.error("Stack trace:", error.stack);
            }
            if (error.response) {
                elizaLogger.error(
                    "Response data:",
                    JSON.stringify(error.response.data, null, 2),
                );
            }

            if (
                error.message.includes("Unexpected") ||
                error.message.includes("JSON")
            ) {
                elizaLogger.warn(
                    "Detected JSON formatting issue. Attempting to fix...",
                );
                try {
                    const fixedJSON = await generateText({
                        runtime,
                        context: `Fix this malformed JSON-LD and return only the corrected JSON-LD:\n${JSON.stringify(memoryKnowledgeGraph, null, 2)}

                      Make sure to only output the JSON-LD object. DO NOT OUTPUT ANYTHING ELSE, DONT ADD ANY COMMENTS, REMARKS AND DO NOT WRAP IT IN A CODE/JSON BLOCK, JUST THE JSON LD CONTENT WRAPPED IN { }.`,
                        modelClass: ModelClass.LARGE,
                    });

                    elizaLogger.log(
                        `Fixed JSON generated by LLM: ${fixedJSON}. Retrying...`,
                    );

                    createAssetResult = await DkgClient.asset.create(
                        { public: JSON.parse(fixedJSON) },
                        { epochsNum: 12 },
                    );

                    elizaLogger.log(
                        "======================== ASSET CREATED AFTER FIX",
                    );
                    elizaLogger.log(JSON.stringify(createAssetResult));
                } catch (llmError) {
                    elizaLogger.error(
                        "Failed to fix JSON using LLM:",
                        llmError.message,
                    );
                }
            }
        }

        if (createAssetResult.UAL) {
            callback({
                text: `Created a new memory!\n\nRead my mind on @origin_trail Decentralized Knowledge Graph ${DKG_EXPLORER_LINKS[runtime.getSetting("DKG_ENVIRONMENT")]}${createAssetResult.UAL} @${twitterUser}`,
            });
        } else {
            callback({
                text: `Apologies, something went wrong with creating the memory.`,
            });
        }

        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "execute action DKG_INSERT",
                    action: "DKG_INSERT",
                },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "add to dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: { text: "store in dkg", action: "DKG_INSERT" },
            },
            {
                user: "{{user2}}",
                content: { text: "DKG INSERT" },
            },
        ],
    ] as ActionExample[][],
} as Action;
