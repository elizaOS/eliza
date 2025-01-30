import {
    type Action,
    type HandlerCallback,
    type AgentRuntime as IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { getObsidian }  from "../helper";

export const listDirectoryAction: Action = {
    name: "LIST_DIRECTORY",
    similes: [
        "SHOW_DIRECTORY",
        "LIST_FOLDER",
        "SHOW_FOLDER",
        "VIEW_DIRECTORY",
        "VIEW_FOLDER",
        "LIST_DIR",
        "SHOW_DIR",
        "DIR",
        "LS",
    ],
    description:
        "List all files in a specific directory of the Obsidian vault. Use format: 'List directory PATH' or 'Show files in PATH'",
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
        message: Memory,
        _state: State,
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting list directory handler");
        const obsidian = await getObsidian(runtime);

        try {
            let directoryPath = "";
            const text = message.content.text;

            // Extract directory path from various text formats
            if (text) {
                const patterns = [
                    /^(?:List|Show|View)\s+(?:directory|folder|files in|dir)\s+(.+)$/i,
                    /^(?:List|Show|View)\s+(.+)\s+(?:directory|folder|files)$/i,
                    /^(?:ls|dir)\s+(.+)$/i
                ];

                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match) {
                        directoryPath = match[1].trim();
                        break;
                    }
                }
            }

            // Fallback to explicit path if provided
            if (!directoryPath && message.content.path) {
                directoryPath = message.content.path as string;
            }

            if (!directoryPath) {
                throw new Error(
                    "Directory path is required. Use format: 'List directory PATH' or 'Show files in PATH'"
                );
            }

            elizaLogger.info(`Listing files in directory: ${directoryPath}`);
            const files: string[] = await obsidian.listDirectoryFiles(directoryPath);
            elizaLogger.info(`Successfully retrieved ${files.length} files`);

            // Format the files list into a readable string
            const formattedFiles = files.length > 0
                ? files.map(file => `- ${file}`).join('\n')
                : "No files found in the directory";

            if (callback) {
                callback({
                    text: `Found ${files.length} files in ${directoryPath}:\n\n${formattedFiles}`,
                    metadata: {
                        directory: directoryPath,
                        count: files.length,
                        files: files,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error listing directory:", error);
            if (callback) {
                callback({
                    text: `Error listing directory: ${error.message}`,
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
                    text: "List directory BLOG POSTS",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_DIRECTORY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show files in PROJECTS/src",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_DIRECTORY",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "ls DOCUMENTS/research",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_DIRECTORY",
                },
            },
        ],
    ],
};
