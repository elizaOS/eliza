import { requestApi } from "./api";
import type { TwitterAuth } from "./auth";

export interface GrokConversation {
	data: {
		create_grok_conversation: {
			conversation_id: string;
		};
	};
}

export interface GrokRequest {
	responses: GrokResponseMessage[];
	systemPromptName: string;
	grokModelOptionId: string;
	conversationId: string;
	returnSearchResults: boolean;
	returnCitations: boolean;
	promptMetadata: {
		promptSource: string;
		action: string;
	};
	imageGenerationCount: number;
	requestFeatures: {
		eagerTweets: boolean;
		serverHistory: boolean;
	};
}

// Types for the user-facing API
export interface GrokMessage {
	role: "user" | "assistant";
	content: string;
}

export interface GrokChatOptions {
	messages: GrokMessage[];
	conversationId?: string; // Optional - will create new if not provided
	returnSearchResults?: boolean;
	returnCitations?: boolean;
}

// Internal types for API requests
export interface GrokResponseMessage {
	message: string;
	sender: 1 | 2; // 1 = user, 2 = assistant
	promptSource?: string;
	fileAttachments?: any[];
}

// Rate limit information
export interface GrokRateLimit {
	isRateLimited: boolean;
	message: string;
	upsellInfo?: {
		usageLimit: string;
		quotaDuration: string;
		title: string;
		message: string;
	};
}

export interface GrokChatResponse {
	conversationId: string;
	message: string;
	messages: GrokMessage[];
	webResults?: any[];
	metadata?: any;
	rateLimit?: GrokRateLimit;
}

/**
 * Creates a new conversation with Grok.
 * @returns The ID of the newly created conversation
 * @internal
 */
export async function createGrokConversation(
	auth: TwitterAuth,
): Promise<string> {
	const res = await requestApi<GrokConversation>(
		"https://x.com/i/api/graphql/6cmfJY3d7EPWuCSXWrkOFg/CreateGrokConversation",
		auth,
		"POST",
	);

	if (!res.success) {
		throw (res as any).err;
	}

	return res.value.data.create_grok_conversation.conversation_id;
}

/**
 * Main method for interacting with Grok in a chat-like manner.
 */
export async function grokChat(
	options: GrokChatOptions,
	auth: TwitterAuth,
): Promise<GrokChatResponse> {
	let { conversationId, messages } = options;

	// Create new conversation if none provided
	if (!conversationId) {
		conversationId = await createGrokConversation(auth);
	}

	// Convert OpenAI-style messages to Grok's internal format
	const responses: GrokResponseMessage[] = messages.map((msg: GrokMessage) => ({
		message: msg.content,
		sender: msg.role === "user" ? 1 : 2,
		...(msg.role === "user" && {
			promptSource: "",
			fileAttachments: [],
		}),
	}));

	const payload: GrokRequest = {
		responses,
		systemPromptName: "",
		grokModelOptionId: "grok-2a",
		conversationId,
		returnSearchResults: options.returnSearchResults ?? true,
		returnCitations: options.returnCitations ?? true,
		promptMetadata: {
			promptSource: "NATURAL",
			action: "INPUT",
		},
		imageGenerationCount: 4,
		requestFeatures: {
			eagerTweets: true,
			serverHistory: true,
		},
	};

	const res = await requestApi<{ text: string }>(
		"https://api.x.com/2/grok/add_response.json",
		auth,
		"POST",
		undefined,
		payload,
	);

	if (!res.success) {
		throw (res as any).err;
	}

	// Parse response chunks - Grok may return either a single response or multiple chunks
	let chunks: any[];
	if (res.value.text) {
		// For streaming responses, split text into chunks and parse each JSON chunk
		chunks = res.value.text
			.split("\n")
			.filter(Boolean)
			.map((chunk: any) => JSON.parse(chunk));
	} else {
		// For single responses (like rate limiting), wrap in array
		chunks = [res.value];
	}

	// Check if we hit rate limits by examining first chunk
	const firstChunk = chunks[0];
	if (firstChunk.result?.responseType === "limiter") {
		return {
			conversationId,
			message: firstChunk.result.message,
			messages: [
				...messages,
				{ role: "assistant", content: firstChunk.result.message },
			],
			rateLimit: {
				isRateLimited: true,
				message: firstChunk.result.message,
				upsellInfo: firstChunk.result.upsell
					? {
							usageLimit: firstChunk.result.upsell.usageLimit,
							quotaDuration: `${firstChunk.result.upsell.quotaDurationCount} ${firstChunk.result.upsell.quotaDurationPeriod}`,
							title: firstChunk.result.upsell.title,
							message: firstChunk.result.upsell.message,
						}
					: undefined,
			},
		};
	}

	// Combine all message chunks into single response
	const fullMessage = chunks
		.filter((chunk: any) => chunk.result?.message)
		.map((chunk: any) => chunk.result.message)
		.join("");

	// Return complete response with conversation history and metadata
	return {
		conversationId,
		message: fullMessage,
		messages: [...messages, { role: "assistant", content: fullMessage }],
		webResults: chunks.find((chunk: any) => chunk.result?.webResults)?.result
			.webResults,
		metadata: chunks[0],
	};
}
