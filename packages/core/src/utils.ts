/**
 * Shared runtime helpers re-exported from `@elizaos/core`: prompt composition,
 * message/post formatting, structured-response parsing, and deterministic
 * identity.
 *
 * `composePrompt` / `composePromptFromState` render `{{binding}}` templates via
 * Handlebars — double-brace bindings are rewritten to triple-brace so values are
 * not HTML-escaped — and fall back to an eval-free replacer under a restricted
 * CSP (browser-extension) environment. `formatMessages` / `formatPosts` turn
 * `Memory[]` into the transcript the model reads. `parseKeyValueXml` (legacy
 * `<response>` XML), `parseToonKeyValue`, and `parseJSONObjectFromText` recover
 * structured fields from chatty model output, tolerating malformed input by
 * returning null rather than throwing.
 *
 * `stringToUuid` derives a deterministic, RFC-4122-shaped UUID from an arbitrary
 * string via an in-tree pure-JS SHA-1 (with a WebCrypto-backed cache), so the
 * same external id always maps to the same entity across Node and browser; it is
 * idempotent on an already-valid UUID. This module is also the barrel that
 * `export * from "./utils"` resolves to, so helpers under `utils/` that must be
 * reachable from the package are re-exported at the bottom.
 */
import Handlebars from "handlebars";
import z from "zod";

import logger from "./logger";
import { replaceIndexedNameTokens } from "./name-tokens";
import type { TemplateType } from "./types/agent";
import type { Entity } from "./types/environment";
import type { Memory } from "./types/memory";
import { ModelType } from "./types/model";
import { type Content, ContentType, type UUID } from "./types/primitives";
import type { IAgentRuntime } from "./types/runtime";
import type { State } from "./types/state";
import {
	buildDeterministicSeed,
	getDeterministicNames,
} from "./utils/deterministic";
import { extractAndParseJSONObjectFromText } from "./utils/json-llm";
import { RecursiveCharacterTextSplitter } from "./utils/recursive-character-text-splitter";
import { formatTimestamp as formatTimestampBase } from "./utils/time-format";

// Token / embedding budget constants
export const DEFAULT_MAX_CONVERSATION_TOKENS = 50_000;
/** Max tokens for embedding input text (default fallback) */
export const DEFAULT_MAX_EMBEDDING_TOKENS = 8_000;
/** Max character equivalent for embedding text (tokens * ~4 chars/token) */
export const DEFAULT_MAX_EMBEDDING_CHARS = DEFAULT_MAX_EMBEDDING_TOKENS * 4;
/** Default max tokens for the assembled prompt sent to the model */
export const DEFAULT_MAX_PROMPT_TOKENS = 128_000;

// Text Utils

/**
 * Detect if we're in a restricted CSP environment (browser extension)
 * where eval() and new Function() are not allowed.
 */
let _isRestrictedCSP: boolean | null = null;
const COMPILED_TEMPLATE_CACHE = new Map<
	string,
	Handlebars.TemplateDelegate<Record<string, unknown>>
>();
const COMPILED_TEMPLATE_CACHE_LIMIT = 256;

function isRestrictedCSPEnvironment(): boolean {
	if (_isRestrictedCSP !== null) return _isRestrictedCSP;

	// Check if we're in a browser extension context
	const isBrowserExtension =
		typeof globalThis !== "undefined" &&
		typeof (globalThis as Record<string, unknown>).chrome === "object" &&
		(globalThis as Record<string, unknown>).chrome !== null &&
		typeof (
			(globalThis as Record<string, unknown>).chrome as Record<string, unknown>
		)?.runtime === "object" &&
		typeof (
			(
				(globalThis as Record<string, unknown>).chrome as Record<
					string,
					unknown
				>
			)?.runtime as Record<string, unknown>
		)?.id === "string";

	if (isBrowserExtension) {
		_isRestrictedCSP = true;
		return true;
	}

	// Try to detect if eval is blocked by testing it
	try {
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		new Function("return 1");
		_isRestrictedCSP = false;
	} catch {
		_isRestrictedCSP = true;
	}

	return _isRestrictedCSP;
}

/**
 * CSP-safe simple template replacement function.
 * Handles basic {{variable}} and {{{variable}}} syntax without eval.
 * Does not support Handlebars helpers, conditionals, or loops.
 */
function simpleTemplateReplace(
	template: string,
	context: Record<string, unknown>,
): string {
	// First handle triple-brace (unescaped) - {{{varName}}}
	let result = template.replace(
		/\{\{\{([^{}]+)\}\}\}/g,
		(_match, varName: string) => {
			const key = varName.trim();
			const value = context[key];
			if (value === undefined || value === null) return "";
			return String(value);
		},
	);

	// Then handle double-brace - {{varName}}
	result = result.replace(/\{\{([^{}]+)\}\}/g, (_match, varName: string) => {
		const key = varName.trim();
		// Skip block helpers like {{#if}}, {{/if}}, {{else}}, {{>partial}}
		if (
			key.startsWith("#") ||
			key.startsWith("/") ||
			key.startsWith(">") ||
			key === "else"
		) {
			return "";
		}
		const value = context[key];
		if (value === undefined || value === null) return "";
		return String(value);
	});

	return result;
}

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
function upgradeDoubleToTriple(tpl: string) {
	return tpl.replace(
		// ────────╮ negative-LB: not already "{{{"
		//          │   {{     ─ opening braces
		//          │    ╰──── negative-LA: not {, #, /, !, >
		//          ▼
		/(?<!{){{(?![{#/!>])([\s\S]*?)}}/g,
		(_match: string, inner: string) => {
			// keep the block keyword {{else}} unchanged
			if (inner.trim() === "else") return `{{${inner}}}`;
			return `{{{${inner}}}}`;
		},
	);
}

function getCompiledTemplate(
	template: string,
): Handlebars.TemplateDelegate<Record<string, unknown>> {
	// Key by the raw template. upgradeDoubleToTriple is a pure function, so the
	// raw string maps 1:1 to its upgraded form — keying on the raw template lets
	// a cache hit skip the regex transform entirely (it only runs on a miss).
	const cached = COMPILED_TEMPLATE_CACHE.get(template);
	if (cached) {
		return cached;
	}

	const upgraded = upgradeDoubleToTriple(template);
	const compiled = Handlebars.compile(upgraded);
	COMPILED_TEMPLATE_CACHE.set(template, compiled);
	if (COMPILED_TEMPLATE_CACHE.size > COMPILED_TEMPLATE_CACHE_LIMIT) {
		const oldestKey = COMPILED_TEMPLATE_CACHE.keys().next().value;
		if (typeof oldestKey === "string") {
			COMPILED_TEMPLATE_CACHE.delete(oldestKey);
		}
	}

	return compiled;
}

function resolvePromptSeed(
	stateLike: Record<string, unknown>,
	stateValues?: Record<string, unknown>,
	stateData?: Record<string, unknown>,
): string {
	const normalizeSeedValue = (value: unknown): string | number | undefined => {
		if (typeof value === "string" || typeof value === "number") {
			return value;
		}
		return undefined;
	};

	return buildDeterministicSeed(
		normalizeSeedValue(stateValues?.__conversationSeed),
		normalizeSeedValue(stateData?.__conversationSeed),
		normalizeSeedValue(stateLike.__conversationSeed),
		normalizeSeedValue(stateValues?.agentName),
		normalizeSeedValue(stateLike.agentName),
		normalizeSeedValue(stateLike.roomId),
		"prompt",
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
	const templateStr =
		typeof template === "function" ? template({ state }) : template;

	let rendered: string;
	if (isRestrictedCSPEnvironment()) {
		// Use CSP-safe simple replacement (no eval)
		const upgraded = upgradeDoubleToTriple(templateStr);
		rendered = simpleTemplateReplace(upgraded, state);
	} else {
		const templateFunction = getCompiledTemplate(templateStr);
		rendered = templateFunction(state);
	}

	const output = composeRandomUser(rendered, 10, resolvePromptSeed(state));
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
	const templateStr =
		typeof template === "function" ? template({ state }) : template;

	// get any keys that are in state but are not named text, values or data
	const stateKeys = Object.keys(state);
	const filteredKeys = stateKeys.filter(
		(key) => !["text", "values", "data"].includes(key),
	);

	// this flattens out key/values in text/values/data
	const filteredState = filteredKeys.reduce(
		(acc: Record<string, unknown>, key) => {
			acc[key] = state[key];
			return acc;
		},
		{},
	);

	const context = { ...filteredState, ...state.values };

	let rendered: string;
	if (isRestrictedCSPEnvironment()) {
		// Use CSP-safe simple replacement (no eval)
		const upgraded = upgradeDoubleToTriple(templateStr);
		rendered = simpleTemplateReplace(upgraded, context);
	} else {
		const templateFunction = getCompiledTemplate(templateStr);
		rendered = templateFunction(context);
	}

	// and then we flat state.values again
	const output = composeRandomUser(
		rendered,
		10,
		resolvePromptSeed(filteredState, state.values, state.data),
	);
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
	return body.length > 0 ? `${header ? `${header}\n` : header}${body}\n` : "";
};

/**
 * Generates a string with random user names populated in a template.
 *
 * This function generates random user names and populates placeholders
 * in the provided template with these names. Placeholders in the template should follow the format
 * `{{nameX}}` or `{{userX}}`, where `X` is the position of the user.
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
const composeRandomUser = (
	template: string,
	length: number,
	seed = "prompt-users",
) => {
	// {{nameX}}/{{userX}} placeholders only appear in example-conversation
	// templates; production system/response templates have none. Skip the
	// deterministic-name generation entirely when no placeholder is present.
	if (!template.includes("{{name") && !template.includes("{{user")) {
		return template;
	}
	const exampleNames = getDeterministicNames(length, seed);
	return replaceIndexedNameTokens(template, exampleNames);
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
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));

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
		roomMessages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
	});

	// Sort rooms by the newest message's createdAt
	const sortedRooms = Object.entries(groupedMessages).sort(
		([, messagesA], [, messagesB]) => {
			const lastMessageB = messagesB[messagesB.length - 1];
			const lastMessageA = messagesA[messagesA.length - 1];
			return (lastMessageB?.createdAt || 0) - (lastMessageA?.createdAt || 0);
		},
	);

	const formattedPosts = sortedRooms.map(([roomId, roomMessages]) => {
		const messageStrings = roomMessages
			.filter((message: Memory) => message.entityId)
			.map((message: Memory) => {
				const entity = entityById.get(message.entityId);
				if (!entity) {
					logger.warn(
						{ src: "core:utils", entityId: message.entityId },
						"No entity found for message",
					);
				}
				// WHY: Multi-platform entities often have names only in metadata[source]; fallbacks avoid "Unknown User" everywhere.
				let userName = entity?.names?.[0];
				let displayName = entity?.names?.[0];
				if (
					!userName &&
					entity?.metadata &&
					typeof entity.metadata === "object"
				) {
					const source = message.content.source as string | undefined;
					const sourceMeta =
						source &&
						((entity.metadata as Record<string, unknown>)[source] as
							| { name?: string; userName?: string; username?: string }
							| undefined);
					if (sourceMeta) {
						userName =
							sourceMeta.name ?? sourceMeta.userName ?? sourceMeta.username;
						displayName =
							sourceMeta.userName ?? sourceMeta.username ?? sourceMeta.name;
					}
					if (!userName) {
						const meta = entity.metadata as Record<string, unknown>;
						userName =
							(meta.name as string) ??
							(meta.userName as string) ??
							(meta.username as string);
						displayName =
							(meta.userName as string) ??
							(meta.username as string) ??
							(meta.name as string);
					}
				}
				userName = userName || "Unknown User";
				displayName = displayName || "unknown";

				// WHY: Delimiters give the model clear message boundaries and reduce bleed-between in long context.
				return `Name: ${userName} (@${displayName} EntityID:${message.entityId})
MessageID: ${message.id}${message.content.inReplyTo ? `\nIn reply to: ${message.content.inReplyTo}` : ""}
Source: ${message.content.source}
Date: ${formatTimestamp(message.createdAt || 0)}

--- Text Start ---
${message.content.text ?? ""}
--- Text End ---`;
			});

		const header = conversationHeader
			? `Conversation: ${roomId.slice(-5)}\n`
			: "";
		return `${header}${messageStrings.join("\n\n")}`;
	});

	return formattedPosts.join("\n\n");
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
	const entityById = new Map(entities.map((entity) => [entity.id, entity]));
	const messageStrings: string[] = [];
	let remainingAttachmentContext = 3;
	let omittedAttachmentCount = 0;

	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (!message.entityId) {
			continue;
		}

		const messageText = (message.content as Content).text;
		const reactedMessageText = (message.content as Content).reactedMessageText;
		const messageActions = (message.content as Content).actions;
		const messageThought = (message.content as Content).thought;
		const foundEntity = entityById.get(message.entityId);
		const foundEntityNames = foundEntity?.names;
		const baseName = foundEntityNames?.[0] || "Unknown User";
		// Surface bot/agent-ness as plain context the model reads: a sender whose
		// message was stamped `fromBot` at ingestion renders as "Name (bot)". This
		// is the agent simply KNOWING a participant is a bot — part of what it knows
		// about that user — NOT a behavioral branch. Every message is still handled
		// through the one uniform path; the tag just lets the model read multi-bot
		// crosstalk for what it is instead of mistaking an overheard automated line
		// for a directive to itself. Degrades gracefully: a connector that omits
		// `fromBot` simply renders the bare name (untagged = treated as human).
		const senderIsBot =
			(message.metadata as { fromBot?: boolean } | undefined)?.fromBot ===
				true ||
			(message.content as { metadata?: { fromBot?: boolean } })?.metadata
				?.fromBot === true;
		const formattedName = senderIsBot ? `${baseName} (bot)` : baseName;

		const attachments = (message.content as Content).attachments;
		const visibleAttachments =
			attachments && attachments.length > 0
				? attachments.slice(0, Math.max(0, remainingAttachmentContext))
				: [];
		if (attachments && attachments.length > 0) {
			remainingAttachmentContext = Math.max(
				0,
				remainingAttachmentContext - visibleAttachments.length,
			);
			omittedAttachmentCount += attachments.length - visibleAttachments.length;
		}

		const attachmentString =
			visibleAttachments.length > 0
				? ` (Attachments: ${visibleAttachments
						.map((media) => {
							const lines = [`[${media.id} - ${media.title} (${media.url})]`];
							if (media.contentType) {
								lines.push(`Type: ${media.contentType}`);
							}
							// Keyed on text only: failed processing leaves text empty but
							// stores failure prose in description, which must not advertise
							// an unsatisfiable ATTACHMENT read.
							if (media.text) {
								lines.push(
									"Stored content available via ATTACHMENT action=read",
								);
							}
							return lines.join("\n");
						})
						.join(
							// Use comma separator only if all attachments are single-line (no text/description)
							visibleAttachments.every(
								(media) =>
									!media.text && !media.description && !media.contentType,
							)
								? ", "
								: "\n",
						)})`
				: null;

		const messageTime = new Date(message.createdAt || 0);
		const hours = messageTime.getHours().toString().padStart(2, "0");
		const minutes = messageTime.getMinutes().toString().padStart(2, "0");
		const timeString = `${hours}:${minutes}`;

		const timestamp = formatTimestamp(message.createdAt || 0);

		const thoughtString = messageThought
			? `(${formattedName}'s internal thought: ${messageThought})`
			: null;

		const timestampString = `${timeString} (${timestamp}) [${message.entityId}]`;
		const textString = messageText
			? `${timestampString} ${formattedName}: ${messageText}`
			: null;
		// A reaction message's `text` is a short stub that truncates the reacted-to
		// content; surface the full original so the planner reads the complete
		// statement and does not back-rationalize a truncated fragment (#9874).
		const reactedContextString =
			typeof reactedMessageText === "string" && reactedMessageText.trim()
				? `(reacted-to message in full: "${reactedMessageText.trim()}")`
				: null;
		const actionString =
			messageActions && messageActions.length > 0
				? `${
						textString ? "" : timestampString
					} (${formattedName}'s actions: ${messageActions.join(", ")})`
				: null;

		const messageString = [
			textString,
			reactedContextString,
			thoughtString,
			actionString,
			attachmentString,
		]
			.filter(Boolean)
			.join("\n");

		messageStrings.push(messageString);
	}

	const formattedMessages = messageStrings.join("\n");
	if (omittedAttachmentCount === 0) {
		return formattedMessages;
	}

	return [
		formattedMessages,
		`Note: ${omittedAttachmentCount} older attachment${omittedAttachmentCount === 1 ? "" : "s"} omitted from context. Use ATTACHMENT action=read to inspect additional attachments.`,
	]
		.filter(Boolean)
		.join("\n");
};

export const formatTimestamp = formatTimestampBase;

function parseStructuredResponseFence(text: string): string {
	const trimmed = text.trim();
	const match = /^```(?:toon|text)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	return match?.[1]?.trim() ?? trimmed;
}

function parseToonScalar(value: string): unknown {
	if (!value) return "";
	if (value === "null") return null;
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("[") && value.endsWith("]")) ||
		(value.startsWith("{") && value.endsWith("}"))
	) {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

/**
 * Parses the simple TOON key-value shape used by generated plugin prompts.
 *
 * Supported fields are `key: value` and indexed arrays like
 * `items[0]: value`. Values stay as strings unless they are JSON literals,
 * which preserves large IDs such as Discord snowflakes.
 */
export function parseToonKeyValue<T = Record<string, unknown>>(
	text: string,
): T | null {
	const body = parseStructuredResponseFence(text);
	if (!body) return null;

	const result: Record<string, unknown> = {};
	let found = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const match = /^([A-Za-z_][\w.-]*)(?:\[(\d+)\])?\s*:\s*(.*)$/.exec(line);
		if (!match) continue;

		found = true;
		const [, key, arrayIndex, rawValue] = match;
		const value = parseToonScalar(rawValue.trim());
		if (arrayIndex === undefined) {
			result[key] = value;
			continue;
		}

		const index = Number.parseInt(arrayIndex, 10);
		const current = result[key];
		const values = Array.isArray(current) ? current : [];
		values[index] = value;
		result[key] = values;
	}

	return found ? (result as T) : null;
}

/**
 * Legacy structured-response parser.
 *
 * Prefer JSON structured output for new prompts. This compatibility helper keeps
 * older XML-based cloud prompts working while native tool-calling migration
 * finishes those surfaces.
 */
export function parseKeyValueXml<T = Record<string, unknown>>(
	// audit:allowlist - retained for cloud/ XML evaluators
	text: string,
): T | null {
	if (!text) return null;

	let xmlContent: string | null = null;
	const responseStart = text.indexOf("<response>");
	if (responseStart !== -1) {
		const contentStart = responseStart + "<response>".length;
		const responseEnd = text.indexOf("</response>", contentStart);
		if (responseEnd !== -1) {
			xmlContent = text.slice(contentStart, responseEnd);
		}
	}

	if (!xmlContent) {
		const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;
		const looksLikeXml = /<[/!?A-Za-z_][^>\n]*>/.test(safeText);
		if (!looksLikeXml) {
			return null;
		}

		const firstBlock = findFirstXmlBlock(text); // audit:allowlist - helper for parseKeyValueXml
		if (!firstBlock) {
			logger.warn({ src: "core:utils" }, "Could not find XML block in text");
			return null;
		}
		xmlContent = firstBlock.content;
	}

	const result: Record<string, unknown> = {};
	for (const { key, value } of extractDirectXmlChildren(xmlContent)) {
		if (key === "actions" || key === "providers" || key === "evaluators") {
			const singularTag = key.replace(/s$/, "");
			const hasXmlTags =
				value && new RegExp(`<${singularTag}[\\s>/]`).test(value);
			result[key] = hasXmlTags
				? value
				: value
					? value.split(",").map((entry) => entry.trim())
					: [];
		} else {
			result[key] = value;
		}
	}

	if (Object.keys(result).length === 0) {
		logger.warn(
			{ src: "core:utils" },
			"No key-value pairs extracted from XML content",
		);
		return null;
	}

	return result as T;
}

function findFirstXmlBlock(
	// audit:allowlist - helper for parseKeyValueXml (legacy XML parser, retained for cloud/)
	input: string,
): { tag: string; content: string } | null {
	let i = 0;
	const length = input.length;
	while (i < length) {
		const openIdx = input.indexOf("<", i);
		if (openIdx === -1) break;
		if (
			input.startsWith("</", openIdx) ||
			input.startsWith("<!--", openIdx) ||
			input.startsWith("<?", openIdx)
		) {
			i = openIdx + 1;
			continue;
		}

		const tagInfo = readXmlStartTag(input, openIdx);
		if (!tagInfo || tagInfo.selfClosing) {
			i = (tagInfo?.end ?? openIdx) + 1;
			continue;
		}

		const closeIdx = findMatchingXmlClose(input, tagInfo.tag, tagInfo.end + 1);
		if (closeIdx !== -1) {
			return {
				tag: tagInfo.tag,
				content: input.slice(tagInfo.end + 1, closeIdx),
			};
		}
		i = tagInfo.end + 1;
	}
	return null;
}

function extractDirectXmlChildren(
	input: string,
): Array<{ key: string; value: string }> {
	const pairs: Array<{ key: string; value: string }> = [];
	let i = 0;
	const length = input.length;
	while (i < length) {
		const openIdx = input.indexOf("<", i);
		if (openIdx === -1) break;
		if (
			input.startsWith("</", openIdx) ||
			input.startsWith("<!--", openIdx) ||
			input.startsWith("<?", openIdx)
		) {
			i = openIdx + 1;
			continue;
		}

		const tagInfo = readXmlStartTag(input, openIdx);
		if (!tagInfo || tagInfo.selfClosing) {
			i = (tagInfo?.end ?? openIdx) + 1;
			continue;
		}

		const closeIdx = findMatchingXmlClose(input, tagInfo.tag, tagInfo.end + 1);
		if (closeIdx === -1) {
			i = tagInfo.end + 1;
			continue;
		}

		const innerRaw = input.slice(tagInfo.end + 1, closeIdx);
		pairs.push({
			key: tagInfo.tag,
			value: unescapeBasicXmlEntities(innerRaw).trim(),
		});
		i = closeIdx + `</${tagInfo.tag}>`.length;
	}
	return pairs;
}

function readXmlStartTag(
	input: string,
	openIdx: number,
): { tag: string; end: number; selfClosing: boolean } | null {
	let j = openIdx + 1;
	let tag = "";
	while (j < input.length) {
		const ch = input[j];
		if (/^[A-Za-z0-9_-]$/.test(ch)) {
			tag += ch;
			j += 1;
			continue;
		}
		break;
	}
	if (!tag) return null;
	const end = input.indexOf(">", j);
	if (end === -1) return null;
	return {
		tag,
		end,
		selfClosing: /\/\s*>$/.test(input.slice(openIdx, end + 1)),
	};
}

function findMatchingXmlClose(
	input: string,
	tag: string,
	start: number,
): number {
	const closeSeq = `</${tag}>`;
	let depth = 1;
	let cursor = start;
	while (depth > 0 && cursor < input.length) {
		const nextOpen = input.indexOf(`<${tag}`, cursor);
		const nextClose = input.indexOf(closeSeq, cursor);
		if (nextClose === -1) return -1;
		if (nextOpen !== -1 && nextOpen < nextClose) {
			const nestedTag = readXmlStartTag(input, nextOpen);
			if (!nestedTag) return -1;
			// Only a tag whose name EXACTLY matches nests depth. `indexOf(`<${tag}`)`
			// also matches prefix-extensions (e.g. `<textarea>` while closing
			// `<text>`), which used to inflate depth so the real close was never
			// found — the field was dropped and a bogus key promoted. On a mismatch
			// just skip past this open tag and keep scanning.
			if (nestedTag.tag === tag && !nestedTag.selfClosing) {
				depth += 1;
			}
			cursor = nestedTag.end + 1;
		} else {
			depth -= 1;
			if (depth === 0) return nextClose;
			cursor = nextClose + closeSeq.length;
		}
	}
	return -1;
}

function unescapeBasicXmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

/**
 * Parses a JSON object from text (code block or raw). Uses JSON5 so LLM output with
 * trailing commas, unquoted keys, or single quotes still parses (why: strict JSON often fails on model output).
 * Returns null on parse failure so one bad block doesn't crash the flow.
 *
 * @param text - The input text from which to extract and parse the JSON object.
 * @returns An object parsed from the JSON string if successful; otherwise null.
 * @throws Will throw an error if parsing fails and cannot extract a valid JSON object.
 */
export function parseJSONObjectFromText(
	text: string,
): Record<string, unknown> | null {
	try {
		const result = extractAndParseJSONObjectFromText(text);
		if (!result) {
			return null;
		}
		if (Array.isArray(result)) {
			return null;
		}
		return result;
	} catch (_error) {
		return null;
	}
}

/**
 * Truncate text to fit within the character limit, ensuring it ends at a complete sentence.
 */
export function truncateToCompleteSentence(
	text: string,
	maxLength: number,
): string {
	if (text.length <= maxLength) {
		return text;
	}

	// Attempt to truncate at the last period within the limit
	const lastPeriodIndex = text.lastIndexOf(".", maxLength - 1);
	if (lastPeriodIndex !== -1) {
		const truncatedAtPeriod = text.slice(0, lastPeriodIndex + 1).trim();
		if (truncatedAtPeriod.length > 0) {
			return truncatedAtPeriod;
		}
	}

	// If no period, truncate to the nearest whitespace within the limit
	const lastSpaceIndex = text.lastIndexOf(" ", maxLength - 1);
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

export async function splitChunks(
	content: string,
	chunkSize = 512,
	bleed = 20,
): Promise<string[]> {
	const characterstoTokens = 3.5;

	const textSplitter = new RecursiveCharacterTextSplitter({
		chunkSize: Number(Math.floor(chunkSize * characterstoTokens)),
		chunkOverlap: Number(Math.floor(bleed * characterstoTokens)),
	});

	const chunks = await textSplitter.splitText(content);

	return chunks;
}

/**
 * Trims the provided text prompt to a specified token limit using a tokenizer model and type.
 */
export async function trimTokens(
	prompt: string,
	maxTokens: number,
	runtime: IAgentRuntime,
) {
	if (!prompt) throw new Error("Trim tokens received a null prompt");

	// if prompt is less than of maxtokens / 5, skip
	if (prompt.length < maxTokens / 5) return prompt;

	if (maxTokens <= 0) throw new Error("maxTokens must be positive");

	const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
		prompt,
		modelType: ModelType.TEXT_TOKENIZER_ENCODE,
	});

	// If already within limits, return unchanged
	if (tokens.length <= maxTokens) {
		return prompt;
	}

	// Keep the most recent tokens by slicing from the end
	const truncatedTokens = tokens.slice(-maxTokens);

	// Decode back to text
	return runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
		tokens: truncatedTokens,
		modelType: ModelType.TEXT_TOKENIZER_DECODE,
	});
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
export function parseBooleanFromText(
	value: string | boolean | undefined | null,
): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value === "boolean") return value;

	const affirmative = ["YES", "Y", "TRUE", "T", "1", "ON", "ENABLE"];
	const negative = ["NO", "N", "FALSE", "F", "0", "OFF", "DISABLE"];

	const normalizedText = value.trim().toUpperCase();
	if (affirmative.includes(normalizedText)) return true;
	if (negative.includes(normalizedText)) return false;
	return false;
}

// UUID Utils

const uuidSchema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		"Invalid UUID format",
	) as z.ZodType<UUID>;

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
	if (typeof target === "number") {
		target = target.toString();
	}

	if (typeof target !== "string") {
		throw TypeError("Value must be string");
	}

	// If already a UUID, return as-is to avoid re-hashing
	const maybeUuid = validateUuid(target);
	if (maybeUuid) return maybeUuid;

	const escapedStr = encodeURIComponent(target);

	// Deterministic UUID derived from SHA-1(escapedStr)
	// Use WebCrypto if available (sync via cache), otherwise pure JS
	const digest = getCachedSha1(escapedStr); // 20 bytes
	const bytes = digest.slice(0, 16);

	// Set RFC4122 variant bits: 10xxxxxx
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	// Set custom version nibble to 0x0 (custom elizaOS UUID format)
	bytes[6] = (bytes[6] & 0x0f) | 0x00;

	return bytesToUuid(bytes) as UUID;
}

/**
 * Pre-warm the SHA-1 cache with common values using WebCrypto
 * Call this during initialization to improve performance
 */
export async function prewarmUuidCache(values: string[]): Promise<void> {
	if (!checkWebCrypto()) return;

	const promises = values.map(async (value) => {
		const escapedStr = encodeURIComponent(value);
		const digest = await sha1BytesAsync(escapedStr);
		sha1Cache.set(escapedStr, digest);
	});

	await Promise.all(promises);
}

// Cache for SHA-1 digests to enable synchronous WebCrypto usage
const sha1Cache = new Map<string, Uint8Array>();
let webCryptoAvailable: boolean | null = null;

/**
 * Check if WebCrypto is available for SHA-1
 */
function checkWebCrypto(): boolean {
	if (webCryptoAvailable !== null) return webCryptoAvailable;

	// Check for crypto.subtle (WebCrypto API)
	if (
		typeof globalThis !== "undefined" &&
		globalThis.crypto &&
		globalThis.crypto.subtle &&
		typeof globalThis.crypto.subtle.digest === "function"
	) {
		webCryptoAvailable = true;
		return true;
	}

	webCryptoAvailable = false;
	return false;
}

/**
 * Get SHA-1 digest using cache for synchronous operation
 * Uses WebCrypto when available (via background pre-computation), falls back to pure JS
 */
function getCachedSha1(message: string): Uint8Array {
	// Check cache first
	const cached = sha1Cache.get(message);
	if (cached) return cached;

	// Use synchronous pure JS implementation for immediate result
	const digest = sha1Bytes(message);
	sha1Cache.set(message, digest);

	// Asynchronously compute with WebCrypto for next time (if available)
	if (checkWebCrypto()) {
		sha1BytesAsync(message).then((webDigest) => {
			// Update cache with WebCrypto result (should be identical)
			sha1Cache.set(message, webDigest);
		});
	}

	// Limit cache size to prevent memory leaks
	if (sha1Cache.size > 10000) {
		// Remove oldest entries (first ones in iteration order)
		const keysToDelete = Array.from(sha1Cache.keys()).slice(0, 5000);
		for (const key of keysToDelete) {
			sha1Cache.delete(key);
		}
	}

	return digest;
}

/**
 * Async SHA-1 using WebCrypto when available
 * This can be used to pre-warm the cache
 */
async function sha1BytesAsync(message: string): Promise<Uint8Array> {
	if (checkWebCrypto()) {
		const encoder = new TextEncoder();
		const data = encoder.encode(message);
		const hashBuffer = await globalThis.crypto.subtle.digest("SHA-1", data);
		return new Uint8Array(hashBuffer);
	}

	// Fallback to pure JS implementation
	return sha1Bytes(message);
}

/**
 * Minimal SHA-1 implementation returning raw bytes.
 * Source adapted from public-domain references for portability (browser/Node).
 * Used as fallback when WebCrypto is not available.
 */
function sha1Bytes(message: string): Uint8Array {
	const bytes = utf8Encode(message);
	const ml = bytes.length;

	// Pre-processing (padding)
	const withOne = new Uint8Array(((ml + 9 + 63) >>> 6) << 6); // multiple of 64
	withOne.set(bytes);
	withOne[ml] = 0x80;
	const bitLen = ml * 8;
	// Append length as 64-bit big-endian
	const dv = new DataView(withOne.buffer);
	dv.setUint32(withOne.length - 4, bitLen >>> 0, false);
	dv.setUint32(withOne.length - 8, Math.floor(bitLen / 2 ** 32) >>> 0, false);

	// Initialize hash values
	let h0 = 0x67452301;
	let h1 = 0xefcdab89;
	let h2 = 0x98badcfe;
	let h3 = 0x10325476;
	let h4 = 0xc3d2e1f0;

	const w = new Uint32Array(80);

	for (let i = 0; i < withOne.length; i += 64) {
		// Break chunk into sixteen 32-bit big-endian words
		for (let j = 0; j < 16; j++) {
			w[j] = dv.getUint32(i + j * 4, false);
		}
		// Extend to 80 words
		for (let j = 16; j < 80; j++) {
			const t = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
			w[j] = (t << 1) | (t >>> 31);
		}

		// Initialize working vars
		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;

		for (let j = 0; j < 80; j++) {
			let f: number;
			let k: number;
			if (j < 20) {
				f = (b & c) | (~b & d);
				k = 0x5a827999;
			} else if (j < 40) {
				f = b ^ c ^ d;
				k = 0x6ed9eba1;
			} else if (j < 60) {
				f = (b & c) | (b & d) | (c & d);
				k = 0x8f1bbcdc;
			} else {
				f = b ^ c ^ d;
				k = 0xca62c1d6;
			}
			const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
			e = d;
			d = c;
			c = ((b << 30) | (b >>> 2)) >>> 0;
			b = a;
			a = temp;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
	}

	const out = new Uint8Array(20);
	const outDv = new DataView(out.buffer);
	outDv.setUint32(0, h0, false);
	outDv.setUint32(4, h1, false);
	outDv.setUint32(8, h2, false);
	outDv.setUint32(12, h3, false);
	outDv.setUint32(16, h4, false);
	return out;
}

function utf8Encode(str: string): Uint8Array {
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(str);
	}
	// Fallback
	const utf8: number[] = [];
	for (let i = 0; i < str.length; i++) {
		const charcode = str.charCodeAt(i);
		if (charcode < 0x80) utf8.push(charcode);
		else if (charcode < 0x800) {
			utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
		} else if (charcode < 0xd800 || charcode >= 0xe000) {
			utf8.push(
				0xe0 | (charcode >> 12),
				0x80 | ((charcode >> 6) & 0x3f),
				0x80 | (charcode & 0x3f),
			);
		} else {
			// surrogate pair
			i++;
			// UTF-16 to Unicode code point
			const codePoint =
				0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
			utf8.push(
				0xf0 | (codePoint >> 18),
				0x80 | ((codePoint >> 12) & 0x3f),
				0x80 | ((codePoint >> 6) & 0x3f),
				0x80 | (codePoint & 0x3f),
			);
		}
	}
	return new Uint8Array(utf8);
}

function bytesToUuid(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const h = bytes[i].toString(16).padStart(2, "0");
		hex.push(h);
	}
	// Format: 8-4-4-4-12 hexadecimal digits
	return (
		hex.slice(0, 4).join("") +
		"-" +
		hex.slice(4, 6).join("") +
		"-" +
		hex.slice(6, 8).join("") +
		"-" +
		hex.slice(8, 10).join("") +
		"-" +
		hex.slice(10, 16).join("")
	);
}

export const getContentTypeFromMimeType = (
	mimeType: string,
): ContentType | undefined => {
	if (mimeType.startsWith("image/")) return ContentType.IMAGE;
	if (mimeType.startsWith("video/")) return ContentType.VIDEO;
	if (mimeType.startsWith("audio/")) return ContentType.AUDIO;
	if (
		mimeType.includes("pdf") ||
		mimeType.includes("document") ||
		mimeType.startsWith("text/")
	) {
		return ContentType.DOCUMENT;
	}
	return undefined;
};

export {
	resolveActionContexts,
	resolveProviderContexts,
} from "./utils/context-catalog";
export {
	AVAILABLE_CONTEXTS_STATE_KEY,
	attachAvailableContexts,
	CONTEXT_ROUTING_METADATA_KEY,
	CONTEXT_ROUTING_STATE_KEY,
	type ContextRoutingDecision,
	deriveAvailableContexts,
	getActiveRoutingContexts,
	getActiveRoutingContextsForTurn,
	getContextRoutingFromMessage,
	getContextRoutingFromState,
	inferContextRoutingFromMessage,
	inferContextRoutingFromText,
	mergeContextRouting,
	parseContextList,
	parseContextRoutingMetadata,
	setContextRoutingMetadata,
	shouldIncludeByContext,
} from "./utils/context-routing";
export { extractAndParseJSONObjectFromText } from "./utils/json-llm";
export {
	extractUserText,
	getUserMessageText,
	hasDocumentAugmentationEnvelope,
	normalizeUserMessageText,
	stripAugmentationForPersistence,
} from "./utils/message-text";
// `export * from "./utils"` (in index.node.ts etc.) resolves to this file, not
// to a `./utils/index.ts`. Any helper in the `utils/` directory that needs to be
// reachable from `@elizaos/core` must be re-exported here.
export { getLocalServerUrl } from "./utils/node";
export {
	isSyntheticConversationArtifactMemory,
	isSyntheticConversationArtifactText,
} from "./utils/synthetic-conversation-artifact";
export { extractFirstSentence, hasFirstSentence } from "./utils/text-splitting";
