import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { getObsidian }  from "../helper";

export const listAllFilesAction: Action = {
    name: "LIST_ALL",
    similes: [
        "LIST_VAULT_FILES",
        "LIST_ALL_VAULT_FILES",
        "LIST_ALL_FILES",
        "SHOW_ALL_FILES",
        "GET_ALL_FILES",
        "FETCH_ALL_FILES",
        "VIEW_ALL_FILES",
        "DISPLAY_ALL_FILES",
        "ENUMERATE_ALL_FILES",
        "LIST_EVERYTHING",
        "SHOW_EVERYTHING"
    ],
    description:
        "List all files in the entire Obsidian vault. Use format: 'List all files' or 'Show all files'",
    validate: async (runtime: IAgentRuntime) => {
        try {
            elizaLogger.debug("Validating Obsidian connection");
            const obsidian = await getObsidian(runtime);
            await obsidian.connect();
            elizaLogger.debug("Obsidian connection validated successfully");
            return true;
        } catch (error) {
            elizaLogger.error("Failed to validate Obsidian connection:", error);
            return false;
        }
    },
    handler: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting list all files handler");
        const obsidian = await getObsidian(runtime);

        try {
            elizaLogger.info("Fetching list of all files from vault");

            const files: string[] = await obsidian.listFiles();
            elizaLogger.info(`Successfully retrieved ${files.length} files`);

            // Group files by directory for better organization
            const filesByDirectory: { [key: string]: string[] } = {};

            for (const file of files) {
                const directory = file.split('/').slice(0, -1).join('/') || '/';
                if (!filesByDirectory[directory]) {
                    filesByDirectory[directory] = [];
                }
                filesByDirectory[directory].push(file.split('/').pop() || file);
            }


            // Format the files list into a readable tree structure
            const formattedFiles = files.length > 0
                ? Object.entries(filesByDirectory)
                    .map(([directory, files]) =>
                        `${directory === '/' ? 'Root' : directory}:\n${files.map(file => `  - ${file}`).join('\n')}`)
                    .join('\n\n')
                : "No files found in the vault";

            if (callback) {
                callback({
                    text: `Found ${files.length} files in the vault:\n\n${formattedFiles}`,
                    metadata: {
                        count: files.length,
                        files: files,
                        filesByDirectory: filesByDirectory,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error listing files:", error);
            if (callback) {
                callback({
                    text: `Error listing files: ${error.message}`,
                    error: true,
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
                    text: "List all files",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_ALL",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show everything in the vault",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_ALL",
                },
            },
        ],
    ],
};
