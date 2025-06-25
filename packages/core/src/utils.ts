import handlebars from 'handlebars';
import { sha1 } from 'js-sha1';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

import { names, uniqueNamesGenerator } from 'unique-names-generator';
import { z } from 'zod';

import logger from './logger';
import type { Content, Entity, IAgentRuntime, Memory, State, TemplateType } from './types';
import { ModelType, UUID, ContentType } from './types';

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
function upgradeDoubleToTriple(tpl) {
  return tpl.replace(
    // ────────╮ negative-LB: not already "{{{"
    //          │   {{     ─ opening braces
    //          │    ╰──── negative-LA: not {, #, /, !, >
    //          ▼
    /(?<!{){{(?![{#\/!>])([\s\S]*?)}}/g,
    (_match, inner) => {
      // keep the block keyword {{else}} unchanged
      if (inner.trim() === 'else') return `{{${inner}}}`;
      return `{{{${inner}}}}`;
    }
  );
}

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
export const composePrompt = ({
  state,
  template,
}: {
  state: { [key: string]: string };
  template: TemplateType;
}) => {
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));
  const output = composeRandomUser(templateFunction(state), 10);
  return output;
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
  const templateStr = typeof template === 'function' ? template({ state }) : template;
  const templateFunction = handlebars.compile(upgradeDoubleToTriple(templateStr));

  // get any keys that are in state but are not named text, values or data
  const stateKeys = Object.keys(state);
  const filteredKeys = stateKeys.filter((key) => !['text', 'values', 'data'].includes(key));

  // this flattens out key/values in text/values/data
  const filteredState = filteredKeys.reduce((acc, key) => {
    acc[key] = state[key];
    return acc;
  }, {});

  // and then we flat state.values again
  const output = composeRandomUser(templateFunction({ ...filteredState, ...state.values }), 10);
  return output;
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
  return body.length > 0 ? `${header ? `${header}\n` : header}${body}\n` : '';
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
const composeRandomUser = (template: string, length: number) => {
  const exampleNames = Array.from({ length }, () =>
    uniqueNamesGenerator({ dictionaries: [names] })
  );
  let result = template;
  for (let i = 0; i < exampleNames.length; i++) {
    result = result.replaceAll(`{{name${i + 1}}}`, exampleNames[i]);
  }

  return result;
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
  // Group messages by roomId
  const groupedMessages: { [roomId: string]: Memory[] } = {};
  messages.forEach((message) => {
    if (message.roomId) {
      if (!groupedMessages[message.roomId]) {
        groupedMessages[message.roomId] = [];
      }
      groupedMessages[message.roomId].push(message);
    }
  });

  // Sort messages within each roomId by createdAt (oldest to newest)
  Object.values(groupedMessages).forEach((roomMessages) => {
    roomMessages.sort((a, b) => a.createdAt - b.createdAt);
  });

  // Sort rooms by the newest message's createdAt
  const sortedRooms = Object.entries(groupedMessages).sort(
    ([, messagesA], [, messagesB]) =>
      messagesB[messagesB.length - 1].createdAt - messagesA[messagesA.length - 1].createdAt
  );

  const formattedPosts = sortedRooms.map(([roomId, roomMessages]) => {
    const messageStrings = roomMessages
      .filter((message: Memory) => message.entityId)
      .map((message: Memory) => {
        const entity = entities.find((entity: Entity) => entity.id === message.entityId);
        if (!entity) {
          logger.warn('core::prompts:formatPosts - no entity for', message.entityId);
        }
        // TODO: These are okay but not great
        const userName = entity?.names[0] || 'Unknown User';
        const displayName = entity?.names[0] || 'unknown';

        return `Name: ${userName} (@${displayName} EntityID:${message.entityId})
MessageID: ${message.id}${message.content.inReplyTo ? `\nIn reply to: ${message.content.inReplyTo}` : ''}
Source: ${message.content.source}
Date: ${formatTimestamp(message.createdAt)}
Text:
${message.content.text}`;
      });

    const header = conversationHeader ? `Conversation: ${roomId.slice(-5)}\n` : '';
    return `${header}${messageStrings.join('\n\n')}`;
  });

  return formattedPosts.join('\n\n');
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
  const messageStrings = messages
    .reverse()
    .filter((message: Memory) => message.entityId)
    .map((message: Memory) => {
      const messageText = (message.content as Content).text;

      const messageActions = (message.content as Content).actions;
      const messageThought = (message.content as Content).thought;
      const formattedName =
        entities.find((entity: Entity) => entity.id === message.entityId)?.names[0] ||
        'Unknown User';

      const attachments = (message.content as Content).attachments;

      const attachmentString =
        attachments && attachments.length > 0
          ? ` (Attachments: ${attachments
              .map((media) => {
                const lines = [`[${media.id} - ${media.title} (${media.url})]`];
                if (media.text) lines.push(`Text: ${media.text}`);
                if (media.description) lines.push(`Description: ${media.description}`);
                return lines.join('\n');
              })
              .join(
                // Use comma separator only if all attachments are single-line (no text/description)
                attachments.every((media) => !media.text && !media.description) ? ', ' : '\n'
              )})`
          : null;

      const messageTime = new Date(message.createdAt);
      const hours = messageTime.getHours().toString().padStart(2, '0');
      const minutes = messageTime.getMinutes().toString().padStart(2, '0');
      const timeString = `${hours}:${minutes}`;

      const timestamp = formatTimestamp(message.createdAt);

      // const shortId = message.entityId.slice(-5);

      const thoughtString = messageThought
        ? `(${formattedName}'s internal thought: ${messageThought})`
        : null;

      const timestampString = `${timeString} (${timestamp}) [${message.entityId}]`;
      const textString = messageText ? `${timestampString} ${formattedName}: ${messageText}` : null;
      const actionString =
        messageActions && messageActions.length > 0
          ? `${
              textString ? '' : timestampString
            } (${formattedName}'s actions: ${messageActions.join(', ')})`
          : null;

      // for each thought, action, text or attachment, add a new line, with text first, then thought, then action, then attachment
      const messageString = [textString, thoughtString, actionString, attachmentString]
        .filter(Boolean)
        .join('\n');

      return messageString;
    })
    .join('\n');
  return messageStrings;
};

export const formatTimestamp = (messageDate: number) => {
  const now = new Date();
  const diff = now.getTime() - messageDate;

  const absDiff = Math.abs(diff);
  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (absDiff < 60000) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
  if (hours < 24) {
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  }
  return `${days} day${days !== 1 ? 's' : ''} ago`;
};

const jsonBlockPattern = /```json\n([\s\S]*?)\n```/;

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
export function parseKeyValueXml(text: string): Record<string, any> | null {
  if (!text) return null;

  // First, try to find a specific <response> block (the one we actually want)
  // Use a more permissive regex to handle cases where there might be multiple XML blocks
  let xmlBlockMatch = text.match(/<response>([\s\S]*?)<\/response>/);
  let xmlContent: string;

  if (xmlBlockMatch) {
    xmlContent = xmlBlockMatch[1];
    logger.debug('Found response XML block');
  } else {
    // Fall back to finding any XML block (e.g., <response>...</response>)
    const fallbackMatch = text.match(/<(\w+)>([\s\S]*?)<\/\1>/);
    if (!fallbackMatch) {
      logger.warn('Could not find XML block in text');
      logger.debug('Text content:', text.substring(0, 200) + '...');
      return null;
    }
    xmlContent = fallbackMatch[2];
    logger.debug(`Found XML block with tag: ${fallbackMatch[1]}`);
  }

  const result: Record<string, any> = {};

  // Regex to find <key>value</key> patterns
  const tagPattern = /<([\w-]+)>([\s\S]*?)<\/([\w-]+)>/g;
  let match;

  while ((match = tagPattern.exec(xmlContent)) !== null) {
    // Ensure opening and closing tags match
    if (match[1] === match[3]) {
      const key = match[1];
      // Basic unescaping for common XML entities (add more as needed)
      const value = match[2]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();

      // Handle potential comma-separated lists for specific keys
      if (key === 'actions' || key === 'providers' || key === 'evaluators') {
        result[key] = value ? value.split(',').map((s) => s.trim()) : [];
      } else if (key === 'simple') {
        result[key] = value.toLowerCase() === 'true';
      } else {
        result[key] = value;
      }
    } else {
      logger.warn(`Mismatched XML tags found: <${match[1]}> and </${match[3]}>`);
      // Potentially skip this mismatched pair or return null depending on strictness needed
    }
  }

  // Return null if no key-value pairs were found
  if (Object.keys(result).length === 0) {
    logger.warn('No key-value pairs extracted from XML content');
    logger.debug('XML content was:', xmlContent.substring(0, 200) + '...');
    return null;
  }

  return result;
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
  let jsonData = null;
  const jsonBlockMatch = text.match(jsonBlockPattern);

  try {
    if (jsonBlockMatch) {
      // Parse the JSON from inside the code block
      jsonData = JSON.parse(normalizeJsonString(jsonBlockMatch[1].trim()));
    } else {
      // Try to parse the text directly if it's not in a code block
      jsonData = JSON.parse(normalizeJsonString(text.trim()));
    }
  } catch (_e) {
    // logger.warn("Could not parse text as JSON, returning null");
    return null; // Keep null return on error
  }

  // Ensure we have a non-null object that's not an array
  if (jsonData && typeof jsonData === 'object' && !Array.isArray(jsonData)) {
    return jsonData;
  }

  // logger.warn("Could not parse text as JSON object, returning null");
  return null; // Return null if not a valid object
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
  // Remove extra spaces after '{' and before '}'
  str = str.replace(/\{\s+/, '{').replace(/\s+\}/, '}').trim();

  // "key": unquotedValue → "key": "unquotedValue"
  str = str.replace(/("[\w\d_-]+")\s*: \s*(?!"|\[)([\s\S]+?)(?=(,\s*"|\}$))/g, '$1: "$2"');

  // "key": 'value' → "key": "value"
  str = str.replace(/"([^"]+)"\s*:\s*'([^']*)'/g, (_, key, value) => `"${key}": "${value}"`);

  // "key": someWord → "key": "someWord"
  str = str.replace(/("[\w\d_-]+")\s*:\s*([A-Za-z_]+)(?!["\w])/g, '$1: "$2"');

  return str;
};

// why is this here? maybe types.ts is more appropriate
// and shouldn't the name include x/twitter
/*
export type ActionResponse = {
  like: boolean;
  retweet: boolean;
  quote?: boolean;
  reply?: boolean;
};
*/

/**
 * Truncate text to fit within the character limit, ensuring it ends at a complete sentence.
 */
export function truncateToCompleteSentence(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  // Attempt to truncate at the last period within the limit
  const lastPeriodIndex = text.lastIndexOf('.', maxLength - 1);
  if (lastPeriodIndex !== -1) {
    const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
    if (truncatedAtPeriod.length > 0) {
      return truncatedAtPeriod;
    }
  }

  // If no period, truncate to the nearest whitespace within the limit
  const lastSpaceIndex = text.lastIndexOf(' ', maxLength - 1);
  if (lastSpaceIndex !== -1) {
    const truncatedAtSpace = text.slice(0, lastSpaceIndex).trim();
    if (truncatedAtSpace.length > 0) {
      return `${truncatedAtSpace}...`;
    }
  }

  // Fallback: Hard truncate and add ellipsis
  const hardTruncated = text.slice(0, maxLength - 3).trim();
  return `${hardTruncated}...`;
}

export async function splitChunks(content: string, chunkSize = 512, bleed = 20): Promise<string[]> {
  logger.debug('[splitChunks] Starting text split');

  const characterstoTokens = 3.5;

  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: Number(Math.floor(chunkSize * characterstoTokens)),
    chunkOverlap: Number(Math.floor(bleed * characterstoTokens)),
  });

  const chunks = await textSplitter.splitText(content);
  logger.debug('[splitChunks] Split complete:', {
    numberOfChunks: chunks.length,
    averageChunkSize: chunks.reduce((acc, chunk) => acc + chunk.length, 0) / chunks.length,
  });

  return chunks;
}

/**
 * Trims the provided text prompt to a specified token limit using a tokenizer model and type.
 */
export async function trimTokens(prompt: string, maxTokens: number, runtime: IAgentRuntime) {
  if (!prompt) throw new Error('Trim tokens received a null prompt');

  // if prompt is less than of maxtokens / 5, skip
  if (prompt.length < maxTokens / 5) return prompt;

  if (maxTokens <= 0) throw new Error('maxTokens must be positive');

  const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
    prompt,
  });

  // If already within limits, return unchanged
  if (tokens.length <= maxTokens) {
    return prompt;
  }

  // Keep the most recent tokens by slicing from the end
  const truncatedTokens = tokens.slice(-maxTokens);

  // Decode back to text
  return await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
    tokens: truncatedTokens,
  });
}

export function safeReplacer() {
  const seen = new WeakSet();
  return function (_key: string, value: any) {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

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
  if (!value) return false;

  const affirmative = ['YES', 'Y', 'TRUE', 'T', '1', 'ON', 'ENABLE'];
  const negative = ['NO', 'N', 'FALSE', 'F', '0', 'OFF', 'DISABLE'];

  const normalizedText = value.trim().toUpperCase();

  if (affirmative.includes(normalizedText)) {
    return true;
  }
  if (negative.includes(normalizedText)) {
    return false;
  }

  // For environment variables, we'll treat unrecognized values as false
  return false;
}

// UUID Utils

const uuidSchema = z.string().uuid() as z.ZodType<UUID>;

/**
 * Validates a UUID value.
 *
 * @param {unknown} value - The value to validate.
 * @returns {UUID | null} Returns the validated UUID value or null if validation fails.
 */
export function validateUuid(value: unknown): UUID | null {
  const result = uuidSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Converts a string or number to a UUID.
 *
 * @param {string | number} target - The string or number to convert to a UUID.
 * @returns {UUID} The UUID generated from the input target.
 * @throws {TypeError} Throws an error if the input target is not a string.
 */
export function stringToUuid(target: string | number): UUID {
  if (typeof target === 'number') {
    target = (target as number).toString();
  }

  if (typeof target !== 'string') {
    throw TypeError('Value must be string');
  }

  const _uint8ToHex = (ubyte: number): string => {
    const first = ubyte >> 4;
    const second = ubyte - (first << 4);
    const HEX_DIGITS = '0123456789abcdef'.split('');
    return HEX_DIGITS[first] + HEX_DIGITS[second];
  };

  const _uint8ArrayToHex = (buf: Uint8Array): string => {
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      out += _uint8ToHex(buf[i]);
    }
    return out;
  };

  const escapedStr = encodeURIComponent(target);
  const buffer = new Uint8Array(escapedStr.length);
  for (let i = 0; i < escapedStr.length; i++) {
    buffer[i] = escapedStr[i].charCodeAt(0);
  }

  const hash = sha1(buffer);
  const hashBuffer = new Uint8Array(hash.length / 2);
  for (let i = 0; i < hash.length; i += 2) {
    hashBuffer[i / 2] = Number.parseInt(hash.slice(i, i + 2), 16);
  }

  return `${_uint8ArrayToHex(hashBuffer.slice(0, 4))}-${_uint8ArrayToHex(hashBuffer.slice(4, 6))}-${_uint8ToHex(hashBuffer[6] & 0x0f)}${_uint8ToHex(hashBuffer[7])}-${_uint8ToHex((hashBuffer[8] & 0x3f) | 0x80)}${_uint8ToHex(hashBuffer[9])}-${_uint8ArrayToHex(hashBuffer.slice(10, 16))}` as UUID;
}

export const getContentTypeFromMimeType = (mimeType: string): ContentType | undefined => {
  if (mimeType.startsWith('image/')) return ContentType.IMAGE;
  if (mimeType.startsWith('video/')) return ContentType.VIDEO;
  if (mimeType.startsWith('audio/')) return ContentType.AUDIO;
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.startsWith('text/')) {
    return ContentType.DOCUMENT;
  }
  return undefined;
};

export function getLocalServerUrl(path: string): string {
  const port = process.env.SERVER_PORT || '3000';
  return `http://localhost:${port}${path}`;
}
