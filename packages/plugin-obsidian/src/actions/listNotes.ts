import {
    type Action,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
} from "@elizaos/core";
import { getObsidian }  from "../helper";

export const listNotesAction: Action = {
    name: "LIST_NOTES",
    similes: [
        "LIST_NOTES",
        "SHOW_NOTES",
        "GET_NOTES",
        "FETCH_NOTES",
        "VIEW_NOTES",
        "DISPLAY_NOTES",
        "ENUMERATE_NOTES",
    ],
    description:
        "List all markdown notes in the Obsidian vault. Use format: 'List notes' or 'Show all notes'",
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
        elizaLogger.info("Starting list notes handler");
        const obsidian = await getObsidian(runtime);

        try {
            elizaLogger.info("Fetching list of notes from vault");
            const notes: string[] = await obsidian.listNotes();

            elizaLogger.info(`Successfully retrieved ${notes.length} notes`);

            // Format the notes list into a readable string
            const formattedNotes = notes.length > 0
                ? notes.map(note => `- ${note}`).join('\n')
                : "No notes found in the vault";

            if (callback) {
                callback({
                    text: `Found ${notes.length} notes in the vault:\n\n${formattedNotes}`,
                    metadata: {
                        count: notes.length,
                        notes: notes,
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error listing notes:", error);
            if (callback) {
                callback({
                    text: `Error listing notes: ${error.message}`,
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
                    text: "List notes",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_NOTES",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show all notes in vault",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "LIST_NOTES",
                },
            },
        ],
    ],
};
