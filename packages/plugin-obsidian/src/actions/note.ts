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
import { type NoteContent, noteSchema, isValidNote } from "../types";
import { getObsidian }  from "../helper";
import { noteTemplate } from "../templates/note";
import { fileTemplate } from "../templates/file";

export const getNoteAction: Action = {
    name: "GET_NOTE",
    similes: [
        "DISPLAY_NOTE",
        "GRAB_NOTE",
        "FETCH_NOTE",
        "READ_NOTE",
        "RETRIEVE_NOTE",
        "LOAD_NOTE",
        "OPEN_NOTE",
        "ACCESS_NOTE",
        "VIEW_NOTE",
        "SHOW_NOTE"
    ],
    description:
        "Retrieve and display the content of a specific note from Obsidian vault by path. Use format: 'Get FOLDER/SUBFOLDER/Note Name.md'",
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
        elizaLogger.info("Starting get note handler");
        const obsidian = await getObsidian(runtime);

        try {
            let path = "";
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

            const noteContext = await generateObject({
                runtime,
                context,
                modelClass: ModelClass.MEDIUM,
                schema: noteSchema,
                stop: ["\n"]
            }) as any;

            if (!isValidNote(noteContext.object)) {
                elizaLogger.error(
                    "A Note path is required. Use format: 'Get FOLDER/SUBFOLDER/Note Name.md' - ",
                    noteContext.object
                );

                if (callback) {
                    callback({
                        text: `A Note path is required. Use format: 'Get FOLDER/SUBFOLDER/Note Name.md - ${noteContext.object}`,
                        error: true,
                    });
                }

                return false;
            }

            // Extract path from note context
            path = noteContext.object.path

            elizaLogger.info(`Fetching note at path: ${path}`);
            const noteContent: NoteContent = await obsidian.getNote(path);

            elizaLogger.info(`Successfully retrieved note: ${path}`);

            if (callback) {
                callback({
                    text: noteContent.content,
                    metadata: {
                        path: noteContent.path,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error retrieving note:", error);
            if (callback) {
                callback({
                    text: `Error retrieving note: ${error.message}`,
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
                    text: "Get BLOG POSTS/How to Angel Invest, Part 1.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "GET_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Fetch BLOG POSTS/How to Angel Invest, Part 2.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "GET_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Read BLOG POSTS/STARTUPS/Build a Team that Ships.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "GET_NOTE",
                },
            },
        ],
    ],
};
