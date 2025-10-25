import type { Entity, IAgentRuntime, Memory, State, TemplateType } from './types';
import { UUID, ContentType } from './types';
/**
 * Composes a context string by replacing placeholders in a template with corresponding values from the state.
 *
 * This function takes a template string with placeholders in the format `{{placeholder}}` and a state object.
 * It replaces each placeholder with the value from the state object that matches the placeholder's name.
 * If a matching key is not found in the state object for a given placeholder, the placeholder is replaced with an empty string.
 *
 * @param {Object} params - The parameters for composing the context.
 * @param {State} params.state - The state object containing values to replace the placeholders in the template.
 * @param {TemplateType} params.template - The template string or function containing placeholders to be replaced with state values.
 * @returns {string} The composed context string with placeholders replaced by corresponding state values.
 *
 * @example
 * // Given a state object and a template
 * const state = { userName: "Alice", userAge: 30 };
 * const template = "Hello, {{userName}}! You are {{userAge}} years old";
 *
 * // Composing the context with simple string replacement will result in:
 * // "Hello, Alice! You are 30 years old."
 * const contextSimple = composePromptFromState({ state, template });
 *
 * // Using composePromptFromState with a template function for dynamic template
 * const template = ({ state }) => {
 * const tone = Math.random() > 0.5 ? "kind" : "rude";
 *   return `Hello, {{userName}}! You are {{userAge}} years old. Be ${tone}`;
 * };
 * const contextSimple = composePromptFromState({ state, template });
 */
/**
 * Function to compose a prompt using a provided template and state.
 * It compiles the template (upgrading double braces to triple braces for non-HTML escaping)
 * and then populates it with values from the state. Additionally, it processes the
 * resulting string with `composeRandomUser` to replace placeholders like `{{nameX}}`.
 *
 * @param {Object} options - Object containing state and template information.
 * @param {State} options.state - The state object containing values to fill the template.
 * @param {TemplateType} options.template - The template string or function to be used for composing the prompt.
 * @returns {string} The composed prompt output, with state values and random user names populated.
 */
export declare const composePrompt: ({ state, template, }: {
    state: {
        [key: string]: string;
    };
    template: TemplateType;
}) => string;
/**
 * Function to compose a prompt using a provided template and state.
 *
 * @param {Object} options - Object containing state and template information.
 * @param {State} options.state - The state object containing values to fill the template.
 * @param {TemplateType} options.template - The template to be used for composing the prompt.
 * @returns {string} The composed prompt output.
 */
export declare const composePromptFromState: ({ state, template, }: {
    state: State;
    template: TemplateType;
}) => string;
/**
 * Adds a header to a body of text.
 *
 * This function takes a header string and a body string and returns a new string with the header prepended to the body.
 * If the body string is empty, the header is returned as is.
 *
 * @param {string} header - The header to add to the body.
 * @param {string} body - The body to which to add the header.
 * @returns {string} The body with the header prepended.
 *
 * @example
 * // Given a header and a body
 * const header = "Header";
 * const body = "Body";
 *
 * // Adding the header to the body will result in:
 * // "Header\nBody"
 * const text = addHeader(header, body);
 */
export declare const addHeader: (header: string, body: string) => string;
export declare const formatPosts: ({ messages, entities, conversationHeader, }: {
    messages: Memory[];
    entities: Entity[];
    conversationHeader?: boolean;
}) => string;
/**
 * Format messages into a string
 * @param {Object} params - The formatting parameters
 * @param {Memory[]} params.messages - List of messages to format
 * @param {Entity[]} params.entities - List of entities for name resolution
 * @returns {string} Formatted message string with timestamps and user information
 */
export declare const formatMessages: ({ messages, entities, }: {
    messages: Memory[];
    entities: Entity[];
}) => string;
export declare const formatTimestamp: (messageDate: number) => string;
/**
 * Parses key-value pairs from a simple XML structure within a given text.
 * It looks for an XML block (e.g., <response>...</response>) and extracts
 * text content from direct child elements (e.g., <key>value</key>).
 *
 * Note: This uses regex and is suitable for simple, predictable XML structures.
 * For complex XML, a proper parsing library is recommended.
 *
 * @param text - The input text containing the XML structure.
 * @returns An object with key-value pairs extracted from the XML, or null if parsing fails.
 */
export declare function parseKeyValueXml(text: string): Record<string, any> | null;
/**
 * Parses a JSON object from a given text. The function looks for a JSON block wrapped in triple backticks
 * with `json` language identifier, and if not found, it searches for an object pattern within the text.
 * It then attempts to parse the JSON string into a JavaScript object. If parsing is successful and the result
 * is an object (but not an array), it returns the object; otherwise, it tries to parse an array if the result
 * is an array, or returns null if parsing is unsuccessful or the result is neither an object nor an array.
 *
 * @param text - The input text from which to extract and parse the JSON object.
 * @returns An object parsed from the JSON string if successful; otherwise, null or the result of parsing an array.
 */
export declare function parseJSONObjectFromText(text: string): Record<string, any> | null;
/**
 * Normalizes a JSON-like string by correcting formatting issues:
 * - Removes extra spaces after '{' and before '}'.
 * - Wraps unquoted values in double quotes.
 * - Converts single-quoted values to double-quoted.
 * - Ensures consistency in key-value formatting.
 * - Normalizes mixed adjacent quote pairs.
 *
 * This is useful for cleaning up improperly formatted JSON strings
 * before parsing them into valid JSON.
 *
 * @param str - The JSON-like string to normalize.
 * @returns A properly formatted JSON string.
 */
export declare const normalizeJsonString: (str: string) => string;
/**
 * Truncate text to fit within the character limit, ensuring it ends at a complete sentence.
 */
export declare function truncateToCompleteSentence(text: string, maxLength: number): string;
export declare function splitChunks(content: string, chunkSize?: number, bleed?: number): Promise<string[]>;
/**
 * Trims the provided text prompt to a specified token limit using a tokenizer model and type.
 */
export declare function trimTokens(prompt: string, maxTokens: number, runtime: IAgentRuntime): Promise<string>;
export declare function safeReplacer(): (_key: string, value: any) => any;
/**
 * Parses a string to determine its boolean equivalent.
 *
 * Recognized affirmative values: "YES", "Y", "TRUE", "T", "1", "ON", "ENABLE"
 * Recognized negative values: "NO", "N", "FALSE", "F", "0", "OFF", "DISABLE"
 *
 * @param {string | undefined | null} value - The input text to parse
 * @returns {boolean} - Returns `true` for affirmative inputs, `false` for negative or unrecognized inputs
 */
export declare function parseBooleanFromText(value: string | undefined | null): boolean;
/**
 * Validates a UUID value.
 *
 * @param {unknown} value - The value to validate.
 * @returns {UUID | null} Returns the validated UUID value or null if validation fails.
 */
export declare function validateUuid(value: unknown): UUID | null;
/**
 * Converts a string or number to a UUID.
 *
 * @param {string | number} target - The string or number to convert to a UUID.
 * @returns {UUID} The UUID generated from the input target.
 * @throws {TypeError} Throws an error if the input target is not a string.
 */
export declare function stringToUuid(target: string | number): UUID;
/**
 * Pre-warm the SHA-1 cache with common values using WebCrypto
 * Call this during initialization to improve performance
 */
export declare function prewarmUuidCache(values: string[]): Promise<void>;
export declare const getContentTypeFromMimeType: (mimeType: string) => ContentType | undefined;
export declare function getLocalServerUrl(path: string): string;
//# sourceMappingURL=utils.d.ts.map