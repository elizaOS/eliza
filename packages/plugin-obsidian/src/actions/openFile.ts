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

export const openFileAction: Action = {
    name: "OPEN_FILE",
    similes: [
        "OPEN",
        "LAUNCH_FILE",
        "DISPLAY_FILE",
        "SHOW_FILE",
        "VIEW_FILE"
    ],
    description:
        "Open a file in the Obsidian interface. Use format: 'Open FOLDER/SUBFOLDER/filename'",
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
        _options: any,
        callback?: HandlerCallback
    ) => {
        elizaLogger.info("Starting open file handler");
        const obsidian = await getObsidian(runtime);

        try {
            // Initialize or update state for context generation
            // if (!state) {
            //     state = (await runtime.composeState(message)) as State;
            // } else {
            //     state = await runtime.updateRecentMessageState(state);
            // }
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
                    "Invalid file path. Format: 'Open FOLDER/SUBFOLDER/filename' - ",
                    fileContext.object
                );

                if (callback) {
                    callback({
                        text: `Invalid file path. Format: 'Open FOLDER/SUBFOLDER/filename' - ${fileContext.object}`,
                        error: true,
                    });
                }
                return false;
            }

            const { path } = fileContext.object;

            elizaLogger.info(`Opening file at path: ${path}`);
            await obsidian.openFile(path);
            elizaLogger.info(`Successfully opened file: ${path}`);

            if (callback) {
                callback({
                    text: `Successfully opened file: ${path}`,
                    metadata: {
                        path: path,
                        operation: "OPEN",
                        success: true
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error opening file:", error);
            if (callback) {
                callback({
                    text: `Error opening file: ${error.message}`,
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
                    text: "Open DOCUMENTS/report.txt",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "OPEN_FILE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show PROJECTS/src/config.json",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "OPEN_FILE",
                },
            },
        ],
    ],
};