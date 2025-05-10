import {
  composePrompt as coreComposePrompt,
  composePromptFromState as coreComposePromptFromState,
  addHeader as coreAddHeader,
  composeRandomUser as coreComposeRandomUser,
  formatPosts as coreFormatPosts,
  formatMessages as coreFormatMessages,
  formatTimestamp as coreFormatTimestamp,
  shouldRespondTemplate as coreShouldRespondTemplate,
  messageHandlerTemplate as coreMessageHandlerTemplate,
  postCreationTemplate as corePostCreationTemplate,
  booleanFooter as coreBooleanFooter,
  parseBooleanFromText as coreParseBooleanFromText,
  stringArrayFooter as coreStringArrayFooter,
  parseJsonArrayFromText as coreParseJsonArrayFromText,
  extractAttributes as coreExtractAttributes,
  normalizeJsonString as coreNormalizeJsonString,
  cleanJsonResponse as coreCleanJsonResponse,
  postActionResponseFooter as corePostActionResponseFooter,
  parseActionResponseFromText as coreParseActionResponseFromText,
  truncateToCompleteSentence as coreTruncateToCompleteSentence,
  splitChunks as coreSplitChunks,
  trimTokens as coreTrimTokens,
} from '@elizaos/core';

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
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  return coreComposePrompt(state, template);
};

/**
 * Function to compose a prompt using a provided template and state.
 *
 * @param {Object} options - Object containing state and template information.
 * @param {State} options.state - The state object containing values to fill the template.
 * @param {TemplateType} options.template - The template to be used for composing the prompt.
 * @returns {string} The composed prompt output.
 */
export const composePromptFromState = ({
  state,
  template,
}: {
  state: State;
  template: TemplateType;
}) => {
  return coreComposePromptFromState(state, template);
};

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
export const addHeader = (header: string, body: string) => {
  return coreAddHeader(header, body);
};

/**
 * Generates a string with random user names populated in a template.
 *
 * This function generates random user names and populates placeholders
 * in the provided template with these names. Placeholders in the template should follow the format `{{userX}}`
 * where `X` is the position of the user (e.g., `{{name1}}`, `{{name2}}`).
 *
 * @param {string} template - The template string containing placeholders for random user names.
 * @param {number} length - The number of random user names to generate.
 * @returns {string} The template string with placeholders replaced by random user names.
 *
 * @example
 * // Given a template and a length
 * const template = "Hello, {{name1}}! Meet {{name2}} and {{name3}}.";
 * const length = 3;
 *
 * // Composing the random user string will result in:
 * // "Hello, John! Meet Alice and Bob."
 * const result = composeRandomUser(template, length);
 */
export const composeRandomUser = (template: string, length: number) => {
  return coreComposeRandomUser(template, length);
};

export const formatPosts = ({
  messages,
  entities,
  conversationHeader = true,
}: {
  messages: Memory[];
  entities: Entity[];
  conversationHeader?: boolean;
}) => {
  return coreFormatPosts(messages, entities, conversationHeader);
};

/**
 * Format messages into a string
 * @param {Object} params - The formatting parameters
 * @param {Memory[]} params.messages - List of messages to format
 * @param {Entity[]} params.entities - List of entities for name resolution
 * @returns {string} Formatted message string with timestamps and user information
 */
export const formatMessages = ({
  messages,
  entities,
}: {
  messages: Memory[];
  entities: Entity[];
}) => {
  return coreFormatMessages(messages, entites);
};

export const formatTimestamp = (messageDate: number) => {
  return coreFormatTimestamp(messageDate);
};

export const shouldRespondTemplate: string = coreShouldRespondTemplate;
export const messageHandlerTemplate: string = coreMessageHandlerTemplate;
export const postCreationTemplate: string = corePostCreationTemplate;
export const booleanFooter: string = coreBooleanFooter;

/**
 * Parses a string to determine its boolean equivalent.
 *
 * Recognized affirmative values: "YES", "Y", "TRUE", "T", "1", "ON", "ENABLE"
 * Recognized negative values: "NO", "N", "FALSE", "F", "0", "OFF", "DISABLE"
 *
 * @param {string | undefined | null} value - The input text to parse
 * @returns {boolean} - Returns `true` for affirmative inputs, `false` for negative or unrecognized inputs
 */
export function parseBooleanFromText(value: string | undefined | null): boolean {
  return coreParseBooleanFromText(value);
}

export const stringArrayFooter = coreStringArrayFooter;

/**
 * Parses a JSON array from a given text. The function looks for a JSON block wrapped in triple backticks
 * with `json` language identifier, and if not found, it searches for an array pattern within the text.
 * It then attempts to parse the JSON string into a JavaScript object. If parsing is successful and the result
 * is an array, it returns the array; otherwise, it returns null.
 *
 * @param text - The input text from which to extract and parse the JSON array.
 * @returns An array parsed from the JSON string if successful; otherwise, null.
 */
export function parseJsonArrayFromText(text: string) {
  return coreParseJsonArrayFromText(text);
}

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
export function parseJSONObjectFromText(text: string): Record<string, any> | null {
  return coreParseJSONObjectFromText(text);
}

/**
 * Extracts specific attributes (e.g., user, text, action) from a JSON-like string using regex.
 * @param response - The cleaned string response to extract attributes from.
 * @param attributesToExtract - An array of attribute names to extract.
 * @returns An object containing the extracted attributes.
 */
export function extractAttributes(
  response: string,
  attributesToExtract?: string[]
): { [key: string]: string | undefined } {
  return coreExtractAttributes(response, attributesToExtract);
}

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

export const normalizeJsonString = (str: string) => {
  return coreNormalizeJsonString(str);
};

/**
 * Cleans a JSON-like response string by removing unnecessary markers, line breaks, and extra whitespace.
 * This is useful for handling improperly formatted JSON responses from external sources.
 *
 * @param response - The raw JSON-like string response to clean.
 * @returns The cleaned string, ready for parsing or further processing.
 */
export function cleanJsonResponse(response: string): string {
  return coreCleanJsonResponse(response);
}

export const postActionResponseFooter: string = corePostActionResponseFooter;

export const parseActionResponseFromText = (text: string): { actions: ActionResponse } => {
  return coreParseActionResponseFromText(text);
};

/**
 * Truncate text to fit within the character limit, ensuring it ends at a complete sentence.
 */
export function truncateToCompleteSentence(text: string, maxLength: number): string {
  return coreTruncateToCompleteSentence(text, maxLength);
}

export async function splitChunks(content: string, chunkSize = 512, bleed = 20): Promise<string[]> {
  return coreSplitChunks(content, chunkSize, bleed);
}

/**
 * Trims the provided text prompt to a specified token limit using a tokenizer model and type.
 */
export async function trimTokens(prompt: string, maxTokens: number, runtime: IAgentRuntime) {
  return coreTrimTokens(prompt, maxTokens, runtime);
}
