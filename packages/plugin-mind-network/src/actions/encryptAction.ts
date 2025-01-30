import type { Action } from "@elizaos/core";
import { type ActionExample, type Content, type HandlerCallback, type IAgentRuntime, type Memory, ModelClass, type State, elizaLogger, composeContext, generateObject, } from "@elizaos/core";
import { z } from "zod";
import { encrypt } from "mind-randgen-sdk";
import cache from "../utils/cache";

export interface DataContent extends Content {
    numberToEncrypt: number;
}

const dataSchema = z.object({
    numberToEncrypt: z.number()
});

const dataExtractionTemplate = `
Respond with a JSON markdown block containing only the extracted values.
Use null for any values that cannot be determined.

Example response:
\`\`\`json
{
    "numberToEncrypt": 123
}
\`\`\`

{{recentMessages}}

Given the recent messages, find out the number that the user wish to encrypt with FHE.
Respond with a JSON markdown block containing only the extracted values.`;

export const encryptAction: Action = {
    name: "MIND_FHE_ENCRYPT",
    similes: [
        "MIND_ENCRYPT",
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description: "Encrypt a number of user's choice with FHE.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting Mind Network MIND_FHE_ENCRYPT handler...");
        const resolvedState = state
            ? await runtime.updateRecentMessageState(state)
            : (await runtime.composeState(message)) as State;

        const dataContext = composeContext({
            state: resolvedState,
            template: dataExtractionTemplate,
        });
        elizaLogger.log("Data context:", dataContext);
        
        const content = (
            await generateObject({
                runtime,
                context: dataContext,
                modelClass: ModelClass.SMALL,
                schema: dataSchema
            })
        ).object as unknown as DataContent;

        const numToEncrypt = content.numberToEncrypt % 256;


        try {
            const cypherUrl = await encrypt(numToEncrypt);
            cache.latestEncryptedNumber = cypherUrl;
            const reply = `Encryption is successful. Your encrypted number is available: ${cypherUrl}.`
            elizaLogger.success(reply);
            if (callback) {
                callback({
                    text: reply,
                    content: {},
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error during FHE encryption:", error);
            if (callback) {
                callback({
                    text: `Error during FHE encryption: ${error}`,
                    content: { error },
                });
            }
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "I want to encrypt 8 with FHE for Mind Network voting.",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, I'll encrypt 8 with FHE for you.",
                    action: "MIND_FHE_ENCRYPT",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Your encrypted number is available: https://fdno-tn.mindnetwork.xyz/90dbf4fffaf6cca144386ce666052d2621367018b9665700ad01d6c385020ac3",
                },
            },
        ], [
            {
                user: "{{user1}}",
                content: {
                    text: "Can you help to encrypt 18 with FHE?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Sure, let me encrypt 18 with FHE for you.",
                    action: "MIND_FHE_ENCRYPT",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Your encrypted number is available: https://fdno-tn.mindnetwork.xyz/90dbf4fffaf6cca144386ce666052d2621367018b9665700ad01d6c385020ac3",
                },
            },
        ],
    ] as ActionExample[][],
};