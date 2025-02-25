import {
    type Action,
    type ActionExample,
    elizaLogger,
    type HandlerCallback,
    type IAgentRuntime,
    Media,
    type Memory,
    type State,
} from "@elizaos/core";
import { validateStorageClientConfig } from "../environments";
import { defaultGatewayUrl, getCIDsFromMessage } from "../utils";

export const retrieveAction: Action = {
    name: "STORAGE_RETRIEVE",
    similes: [
        "RETRIEVE",
        "RETRIEVE_FILE",
        "RETRIEVE_FILE_FROM_STORAGE",
        "RETRIEVE_FILE_FROM_IPFS",
        "GET",
        "GET_FILE",
        "GET_FILE_FROM_STORAGE",
        "GET_FILE_FROM_IPFS",
        "GET_FILE_FROM_CID",
        "LOAD",
        "LOAD_FILE",
        "LOAD_FILE_FROM_STORAGE",
        "LOAD_FILE_FROM_IPFS",
        "LOAD_FILE_FROM_CID",
        "READ",
        "READ_FILE",
        "READ_FILE_FROM_STORAGE",
        "READ_FILE_FROM_IPFS",
        "READ_FILE_FROM_CID",
    ],
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
        elizaLogger.log("Starting STORAGE_RETRIEVE validate...");
        await validateStorageClientConfig(runtime);
        return true;
    },
    description:
        "Retrieve a file from the Storacha network. Use this action when a user asks you to retrieve a file from the Storacha network based on a CID.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback?: HandlerCallback
    ): Promise<boolean> => {
        elizaLogger.log("Starting STORAGE_RETRIEVE handler...");
        const cids = getCIDsFromMessage(message);
        if (cids.length === 0) {
            callback?.({ text: "You didn't provide any CIDs to retrieve." });
            return false;
        }

        const config = await validateStorageClientConfig(runtime);

        try {
            elizaLogger.log("Retrieving file(s) from storage...");
            const gatewayUrl = config.GATEWAY_URL || defaultGatewayUrl;
            // TODO: download, zip and send the zip as an attachment in the message
            const files = cids.map((cid, idx) => {
                return {
                    url: `${gatewayUrl}/ipfs/${cid}`,
                    title: `File ${idx + 1}`,
                };
            });
            callback?.({
                text: `The file(s) you requested are ready to be downloaded. \n\n${files.map((file) => `- ${file.url}`).join("\n")}`,
            });
            elizaLogger.log("File(s) retrieved successfully!");
            return true;
        } catch (error) {
            elizaLogger.error("Error during retrieve file(s) from storage:", error);
            callback?.({ text: `Error during retrieve file(s) from storage: ${error.message}` });
            return false;
        }
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Retrieve the file with CID: QmS4ghgMgfFvqPjB4WKXHaN15ZyT4K4JY8Y4K3Y4K3Y4K3Y",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Ok, I'll get it for you. Just a moment...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Fetch the file QmS4ghgMgfFvqPjB4WKXHaN15ZyT4K4JY8Y4K3Y4K3Y4K3Y",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Ok, I'll get it for you. Just a second...",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Get the file QmS4ghgMgfFvqPjB4WKXHaN15ZyT4K4JY8Y4K3Y4K3Y4K3Y",
                },
            },
            {
                user: "{{agent}}",
                content: {
                    text: "Ok, I'll get it for you. Hold on...",
                },
            },
        ],
    ] as ActionExample[][],
} as Action;
