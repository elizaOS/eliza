import {
    type Action,
    type HandlerCallback,
    type AgentRuntime as IAgentRuntime,
    type Memory,
    type State,
    elizaLogger,
    composeContext,
    generateObject,
    ModelClass
} from "@elizaos/core";
import { type NoteContent, type NoteHierarchy, isValidNoteHierarchy, noteHierarchySchema } from "../types";
import { getObsidian, extractLinks, storeHierarchyInMemory, retrieveHierarchyFromMemory } from "../helper";
import { traversalTemplate } from "../templates/traversal";
import { fileTemplate } from "../templates/file";

export const noteTraversalAction: Action = {
    name: "TRAVERSE_NOTE",
    similes: [
        "MAP_NOTE_LINKS",
        "MAP_LINKS_IN",
        "GET_NOTE_HIERARCHY",
        "SHOW_NOTE_LINKS",
        "LIST_NOTE_CONNECTIONS",
        "DISPLAY_NOTE_NETWORK",
        "EXPLORE_NOTE_LINKS",
        "VIEW_NOTE_CONNECTIONS",
        "ANALYZE_NOTE_LINKS",
    ],
    description:
        "Generate a hierarchical list of all outgoing links from a specific note, including nested links. Use format: 'Map links in FOLDER/Note.md'",
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
        elizaLogger.info("Starting note traversal handler");
        const obsidian = await getObsidian(runtime);

        try {
            let path = "";
            /*const text = message.content.text;

            // Extract path from text like "Map links in FOLDER/Note.md"
            if (text) {
                const match = text.match(/^(?:Map links in\s+)?(.+\.md)$/i);
                if (match) {
                    path = match[1];
                }
            }*/

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
                schema: noteHierarchySchema,
                stop: ["\n"]
            }) as any;

            if (!isValidNoteHierarchy(noteContext.object)) {
                elizaLogger.error(
                    "Note path is required. Use format: 'Map links in FOLDER/Note.md' - ",
                    noteContext.object
                );

                if (callback) {
                    callback({
                        text: `Note path is required. Use format: 'Map links in FOLDER/Note.md' - ${noteContext.object}`,
                        error: true,
                    });
                }

                return false;
            }

            // Extract path from context
            path = noteContext.object.path;

            // Fallback to explicit path if provided
            if (!path && message.content.path) {
                path = message.content.path as string;
            }

            if (!path) {
                throw new Error(
                    "Note path is required. Use format: 'Map links in FOLDER/Note.md'"
                );
            }

            // Try to retrieve from memory first
            const cachedHierarchy = await retrieveHierarchyFromMemory(runtime, message, path);
            if (cachedHierarchy) {
                elizaLogger.info(`Using cached hierarchy for note: ${path}`);
                if (callback) {
                    callback({
                        text: formatHierarchy(cachedHierarchy),
                        metadata: {
                            path: path,
                            hierarchy: cachedHierarchy,
                            source: 'cache'
                        },
                    });
                }
                return true;
            }

            // Implement recursive function to build the hierarchy
            async function buildLinkHierarchy(notePath: string, depth = 0, visited = new Set<string>()): Promise<NoteHierarchy | null> {
                // Prevent infinite recursion by checking if we've visited this note
                if (visited.has(notePath)) {
                    return null;
                }
                visited.add(notePath);

                try {
                    const noteContent: NoteContent = await obsidian.getNote(notePath);
                    const links = extractLinks(noteContent);
                    const hierarchy: NoteHierarchy = {
                        path: notePath,
                        content: noteContent.content,
                        links: []
                    };

                    // Limit recursion depth to prevent excessive traversal
                    if (depth < 7) {
                        for (const link of links) {
                            const childHierarchy = await buildLinkHierarchy(link, depth + 1, visited);
                            if (childHierarchy) {
                                hierarchy.links.push(childHierarchy);
                            }
                        }
                    }

                    return hierarchy;
                } catch (error) {
                    elizaLogger.error(`Failed to process note ${notePath}: ${error.message}`);
                    return null;
                }
            }

            elizaLogger.info(`Building link hierarchy for note: ${path}`);
            const hierarchy = await buildLinkHierarchy(path);

            if (!hierarchy) {
                throw new Error(`Failed to build hierarchy for note: ${path}`);
            }

            // Store the hierarchy in memory for future use
            await storeHierarchyInMemory(runtime, message, hierarchy);

            // Format the hierarchy for display
            function formatHierarchy(node: NoteHierarchy, level = 0): string {
                const indent = "  ".repeat(level);
                let result = `${indent}- ${node.path}\n`;

                elizaLogger.info(`Node hierarchy links for note: ${node.links}`);

                for (const link of node.links as NoteHierarchy[]) {
                    result += formatHierarchy(link, level + 1);
                }
                return result;
            }

            const formattedHierarchy = formatHierarchy(hierarchy);
            elizaLogger.info(`Successfully built hierarchy for note: ${path}`);

            if (callback) {
                callback({
                    text: formattedHierarchy,
                    metadata: {
                        path: path,
                        hierarchy: hierarchy,
                        source: 'obsidian'
                    },
                });
            }
            return true;
        } catch (error) {
            elizaLogger.error("Error in note traversal:", error);
            if (callback) {
                callback({
                    text: `Error in note traversal: ${error.message}`,
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
                    text: "Show outgoing links in Knowledge Base/Main Index.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "TRAVERSE_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Map links in Knowledge Base/Main Index.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "TRAVERSE_NOTE",
                },
            },
        ],
        [
            {
                user: "{{user1}}",
                content: {
                    text: "Show note connections in Projects/Project Overview.md",
                },
            },
            {
                user: "{{agentName}}",
                content: {
                    text: "{{responseData}}",
                    action: "TRAVERSE_NOTE",
                },
            },
        ],
    ],
};
