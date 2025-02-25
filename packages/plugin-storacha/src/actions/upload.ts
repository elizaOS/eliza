import { composeContext, elizaLogger, generateMessageResponse, ModelClass } from "@elizaos/core";
import {
    type Action,
    type ActionExample,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
} from "@elizaos/core";
import { validateStorageClientConfig } from "../environments";
import { createStorageClient } from "../services";
import fs from "fs";
import { defaultGatewayUrl } from "../utils";

export const uploadActionTemplate = `Respond with a text message containing the link of the directory containing the uploaded files.
Extract the files from the most recent message. If no files are provided, respond with an error.

The response must include:
- link: The link of the directory containing the uploaded files

Example response:
- The files have been uploaded to Storacha. You can access them at the following link: https://w3s.link/ipfs/QmHash1

{{recentMessages}}
Extract the files from the most recent message.
Respond with a text message containing the link of the directory containing the uploaded files.`;

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
        state?: State,
        options?: { [key: string]: unknown },
        callback?: HandlerCallback
    ) => {
        // Initialize/update state
        // let currentState: State = state;
        // if (!currentState) {
        //     currentState = (await runtime.composeState(message)) as State;
        // }
        // currentState = await runtime.updateRecentMessageState(currentState);

        // const uploadContext = composeContext({
        //     state: currentState,
        //     template: uploadActionTemplate,
        // });

        // await generateMessageResponse({
        //     runtime,
        //     context: uploadContext,
        //     modelClass: ModelClass.SMALL,
        // });

        const attachments = message.content.attachments;
        if (attachments && attachments.length === 0) {
            elizaLogger.error("No file to upload.");
            callback?.({
                text: "Looks like you didn't attach any files. Please attach a file and try again.",
                action: null
            });
            return false;
        }

        if (callback) {
            await callback({
                text: "Sure thing! Starting the engines, hold on tight. Uploading file(s) to Storacha...",
                action: null
            });
        }

        try {
            elizaLogger.info("Uploading file(s) to Storacha...");
            const config = await validateStorageClientConfig(runtime);
            const storageClient = await createStorageClient(config);
            if (!storageClient) {
                elizaLogger.error("Error initializing Storacha storage client");
                await callback?.({
                    text: "I'm sorry, I couldn't initialize the Storacha storage client. Please try again later.",
                    content: { error: "Error initializing Storacha storage client" },
                });
                return false;
            }

            const files = attachments.map(attached => {
                const fileContent = fs.readFileSync(attached.url);
                const blob = new Blob([fileContent], { type: attached.contentType, });
                const file = new File([blob], attached.title, { type: attached.contentType });
                return file;
            })
            const directoryLink = await storageClient.uploadDirectory(files, {
                retries: 3,
                concurrentRequests: 3,
                pieceHasher: null, // Indicates to not store data in Filecoin
                onUploadProgress: (progress) => {
                    elizaLogger.info(`Uploading file(s) to Storacha... ${progress}%`);
                }
            })
            const gatewayUrl = config.GATEWAY_URL || defaultGatewayUrl;
            const link = `${gatewayUrl}/ipfs/${directoryLink.link().toString()}`;
            elizaLogger.info(`Uploaded file(s) to Storacha. Link: ${link}`);
            callback?.({
                text: `Here you go! You can access the file(s) at the following link: ${link}`,
                action: null,
            });

            elizaLogger.success("File(s) uploaded to Storacha");
            return true;
        } catch (error) {
            elizaLogger.error("Error uploading file(s) to Storacha", error);
            callback?.({
                text: "I'm sorry, I couldn't upload the file(s) to Storacha. Please try again later.",
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
                    text: "can you upload this file?",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you upload this file to a decentralized storage network.",
                    action: "STORAGE_UPLOAD"
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: `The files have been uploaded. You can access them at the following link: https://w3s.link/ipfs/QmHash1}`,
                    action: null
                },
            }
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
                    action: "STORAGE_UPLOAD"
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: `The files have been uploaded. You can access them at the following link: https://w3s.link/ipfs/QmHash1}`,
                    action: null
                },
            }
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "save this image for me",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "I'll help you save that image to Storacha storage.",
                    action: "STORAGE_UPLOAD"
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: `The image has been uploaded. You can access it at the following link: https://w3s.link/ipfs/QmHash1}`,
                    action: null
                },
            }
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
                    text: "I'll help you pin that image into IPFS using Storacha.",
                    action: "STORAGE_UPLOAD"
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: `The files have been pinned. You can access them at the following link: https://w3s.link/ipfs/QmHash1}`,
                    action: null
                },
            }
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
                    text: "I'll help you pin that file into IPFS using Storacha.",
                    action: "STORAGE_UPLOAD"
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: `The files have been pinned. You can access them at the following link: https://w3s.link/ipfs/QmHash1}`,
                    action: null
                },
            }
        ],
    ] as ActionExample[][],
} as Action;
