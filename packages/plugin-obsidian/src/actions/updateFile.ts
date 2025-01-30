import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    composeContext,
    generateObject,
    ModelClass
} from "@elizaos/core";
import { fileSchema, isValidFile } from "../types";
import { getObsidian } from "../helper";
import { fileTemplate } from "../templates/file";


// Add at the top with other imports
interface UpdateFileOptions {
    path?: string;
    content?: string;
    createIfNotExists?: boolean;
}

export const updateFileAction: Action = {
    name: "UPDATE_FILE",
    similes: [
        "PATCH_FILE",
        "MODIFY_FILE",
        "UPDATE",
        "PATCH",
        "EDIT_FILE",
        "CHANGE_FILE"
    ],
    description:
        "Update an existing file in the Obsidian vault. Use format: 'Update FOLDER/SUBFOLDER/filename with content: your_content'",
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
        state: State,
        _options: UpdateFileOptions,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting update file handler");
        const obsidian = await getObsidian(runtime);

        try {
            // Initialize or update state for context generation
            // if (!state) {
            //     state = (await runtime.composeState(message)) as State;
            // } else {
            //     state = await runtime.updateRecentMessageState(state);
            // }

            // Initialize or update state for context generation
            let currentState: State;
            if (!state) {
                currentState = (await runtime.composeState(message)) as State;
            } else {
                currentState = await runtime.updateRecentMessageState(state);
            }

            const context = composeContext({
                state: currentState,
                template: fileTemplate(message.content.text),
            });

            const fileContext = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.MEDIUM,
                schema: fileSchema,
                stop: ["\n"]
            }) as any;

            if (!isValidFile(fileContext.object)) {
                elizaLogger.error(
                    "Invalid file information. Required: path and content. Format: 'Update FOLDER/SUBFOLDER/filename with content: your_content' - ",
                    fileContext.object
                );

                if (callback) {
                    callback({
                        text: `Invalid file information. Required: path and content. Format: 'Update FOLDER/SUBFOLDER/filename with content: your_content' - ${fileContext.object}`,
                        error: true,
                    });
                }
                return false;
            }

            const { path, content } = fileContext.object;

            if (!content) {
                elizaLogger.error("File content is required for updating");
                if (callback) {
                    callback({
                        text: "File content is required for updating",
                        error: true,
                    });
                }
                return false;
            }

            elizaLogger.info(`Updating file at path: ${path}`);
            // Note: patchFile will only update existing files, it will not create new ones
            await obsidian.patchFile(path, content);
            elizaLogger.info(`Successfully updated file: ${path}`);

            if (callback) {
                callback({
                    text: `Successfully updated file: ${path}`,
                    metadata: {
                        path: path,
                        operation: "UPDATE",
                        success: true
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error updating file:", error);
            if (callback) {
                callback({
                    text: `Error updating file: ${error.message}`,
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
                    text: "Update DOCUMENTS/report.txt with content: This is an updated report",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "UPDATE_FILE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Patch PROJECTS/src/config.json with content: { \"version\": \"2.0.0\" }",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "UPDATE_FILE",
                },
            },
        ],
    ],
};