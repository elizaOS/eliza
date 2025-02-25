import { composeContext, elizaLogger } from "@elizaos/core";
import { generateMessageResponse, generateTrueOrFalse } from "@elizaos/core";
import { booleanFooter, messageCompletionFooter } from "@elizaos/core";
import {
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { validateStorageClientConfig } from "../environments";
import { getStorageClient } from "../lib/storage";


export const messageHandlerTemplate =
    `# Action Examples
{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Task: Handle Storacha storage operations
You are helping the user interact with Storacha decentralized storage. You can:
- Upload files to storage
- Fetch content using CIDs
- Manage uploaded content

{{recentMessages}}

# Instructions: Write a response explaining what storage operation you'll perform.
` + messageCompletionFooter;

export const uploadAction: Action = {
    name: "STORAGE_UPLOAD",
    similes: ["UPLOAD", "STORE", "SAVE", "PUT", "PIN"],
    description: "Use this action when the user wants to upload a file to Storacha distributed storage network.",
    validate: async (runtime: IAgentRuntime) => {
        await validateStorageClientConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        options: any,
        callback: HandlerCallback
    ) => {
        elizaLogger.debug("Starting file upload to Storacha...");
        try {
            const config = await validateStorageClientConfig(runtime);
            const storageClient = await getStorageClient(config);

            // Extract command from message
            const text = message.content.text.toLowerCase();

            elizaLogger.info("Starting file upload to Storacha...");
            const attachments = message.content.attachments;
            if (attachments.length === 0) {
                await callback({
                    text: "No file to upload. Please attach a file to upload to Storacha.",
                    action: null
                });
                return false;
            }
            elizaLogger.info("Uploading file(s) to Storacha...");
            // const encodedFiles = attachments.map(attached => {
            //     const memoryBlob = new Blob([attached.text], {
            //         type: attached.contentType,
            //     });
            //     const memoryFile = new File([memoryBlob], attached.title, { type: attached.contentType });
            //     return memoryFile;
            // })
            // const directoryLink = await storageClient.uploadDirectory(encodedFiles, {
            //     retries: 3,
            //     concurrentRequests: 5,
            //     pieceHasher: null, // Indicates to not store data in Filecoin
            //     onUploadProgress: (progress) => {
            //         elizaLogger.info(`Uploading file(s) to Storacha... ${progress}%`);
            //     }
            // })
            // const link = `${config.GATEWAY_URL}/ipfs/${directoryLink.link().toString() }`;

            elizaLogger.success("File(s) uploaded to Storacha");
            //TODO: print CIDs of the uploaded files
            return true;
        } catch (error) {
            elizaLogger.error("Error uploading file(s) to Storacha", error);
            await callback({
                text: "Error uploading file(s) to Storacha",
                content: { error: error.message },
            });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "can you upload this file to Storacha?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you upload this file to Storacha storage.",
                    action: "UPLOAD_FILE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "store this document in Storacha please",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you store that document in Storacha storage.",
                    action: "UPLOAD_FILE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "save this image to storacha",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you save that image to Storacha storage.",
                    action: "UPLOAD_FILE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "pin this image into IPFS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you pin that image into IPFS via Storacha.",
                    action: "UPLOAD_FILE"
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "pin this file into IPFS",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you pin that file into IPFS via Storacha.",
                    action: "UPLOAD_FILE"
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
