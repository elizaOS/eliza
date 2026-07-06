/**
 * Assorted runtime helpers shared across the connector — message-service
 * lookup (`getMessageService`), Discord text normalisation
 * (`normalizeDiscordMessageText`), and outbound attachment building
 * (`buildOutboundDiscordAttachment`, which fetches remote media through the
 * SSRF guard).
 */
import {
	ContentType,
	fetchRemoteMedia,
	type IAgentRuntime,
	type IMessageService,
	isBlockedHostname,
	isPrivateIpAddress,
	logger,
	type Media,
	MediaFetchError,
	ModelType,
	type ReplyToMode,
	type SsrfPolicy,
	trimTokens,
} from "@elizaos/core";
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ChannelType,
	type Message as DiscordMessage,
	type MessageActionRowComponentBuilder,
	type MessageCreateOptions,
	PermissionsBitField,
	StringSelectMenuBuilder,
	type TextChannel,
	ThreadChannel,
} from "discord.js";
import type {
	DiscordActionRow,
	DiscordComponentOptions,
	JsonValue,
} from "./types";

export interface MessagingAPI {
	handleMessage?: (
		agentId: string,
		message: unknown,
		options?: { onResponse?: unknown },
	) => Promise<unknown>;
	sendMessage?: (
		agentId: string,
		message: unknown,
		options?: { onResponse?: unknown },
	) => Promise<unknown>;
}

interface RuntimeWithMessagingAPI extends IAgentRuntime {
	elizaOS: MessagingAPI;
}

export function hasMessagingAPI(
	runtime: IAgentRuntime,
): runtime is RuntimeWithMessagingAPI {
	return (
		"elizaOS" in runtime &&
		typeof (
			runtime as {
				elizaOS?: { handleMessage?: unknown; sendMessage?: unknown };
			}
		).elizaOS === "object" &&
		runtime.elizaOS !== null &&
		(typeof (runtime.elizaOS as { handleMessage?: unknown }).handleMessage ===
			"function" ||
			typeof (runtime.elizaOS as { sendMessage?: unknown }).sendMessage ===
				"function")
	);
}

export function hasMessageService(runtime: IAgentRuntime): boolean {
	return (
		runtime.messageService !== null &&
		typeof runtime.messageService?.handleMessage === "function"
	);
}

export function getMessagingAPI(runtime: IAgentRuntime): MessagingAPI | null {
	if (hasMessagingAPI(runtime)) {
		return runtime.elizaOS;
	}
	return null;
}

export function getMessageService(
	runtime: IAgentRuntime,
): IMessageService | null {
	if (hasMessageService(runtime)) {
		return runtime.messageService;
	}
	return null;
}

export const MAX_MESSAGE_LENGTH = 1900;

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenceMatch?.[1]?.trim() ?? trimmed;
}

export function parseJsonObjectFromText(
	text: string,
): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(stripJsonFence(text));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch (_error) {
		return null;
	}
	return null;
}

export function getActionParameters(options: unknown): Record<string, unknown> {
	const optionsRecord =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters = optionsRecord.parameters;
	if (
		parameters &&
		typeof parameters === "object" &&
		!Array.isArray(parameters)
	) {
		return parameters as Record<string, unknown>;
	}
	return optionsRecord;
}

export function parseJsonArrayFromText(text: string): JsonValue[] | null {
	try {
		const parsed = JSON.parse(stripJsonFence(text));
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(chunk): chunk is JsonValue =>
					typeof chunk === "string" ||
					typeof chunk === "number" ||
					typeof chunk === "boolean" ||
					chunk === null ||
					(Array.isArray(chunk) &&
						chunk.every(
							(item) =>
								typeof item === "string" ||
								typeof item === "number" ||
								typeof item === "boolean" ||
								item === null,
						)),
			);
		}
	} catch (_error) {
		return null;
	}
	return null;
}

function collectStructuredText(value: unknown, seen: Set<object>): string[] {
	if (typeof value === "string") {
		return value.trim() ? [value] : [];
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return [String(value)];
	}
	if (!value || typeof value !== "object") {
		return [];
	}
	if (seen.has(value)) {
		return [];
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectStructuredText(entry, seen));
	}

	const record = value as Record<string, unknown>;
	for (const key of ["text", "responseText", "message", "body"] as const) {
		const normalized = collectStructuredText(record[key], seen);
		if (normalized.length > 0) {
			return normalized;
		}
	}

	for (const key of [
		"content",
		"parts",
		"blocks",
		"items",
		"segments",
	] as const) {
		const normalized = collectStructuredText(record[key], seen);
		if (normalized.length > 0) {
			return normalized;
		}
	}

	for (const key of ["title", "summary"] as const) {
		const normalized = collectStructuredText(record[key], seen);
		if (normalized.length > 0) {
			return normalized;
		}
	}

	return [];
}

export function normalizeDiscordMessageText(value: unknown): string {
	const fragments = collectStructuredText(value, new Set())
		.map((fragment) => fragment.trim())
		.filter((fragment) => fragment.length > 0);
	if (fragments.length === 0) {
		return "";
	}
	return fragments.join("\n\n");
}

export function cleanUrl(url: string): string {
	let clean = url;

	clean = clean.replace(/\\([._\-~])/g, "$1");

	if (clean.startsWith("](")) {
		clean = clean.substring(2);
	} else {
		const markdownLinkPattern = /\]\(/;
		const markdownPatternIdx = clean.search(markdownLinkPattern);
		if (markdownPatternIdx > -1) {
			clean = clean.substring(0, markdownPatternIdx);
		}
	}

	let prev = "";
	while (prev !== clean) {
		prev = clean;
		clean = clean.replace(/[)\]>.,;!*_]+$/, "");
		clean = clean.replace(
			/[（）［］【】｛｝《》〈〉「」『』、。，．；：！？~～]+$/,
			"",
		);
	}

	return clean;
}

export function extractUrls(text: string, runtime?: IAgentRuntime): string[] {
	const urlRegex = /(https?:\/\/[^\s]+)/g;
	const rawUrls = text.match(urlRegex) || [];

	return rawUrls
		.map((url) => {
			const original = url;
			const clean = cleanUrl(url);

			if (runtime && original !== clean) {
				runtime.logger.debug(`URL cleaned: "${original}" -> "${clean}"`);
			}

			return clean;
		})
		.filter((url) => {
			try {
				new URL(url);
				return true;
			} catch {
				if (runtime) {
					runtime.logger.debug(`Invalid URL after cleanup, skipping: "${url}"`);
				}
				return false;
			}
		});
}

export function getAttachmentFileName(media: Media): string {
	let extension = "";
	try {
		const urlPath = new URL(media.url).pathname;
		const urlExtension = urlPath.substring(urlPath.lastIndexOf("."));
		if (urlExtension && urlExtension.length > 1 && urlExtension.length <= 5) {
			extension = urlExtension;
		}
	} catch {
		const lastDot = media.url.lastIndexOf(".");
		const queryStart = media.url.indexOf("?", lastDot);
		if (lastDot > 0 && (queryStart === -1 || queryStart > lastDot + 1)) {
			const potentialExt = media.url.substring(
				lastDot,
				queryStart > -1 ? queryStart : undefined,
			);
			if (potentialExt.length > 1 && potentialExt.length <= 5) {
				extension = potentialExt;
			}
		}
	}

	if (!extension && media.contentType) {
		const contentTypeMap: Record<string, string> = {
			image: ".png",
			video: ".mp4",
			audio: ".mp3",
			document: ".txt",
			link: ".html",
		};
		extension = contentTypeMap[media.contentType] || "";
	}

	if (!extension) {
		extension = ".txt";
	}

	const baseName = media.title || media.id || "attachment";
	const hasExtension = /\.\w{1,5}$/i.test(baseName);

	return hasExtension ? baseName : `${baseName}${extension}`;
}

const DEFAULT_OUTBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_OUTBOUND_ATTACHMENT_TIMEOUT_MS = 120_000;

function positiveIntEnv(name: string, fallback: number): number {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function shouldFetchGeneratedMediaBytes(media: Media): boolean {
	return (
		media.source === "media-generation" &&
		(media.contentType === ContentType.VIDEO ||
			media.contentType === ContentType.AUDIO)
	);
}

function summarizeAttachmentUrl(url: string): { host?: string; path?: string } {
	try {
		const parsed = new URL(url);
		return {
			host: parsed.host,
			path: parsed.pathname.split("/").slice(0, 4).join("/"),
		};
	} catch {
		return {};
	}
}

function generatedMediaFetchPolicy(url: string): SsrfPolicy | undefined {
	try {
		const host = new URL(url).hostname.trim().toLowerCase().replace(/\.$/, "");
		return host ? { allowedHostnames: [host] } : undefined;
	} catch {
		return undefined;
	}
}

function isPrivateOrInternalUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return isBlockedHostname(host) || isPrivateIpAddress(host);
	} catch {
		return true;
	}
}

/**
 * Build a Discord attachment. Generated audio/video URLs are fetched through
 * the core SSRF guard.
 */
export async function buildOutboundDiscordAttachment(
	media: Media,
	runtime?: Pick<IAgentRuntime, "logger">,
): Promise<AttachmentBuilder> {
	const fileName = getAttachmentFileName(media);
	const url = media.url?.trim();
	if (!url) {
		return new AttachmentBuilder(Buffer.alloc(0), { name: fileName });
	}

	if (!shouldFetchGeneratedMediaBytes(media)) {
		return new AttachmentBuilder(url, { name: fileName });
	}

	try {
		const fetched = await fetchRemoteMedia({
			url,
			filePathHint: fileName,
			maxBytes: positiveIntEnv(
				"DISCORD_ATTACHMENT_FETCH_MAX_BYTES",
				DEFAULT_OUTBOUND_ATTACHMENT_MAX_BYTES,
			),
			timeoutMs: positiveIntEnv(
				"DISCORD_ATTACHMENT_FETCH_TIMEOUT_MS",
				DEFAULT_OUTBOUND_ATTACHMENT_TIMEOUT_MS,
			),
			ssrfPolicy: generatedMediaFetchPolicy(url),
		});
		return new AttachmentBuilder(fetched.buffer, { name: fileName });
	} catch (error) {
		runtime?.logger.warn(
			{
				src: "plugin:discord:attachment",
				...summarizeAttachmentUrl(url),
				contentType: media.contentType,
				error:
					error instanceof MediaFetchError
						? error.code
						: error instanceof Error
							? error.name
							: String(error),
			},
			"Generated media fetch failed",
		);
		if (!isPrivateOrInternalUrl(url)) {
			return new AttachmentBuilder(url, { name: fileName });
		}
		throw error;
	}
}

export async function generateSummary(
	runtime: IAgentRuntime,
	text: string,
): Promise<{ title: string; description: string }> {
	text = await trimTokens(text, 100000, runtime);

	if (!text) {
		return {
			title: "",
			description: "",
		};
	}

	if (text.length < 1000) {
		return {
			title: "",
			description: text,
		};
	}

	runtime.logger.info(
		`[Summarization] Calling TEXT_SMALL for ${text.length} chars: "${text.substring(0, 50).replace(/\n/g, " ")}..."`,
	);

	const prompt = `Please generate a concise summary for the following text:

  Text: """
  ${text}
  """

  Respond with JSON only, no markdown:
  {
    "title": "Generated Title",
    "summary": "Generated summary and/or description of the text"
  }`;

	const response = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
	});

	const parsedResponse = parseJsonObjectFromText(response) as {
		title?: string;
		summary?: string;
	} | null;

	if (
		parsedResponse &&
		typeof parsedResponse.title === "string" &&
		typeof parsedResponse.summary === "string"
	) {
		return {
			title: parsedResponse.title,
			description: parsedResponse.summary,
		};
	}

	return {
		title: "",
		description: "",
	};
}

/**
 * Discord API error structure
 */
interface DiscordAPIError extends Error {
	code?: number;
}

/**
 * Type guard for Discord API errors
 */
function isDiscordAPIError(error: unknown): error is DiscordAPIError {
	return error instanceof Error && "code" in error;
}

function isReplyReferenceFailure(error: unknown): boolean {
	if (!isDiscordAPIError(error)) {
		return false;
	}

	const errorMessage = error.message.toLowerCase();
	return (
		error.code === 10008 ||
		errorMessage.includes("unknown message") ||
		errorMessage.includes("message reference") ||
		errorMessage.includes("message_reference")
	);
}

/**
 * Discord.js component with toJSON method
 */
interface DiscordJsComponent {
	toJSON(): JsonValue;
}

/**
 * Type guard for Discord.js components
 */
function isDiscordJsComponent(
	component: unknown,
): component is DiscordJsComponent {
	return (
		component !== null &&
		typeof component === "object" &&
		"toJSON" in component &&
		typeof (component as DiscordJsComponent).toJSON === "function"
	);
}

/**
 * Type guard for arrays of Discord.js components (ActionRowBuilder)
 */
function isDiscordJsComponentArray(
	components: unknown[],
): components is ActionRowBuilder<MessageActionRowComponentBuilder>[] {
	return components.length > 0 && components.every(isDiscordJsComponent);
}

/**
 * Safe JSON stringify that handles BigInt values
 */
function safeStringify(obj: unknown): string {
	return JSON.stringify(obj, (_, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
}

/**
 * Message send options for Discord
 */
interface MessageSendOptions {
	content: string;
	reply?: {
		messageReference: string;
	};
	files?: Array<
		AttachmentBuilder | { attachment: Buffer | string; name: string }
	>;
	components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/**
 * Convert the connector's neutral {@link DiscordActionRow} specs (produced by
 * `renderDiscordInteractions`) into discord.js `ActionRowBuilder`s ready to hand
 * to `channel.send`/`user.send`. Already-built discord.js rows pass through
 * untouched. Returns `undefined` when there is nothing renderable so callers can
 * omit the `components` key entirely.
 *
 * This is the SINGLE place button/select builders are assembled, shared by both
 * the guild send path (`sendMessageInChunks`) and the DM send path in
 * `messages.ts`. Keeping DMs on the same builder is the fix for #14527 — the DM
 * branch previously called `user.send({content, files})` with no components, so
 * a components-only reply rendered the "Choose an option:" fallback with zero
 * buttons.
 *
 * NOTE on Discord DM constraints: message components (action rows of buttons and
 * string selects — the only types this helper emits) ARE supported in DMs by
 * Discord's API, so no DM-specific degradation is required here. The types
 * Discord forbids in DMs are guild-scoped interaction surfaces (e.g. role/user
 * selects, type 5/6/7/8), which this connector does not emit. If such a type is
 * ever added, degrade it to a link-out or text fallback rather than dropping it
 * silently.
 */
export function buildDiscordComponents(
	components: DiscordActionRow[] | undefined,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] | undefined {
	if (!components || components.length === 0) {
		return undefined;
	}

	try {
		logger.info(`Components received: ${safeStringify(components)}`);

		if (!Array.isArray(components)) {
			logger.warn("Components is not an array, skipping component processing");
			return undefined;
		}

		if (isDiscordJsComponentArray(components)) {
			return components;
		}

		const discordComponents = (components as DiscordActionRow[])
			.map((row: DiscordActionRow) => {
				if (!row || typeof row !== "object" || row.type !== 1) {
					logger.warn("Invalid component row structure, skipping");
					return null;
				}

				const actionRow =
					new ActionRowBuilder<MessageActionRowComponentBuilder>();

				if (!Array.isArray(row.components)) {
					logger.warn("Row components is not an array, skipping");
					return null;
				}

				const validComponents = row.components
					.map((comp: DiscordComponentOptions) => {
						if (!comp || typeof comp !== "object") {
							logger.warn("Invalid component, skipping");
							return null;
						}

						try {
							if (comp.type === 2) {
								const button = new ButtonBuilder()
									.setLabel(comp.label || "")
									.setStyle(comp.style || 1);
								// Link-style buttons carry a URL and no custom_id.
								if (comp.url) {
									button.setURL(comp.url);
								} else {
									button.setCustomId(comp.custom_id);
								}
								return button;
							}

							if (comp.type === 3) {
								const selectMenu = new StringSelectMenuBuilder()
									.setCustomId(comp.custom_id)
									.setPlaceholder(comp.placeholder || "Select an option");

								if (typeof comp.min_values === "number") {
									selectMenu.setMinValues(comp.min_values);
								}
								if (typeof comp.max_values === "number") {
									selectMenu.setMaxValues(comp.max_values);
								}

								if (Array.isArray(comp.options)) {
									selectMenu.addOptions(
										comp.options.map((option) => ({
											label: option.label,
											value: option.value,
											description: option.description,
										})),
									);
								}

								return selectMenu;
							}
						} catch (err) {
							logger.error(`Error creating component: ${err}`);
							return null;
						}
						return null;
					})
					.filter(
						(component): component is ButtonBuilder | StringSelectMenuBuilder =>
							component !== null,
					);

				if (validComponents.length > 0) {
					actionRow.addComponents(validComponents);
					return actionRow;
				}
				return null;
			})
			.filter(
				(row): row is ActionRowBuilder<MessageActionRowComponentBuilder> =>
					row !== null,
			);

		return discordComponents.length > 0 ? discordComponents : undefined;
	} catch (error) {
		logger.error(`Error processing components: ${error}`);
		return undefined;
	}
}

export async function sendMessageInChunks(
	channel: TextChannel,
	content: string,
	inReplyTo: string,
	files: Array<
		AttachmentBuilder | { attachment: Buffer | string; name: string }
	>,
	components?: DiscordActionRow[],
	runtime?: IAgentRuntime,
	replyToMode: ReplyToMode = "first",
): Promise<DiscordMessage[]> {
	const sentMessages: DiscordMessage[] = [];
	let lastSendError: unknown = null;

	let messages: string[];
	if (
		runtime &&
		content.length > MAX_MESSAGE_LENGTH &&
		needsSmartSplit(content)
	) {
		messages = await smartSplitMessage(runtime, content);
	} else {
		messages = splitMessage(content);
	}
	if (
		messages.length === 0 &&
		((files && files.length > 0) || (components && components.length > 0))
	) {
		messages = [""];
	}
	try {
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			if (
				message.trim().length > 0 ||
				(i === messages.length - 1 && files && files.length > 0) ||
				(i === messages.length - 1 && components && components.length > 0)
			) {
				const options: MessageSendOptions = {
					content: message.trim(),
				};

				if (
					inReplyTo &&
					(replyToMode === "all" || (replyToMode === "first" && i === 0))
				) {
					options.reply = {
						messageReference: inReplyTo,
					};
				}

				if (i === messages.length - 1 && files && files.length > 0) {
					options.files = files;
				}

				if (i === messages.length - 1 && components && components.length > 0) {
					const built = buildDiscordComponents(components);
					if (built) {
						options.components = built;
					}
				}

				try {
					const m = await channel.send(options as MessageCreateOptions);
					sentMessages.push(m);
				} catch (error: unknown) {
					if (isReplyReferenceFailure(error) && options.reply) {
						logger.warn(
							"Message reference no longer valid (message may have been deleted). Sending without reply threading.",
						);
						const optionsWithoutReply = { ...options };
						delete optionsWithoutReply.reply;
						try {
							const m = await channel.send(
								optionsWithoutReply as MessageCreateOptions,
							);
							sentMessages.push(m);
						} catch (retryError: unknown) {
							const errorMessage =
								retryError instanceof Error
									? retryError.message
									: String(retryError);
							lastSendError = retryError;
							logger.error(
								`Error sending message after removing reply reference: ${errorMessage}`,
							);
							throw retryError;
						}
					} else {
						lastSendError = error;
						throw error;
					}
				}
			}
		}
	} catch (error) {
		lastSendError = error;
		logger.error(`Error sending message: ${error}`);
	}

	const attemptedSend =
		content.trim().length > 0 ||
		(files && files.length > 0) ||
		(components && components.length > 0);
	if (attemptedSend && sentMessages.length === 0) {
		if (lastSendError instanceof Error) {
			throw lastSendError;
		}
		throw new Error(
			"Discord message send completed without delivering any chunks",
		);
	}

	return sentMessages;
}

export function needsSmartSplit(content: string): boolean {
	const codeBlockCount = (content.match(/```/g) || []).length;
	if (codeBlockCount >= 2) {
		return true;
	}

	if (/^#{1,3}\s/m.test(content)) {
		return true;
	}

	if (/^\d+\.\s/m.test(content)) {
		return true;
	}

	const lines = content.split("\n");
	const hasLongUnbreakableLines = lines.some(
		(line) => line.length > 500 && !line.includes(". ") && !line.includes(", "),
	);
	if (hasLongUnbreakableLines) {
		return true;
	}

	return false;
}

export async function smartSplitMessage(
	runtime: IAgentRuntime,
	content: string,
	maxLength: number = MAX_MESSAGE_LENGTH,
): Promise<string[]> {
	if (content.length <= maxLength) {
		return [content];
	}

	const estimatedChunks = Math.ceil(content.length / (maxLength - 100));

	try {
		runtime.logger.debug(
			`Smart splitting ${content.length} chars into ~${estimatedChunks} chunks`,
		);

		const prompt = `Split the following text into ${estimatedChunks} parts for Discord messages (max ${maxLength} chars each).
Keep related content together (don't split code blocks, keep list items with their headers, etc.).
Return JSON only, no markdown or explanation.

Text to split:
"""
${content}
"""

Return format:
["chunk1", "chunk2"]`;

		const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });

		const parsed = parseJsonArrayFromText(response);
		if (Array.isArray(parsed)) {
			const validChunks = parsed.filter(
				(chunk: unknown): chunk is string =>
					typeof chunk === "string" &&
					chunk.trim().length > 0 &&
					chunk.length <= maxLength,
			);

			if (validChunks.length > 0) {
				return validChunks;
			}

			runtime.logger.debug(
				"Smart split returned empty or invalid chunks, falling back to simple split",
			);
		}
	} catch (error) {
		runtime.logger.debug(
			`Smart split failed, falling back to simple split: ${error}`,
		);
	}

	return splitMessage(content, maxLength);
}

export function splitMessage(
	content: string,
	maxLength: number = MAX_MESSAGE_LENGTH,
): string[] {
	if (!content || content.length <= maxLength) {
		return content ? [content] : [];
	}

	const messages: string[] = [];
	let currentMessage = "";

	const rawLines = content.split("\n");
	const lines = rawLines.flatMap((line) => {
		const chunks: string[] = [];
		while (line.length > maxLength) {
			let splitIdx = maxLength;
			const lastSpace = line.lastIndexOf(" ", maxLength);

			if (lastSpace > maxLength * 0.7) {
				splitIdx = lastSpace;
			} else if (lastSpace > maxLength * 0.3) {
				splitIdx = lastSpace;
			}

			chunks.push(line.slice(0, splitIdx));
			line = line.slice(splitIdx).trimStart();
		}
		chunks.push(line);
		return chunks;
	});

	for (const line of lines) {
		if (currentMessage.length + line.length + 1 > maxLength) {
			if (currentMessage.trim().length > 0) {
				messages.push(currentMessage.trim());
			}
			currentMessage = "";
		}
		currentMessage += `${line}\n`;
	}

	if (currentMessage.trim().length > 0) {
		messages.push(currentMessage.trim());
	}

	if (messages.length === 0 && content.length > 0) {
		messages.push(" ");
	}

	return messages;
}

export interface CanSendMessageResult {
	canSend: boolean;
	reason: string | null;
	missingPermissions?: bigint[];
}

type SendableChannel = TextChannel | ThreadChannel | { type: ChannelType };

export function canSendMessage(
	channel: SendableChannel | null | undefined,
): CanSendMessageResult {
	if (!channel) {
		return {
			canSend: false,
			reason: "No channel given",
		};
	}
	if (channel.type === ChannelType.DM) {
		return {
			canSend: true,
			reason: null,
		};
	}

	if (!("guild" in channel) || !channel.guild) {
		return {
			canSend: false,
			reason: "Not a guild channel",
		};
	}

	const guildChannel = channel as TextChannel | ThreadChannel;
	const botMember = guildChannel.guild.members.cache.get(
		guildChannel.client.user.id,
	);

	if (!botMember) {
		return {
			canSend: false,
			reason: "Bot member not found in guild",
		};
	}

	const requiredPermissions: bigint[] = [
		PermissionsBitField.Flags.ViewChannel,
		PermissionsBitField.Flags.SendMessages,
		PermissionsBitField.Flags.ReadMessageHistory,
	];

	if (guildChannel instanceof ThreadChannel) {
		requiredPermissions.push(PermissionsBitField.Flags.SendMessagesInThreads);
	}

	const permissions = guildChannel.permissionsFor(botMember);

	if (!permissions) {
		return {
			canSend: false,
			reason: "Could not retrieve permissions",
		};
	}

	const missingPermissions = requiredPermissions.filter(
		(perm) => !permissions.has(perm),
	);

	return {
		canSend: missingPermissions.length === 0,
		missingPermissions,
		reason:
			missingPermissions.length > 0
				? `Missing permissions: ${missingPermissions.map((p) => String(p)).join(", ")}`
				: null,
	};
}
