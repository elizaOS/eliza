import type { Entity, Memory, State, TemplateType } from './types';

import { UUID } from './types';

// Import core IAgentRuntime for compatibility with core functions
import type { IAgentRuntime as CoreIAgentRuntime } from '../../types';

import {
  addHeader as coreAddHeader,
  composePrompt as coreComposePrompt,
  composePromptFromState as coreComposePromptFromState,
  formatMessages as coreFormatMessages,
  formatPosts as coreFormatPosts,
  formatTimestamp as coreFormatTimestamp,
  parseBooleanFromText as coreParseBooleanFromText,
  parseJSONObjectFromText as coreParseJSONObjectFromText,
  parseKeyValueXml as coreParseKeyValueXml,
  safeReplacer as coreSafeReplacer,
  stringToUuid as coreStringToUuid,
  trimTokens as coreTrimTokens,
  truncateToCompleteSentence as coreTruncateToCompleteSentence,
  validateUuid as coreValidateUuid,
} from '../../utils';

// Text Utils

/**
 * Convert all double-brace bindings in a Handlebars template
 * to triple-brace bindings, so the output is NOT HTML-escaped.
 *
 * - Ignores block/partial/comment tags that start with # / ! >.
 * - Ignores the else keyword.
 * - Ignores bindings that are already triple-braced.
 *
 * @param  tpl  Handlebars template source
 * @return      Transformed template
 */
// really shouldn't be exported
/*
export function upgradeDoubleToTriple(tpl) {
  return coreUpgradeDoubleToTriple(tpl)
}
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
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  return coreComposePrompt({ state, template });
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
  return coreComposePromptFromState({ state, template });
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

export const formatPosts = ({
  messages,
  entities,
  conversationHeader = true,
}: {
  messages: Memory[];
  entities: Entity[];
  conversationHeader?: boolean;
}) => {
  return coreFormatPosts({ messages, entities, conversationHeader });
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
  return coreFormatMessages({ messages, entities });
};

export const formatTimestamp = (messageDate: number) => {
  return coreFormatTimestamp(messageDate);
};

/**
 * Validates a UUID value.
 *
 * @param {unknown} value - The value to validate.
 * @returns {UUID | null} Returns the validated UUID value or null if validation fails.
 */
export function validateUuid(value: unknown): UUID | null {
  return coreValidateUuid(value);
}

/**
 * Converts a string or number to a UUID.
 *
 * @param {string | number} target - The string or number to convert to a UUID.
 * @returns {UUID} The UUID generated from the input target.
 * @throws {TypeError} Throws an error if the input target is not a string.
 */
export function stringToUuid(target: string | number): UUID {
  return coreStringToUuid(target);
}

// Add the new exports, wrapping the core functions
export function truncateToCompleteSentence(text: string, maxLength: number): string {
  return coreTruncateToCompleteSentence(text, maxLength);
}

export function parseKeyValueXml(text: string): Record<string, any> | null {
  return coreParseKeyValueXml(text);
}

export function parseJSONObjectFromText(text: string): Record<string, any> | null {
  return coreParseJSONObjectFromText(text);
}

export function parseBooleanFromText(text: string): boolean | null {
  return coreParseBooleanFromText(text);
}

export function safeReplacer(): (key: string, value: any) => any {
  return coreSafeReplacer();
}

export function trimTokens(
  text: string,
  maxTokens: number,
  runtime: CoreIAgentRuntime
): Promise<string> {
  return coreTrimTokens(text, maxTokens, runtime);
}
