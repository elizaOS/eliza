import { type IAgentRuntime, type AgentRuntime, ModelClass, type Memory, MemoryManager, type State } from "@elizaos/core";
import { elizaLogger, composeContext, generateObject, stringToUuid } from "@elizaos/core";
//import fileTypeChecker from "file-type-checker";
import { lookup } from 'mrmime';
import { ObsidianProvider } from "./providers/obsidianClient";
import { validateObsidianConfig } from "./enviroment";
import { searchQuerySchema, type NoteHierarchy, type NoteContent } from "./types";


// Update SearchState interface to make properties optional
interface SearchState extends State {
    bio: string;                  // Required from State
    lore: string;                 // Required from State
    messageDirections: string;    // Required from State
    postDirections: string;       // Required from State
    // Search-specific properties
    query?: string | SearchQuery;
    options?: SearchOptions;
}

interface SearchOptions {
    contextLength?: number;
    searchIn?: string[];
}

interface SearchQuery {
    options?: {
        searchIn?: string[];
        contextLength?: number;
        ignoreCase?: boolean;
    };
    query?: string | Record<string, unknown>;
    queryFormat?: "plaintext" | "jsonlogic" | "dataview";
    and?: Array<SearchCondition>;
    or?: Array<SearchCondition>;
}

interface SearchContextResponse {
    object: SearchQuery;
}

interface SearchCondition {
    in?: [string, { var: string }];
    regexp?: [string, { var: string }];
}


let obsidianInstance: ObsidianProvider | undefined;

export async function getObsidian(runtime: IAgentRuntime): Promise<ObsidianProvider> {
    if (!obsidianInstance) {
        elizaLogger.debug("Creating new ObsidianProvider instance");
        const config = await validateObsidianConfig(runtime);
        obsidianInstance = await ObsidianProvider.create(
            runtime as AgentRuntime,
            Number.parseInt(config.OBSIDIAN_API_PORT),
            config.OBSIDIAN_API_TOKEN,
            config.OBSIDIAN_API_URL
        );
    }
    return obsidianInstance;
}


// Extract outgoing links from the note content
export function extractLinks(noteContent: NoteContent): string[] {
    const linkRegex = /\[\[(.*?)\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while (true) {
        match = linkRegex.exec(noteContent.content);
        if (match === null) break;
        
        if (match[1] && !lookup(match[1])) {
            links.push(`${noteContent.path.split("/")[0]}/${match[1]}.md`);
        } else {
            links.push(match[1]);
        }
    }
    return links;
}

// Store the hierarchical link data in the AI agent's memory
export async function storeHierarchyInMemory(runtime: IAgentRuntime, message: Memory, hierarchy: NoteHierarchy) {
    const memory: Memory = {
        id: stringToUuid(hierarchy.path),
        roomId: message.roomId,
        userId: message.userId,
        agentId: runtime.agentId,
        content: {
            text: JSON.stringify(hierarchy),
            type: 'note_traversal',
            metadata: {
                path: hierarchy.path,
                timestamp: new Date().toISOString()
            }
        }
    };
    const memoryManager = new MemoryManager({
        runtime,
        tableName: "obsidian",
    });

    await memoryManager.createMemory(memory);
    elizaLogger.info(`Stored hierarchy for note ${hierarchy.path} in memory`);
}

// Retrieve and utilize the stored hierarchy
export async function retrieveHierarchyFromMemory(runtime: IAgentRuntime, message: Memory, notePath: string): Promise<NoteHierarchy | null> {

    const memoryManager = new MemoryManager({
        runtime,
        tableName: "obsidian",
    });

    try {
        const memories = await memoryManager.getMemories({
            roomId: message.roomId,
            count: 10,
            start: 0,
            end: Date.now(),
        });

        if (memories && memories.length > 0) {
            const memory = memories[0];
            const hierarchy: NoteHierarchy = JSON.parse(memory.content.text);
            elizaLogger.info(`Retrieved hierarchy for note ${notePath} from memory`);
            return hierarchy;
        }
        return null;
    } catch (error) {
        elizaLogger.error(`Failed to retrieve hierarchy from memory: ${error.message}`);
        return null;
    }
}


/**
 * Converts markdown text to plaintext by removing common markdown syntax
 *
 * This function handles the following markdown elements:
 * - Headers (# through ######)
 * - Bold and italic markers (* and _)
 * - Code blocks (both inline and multi-line)
 * - Links and images
 * - Blockquotes
 * - Horizontal rules
 * - Ordered and unordered lists
 *
 * @param markdown - The markdown text to convert
 * @returns The plaintext version of the markdown
 */
export function markdownToPlaintext(markdown: string): string {
    // Handle empty or invalid input
    if (!markdown || typeof markdown !== 'string') {
        return '';
    }

    let text = markdown;

    // Remove code blocks with their content intact
    text = text.replace(/```[\s\S]*?```/g, (match) => {
        // Remove only the backticks, preserve the code content
        return match.slice(3, -3).trim();
    });

    // Remove inline code
    text = text.replace(/`([^`]+)`/g, '$1');

    // Remove headers while preserving content
    text = text.replace(/^#{1,6}\s+(.*)$/gm, '$1');

    // Remove bold and italic markers
    text = text.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');

    // Replace horizontal rules with newlines
    text = text.replace(/^[\s-*_]{3,}$/gm, '\n');

    // Remove blockquotes markers
    text = text.replace(/^>\s+/gm, '');

    // Handle links - keep text, remove URL
    text = text.replace(/\[([^\]]+)\]\([)]+\)/g, '$1');

    // Remove image markdown completely
    text = text.replace(/!\[([^\]]*)\]\([)]+\)/g, '');

    // Handle lists - remove markers but preserve content
    text = text.replace(/^[\s-]*[-+*]\s+/gm, '');  // Unordered lists
    text = text.replace(/^\s*\d+\.\s+/gm, '');     // Ordered lists

    // Clean up excessive whitespace
    text = text.replace(/\n\s*\n\n/g, '\n\n');  // Multiple blank lines to double
    text = text.trim();

    return text;
}

/**
 * Removes code block delimiters from a given string.
 * Specifically, it removes opening and closing triple backticks (```) and any language identifiers.
 *
 * @param input - The string containing code block delimiters.
 * @returns The string with code block delimiters removed.
 */
export function removeCodeBlockDelimiters(input: string): string {
    // Regular expression to match opening ``` with optional language identifier and closing ```
    const codeBlockRegex = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/gm;

    // Replace the matched code block delimiters with the captured content
    return input.replace(codeBlockRegex, '$1');
  }


// Define example prompts to guide the LLM in generating the correct structure
const EXAMPLE_SEARCH_PROMPTS = [
    {
        input: "Search typescript in the notes",
        output: {
            query: "typescript",
            queryFormat: "plaintext",
            options: { contextLength: 150 }
        }
    },
    {
        input: "Find wisdom or mastering in all files",
        output: {
            query: "wisdom OR mastering",
            queryFormat: "plaintext",
            options: { contextLength: 150 }
        }
    },
    {
        input: "Find markdown files containing 'react' or 'typescript'",
        output: {
            query: {
                and: [
                    { or: [{ in: ["react", { var: "content" }] }, { in: ["typescript", { var: "content" }] }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Search for files with regex pattern 'def.*main'",
        output: {
            query: {
                and: [
                    { or: [{ regexp: ["def.*main", { var: "content" }] }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Search for markdown files with regex pattern '<div[^>]*>'",
        output: {
            query: {
                and: [
                    { or: [{ regexp: ["<div[^>]*>", { var: "content" }] }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Find markdown files with filenames containing 'project'",
        output: {
            query: {
                and: [
                    { in: ["project", { var: "path" }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Search for markdown files with filenames matching regex pattern '^notes_.*\\.md$'",
        output: {
            query: {
                and: [
                    { regexp: ["^notes_.*\\.md$", { var: "path" }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Find markdown files with filenames containing 'summary' or 'report'",
        output: {
            query: {
                and: [
                    { or: [{ in: ["summary", { var: "path" }] }, { in: ["report", { var: "path" }] }] }
                ]
            },
            queryFormat: "jsonlogic",
            options: { contextLength: 200 }
        }
    },
    {
        input: "Select TABLE file.mtime FROM #Projects IN Projects/ AND Archive/Projects",
        output: {
            query: "TABLE file.mtime FROM #Projects",
            queryFormat: "dataview",
            options: {
                searchIn: ["Projects/", "Archive/Projects/"]
            }
        }
    }
];

/**
 * Constructs a detailed prompt for the LLM to generate search parameters
 * @param userInput - The natural language search query from the user
 * @returns A formatted prompt string with examples and instructions
 */
function constructSearchPrompt(userInput: string): string {
    const examplePrompts = EXAMPLE_SEARCH_PROMPTS.map(example =>
        `Input: "${example.input}"\nOutput: ${JSON.stringify(example.output, null, 2)}`
    ).join('\n\n');

    return `Respond with a JSON block containing only the extracted values. Use null for any values that cannot be determined.

Follow these rules:
1. Use the exact structure shown in the examples
2. The query is relevant to the user's request
3. Use space-separated terms for combined search (default: 'plaintext')
4. Use OR operator when searching for alternatives (default: 'plaintext')
5. Always include query.and and query.or as an array (default: "jsonlogic")
6. Use appropriate glob patterns for file types when appropriate (default: "jsonlogic")
7. Choose between contains and regexp based on the search requirements (default: "jsonlogic")
8. The format of the query - queryFormat (string): Must be one of: 'plaintext', 'dataview', or 'jsonlogic'. (default: 'plaintext')
9. When the prompt have "containing" or "contains", use "in" operator. DO NOT use "contains" operator (this is a strictly requirement) (default: "jsonlogic")
10. When the prompt have "matching" or "match", use "regexp" operator (default: "jsonlogic")
11. Maintain contextLength at 150

Examples:
${examplePrompts}

Now, convert this request:
"${userInput}"

Respond ONLY with a JSON block containing only the extracted values.`;
}

/**
 * Calls the LLM API to process the user's search request
 * @param prompt - The formatted prompt string
 * @returns A Promise resolving to the JSON string response
 */

// Update the generateSearchParameters function
async function genereteSearchParameters(
    prompt: string, 
    state: SearchState, 
    runtime: IAgentRuntime
): Promise<string> {
    try {
        const context = composeContext({
            state,
            template: prompt,
        });

        const searchContext = await generateObject({
            runtime,
            context,
            modelClass: ModelClass.MEDIUM,
            schema: searchQuerySchema,
            stop: ["\n\n"]
        }) as SearchContextResponse;

        // Now we can safely access .object
        const parsedCompletion = searchContext.object;
        elizaLogger.info("Parsed completion:", JSON.stringify(parsedCompletion, null, 2));
        return JSON.stringify(parsedCompletion);

    } catch (error: unknown) {
        console.error('Error calling LLM API:', error);
        return "**No matching notes found**";
    }
}
// async function genereteSearchParameters(prompt: string, state: any, runtime: IAgentRuntime): Promise<string> {
//     try {

//         const context = composeContext({
//             state,
//             template: prompt,
//         });

//         //TODO: temperature: 0.2 - Make this dynamic
//         const searchContext = await generateObject({
//             runtime,
//             context,
//             modelClass: ModelClass.MEDIUM,
//             schema: searchQuerySchema,
//             stop: ["\n\n"]
//         }) as SearchQuery;

//         /*if (!isSearchQuery(searchContext.object)) {
//             elizaLogger.error(
//                 "Invalid search query:",
//                 searchContext.object
//             );
//             return null;
//         }*/

//         // Attempt to parse the completion as JSON to verify structure
//         const parsedCompletion = searchContext.object; //JSON.parse(JSON.stringify(searchContext.object, null, 2));
//         elizaLogger.info("Parsed completion:", JSON.stringify(parsedCompletion , null, 2));
//         return JSON.stringify(parsedCompletion);

//     } catch (error) {
//         console.error('Error calling LLM API:', error);
//         // Return a basic fallback response that matches the schema
//         return "**No matching notes found**";
//     }
// }

// Update processUserInput to use proper types
// export async function processUserInput(
//     userInput: string, 
//     state: SearchState, 
//     runtime: IAgentRuntime
// ): Promise<SearchQuery | null> {
//     const prompt = constructSearchPrompt(userInput);
//     const llmResponse = await genereteSearchParameters(prompt, state, runtime);

//     try {
//         const parsedResponse = JSON.parse(llmResponse) as SearchQuery;
//         const validatedResponse = searchQuerySchema.parse(parsedResponse);
//         return validatedResponse;
//     } catch (error: unknown) {
//         console.error('Failed to parse or validate LLM response:', error);
//         return null;
//     }
// }
export async function processUserInput(
    userInput: string, 
    state: State,  // Accept base State type
    runtime: IAgentRuntime
): Promise<SearchQuery | null> {
    // Cast state to SearchState since we'll be adding search-specific properties
    const searchState: SearchState = {
        ...state,
        query: userInput  // Add the query from userInput
    };

    const prompt = constructSearchPrompt(userInput);
    const llmResponse = await genereteSearchParameters(prompt, searchState, runtime);

    try {
        const parsedResponse = JSON.parse(llmResponse) as SearchQuery;
        const validatedResponse = searchQuerySchema.parse(parsedResponse);
        return validatedResponse;
    } catch (error: unknown) {
        console.error('Failed to parse or validate LLM response:', error);
        return null;
    }
}