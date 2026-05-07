/**
 * POST_TO_SOCIAL — generic action for posting to a social network.
 *
 * Mirrors the SEND_MESSAGE design: one canonical action that dispatches to
 * a platform connector by looking up its service in the runtime service
 * registry. Platform-specific quirks (character limits, reply formats,
 * threading) live inside each platform's service.
 *
 * Supported platforms:
 *   - x (Twitter/X)
 *   - bluesky
 *   - farcaster
 *   - nostr
 *
 * For platforms not yet wired up, the action returns a clear error rather
 * than silently failing.
 */
import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";

type SocialPlatform = "x" | "bluesky" | "farcaster" | "nostr";

const ALL_PLATFORMS: readonly SocialPlatform[] = [
	"x",
	"bluesky",
	"farcaster",
	"nostr",
] as const;

interface PostInput {
	platform: SocialPlatform;
	text: string;
	replyTo?: string;
}

function readOptions(
	options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
	const direct = (options ?? {}) as Record<string, unknown>;
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function normalizePlatform(value: unknown): SocialPlatform | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "twitter") return "x";
	if (trimmed === "bsky") return "bluesky";
	if (trimmed === "warpcast") return "farcaster";
	return (ALL_PLATFORMS as readonly string[]).includes(trimmed)
		? (trimmed as SocialPlatform)
		: null;
}

function inferPlatformFromText(text: string): SocialPlatform | null {
	const t = text.toLowerCase();
	if (/\b(twitter|tweet|x post|@x|on x\b)/i.test(t)) return "x";
	if (/\b(bluesky|bsky|skeet)\b/i.test(t)) return "bluesky";
	if (/\b(farcaster|warpcast|cast\b)/i.test(t)) return "farcaster";
	if (/\bnostr\b/i.test(t)) return "nostr";
	return null;
}

function readInput(
	message: Memory,
	options?: HandlerOptions | Record<string, unknown>,
): PostInput | null {
	const opts = readOptions(options);
	const platform =
		normalizePlatform(opts.platform ?? opts.target ?? opts.network) ??
		inferPlatformFromText(typeof message.content?.text === "string" ? message.content.text : "");
	if (!platform) return null;

	const text =
		typeof opts.text === "string" && opts.text.trim().length > 0
			? opts.text
			: typeof opts.body === "string" && opts.body.trim().length > 0
				? opts.body
				: typeof message.content?.text === "string"
					? message.content.text
					: "";
	if (!text.trim()) return null;
	const replyTo = typeof opts.replyTo === "string" ? opts.replyTo : undefined;

	return { platform, text, replyTo };
}

interface BlueskyPostService {
	createPost(text: string, replyTo?: { uri: string; cid: string }): Promise<{ uri?: string }>;
}

interface FarcasterCastService {
	createCast(params: {
		agentId: string;
		text: string;
		channelKey?: string | null;
		parentHash?: string;
	}): Promise<{ hash?: string }>;
}

interface NostrService {
	publishNote(text: string, tags?: string[][]): Promise<{ id?: string; eventId?: string }>;
}

interface XService {
	publishPost?(text: string, replyTo?: string): Promise<{ id?: string }>;
}

async function dispatchPost(
	runtime: IAgentRuntime,
	input: PostInput,
): Promise<{ id?: string; uri?: string; hash?: string; eventId?: string }> {
	switch (input.platform) {
		case "x": {
			const service = runtime.getService("x") as XService | null;
			if (!service?.publishPost) {
				throw new Error(
					"x service not available or does not implement publishPost. Install/enable plugin-x.",
				);
			}
			return service.publishPost(input.text, input.replyTo);
		}
		case "bluesky": {
			const service = runtime.getService("IPostService") as
				| BlueskyPostService
				| null;
			if (!service?.createPost) {
				throw new Error(
					"Bluesky post service not available. Install/enable plugin-bluesky.",
				);
			}
			return service.createPost(input.text);
		}
		case "farcaster": {
			const service = runtime.getService("ICastService") as
				| FarcasterCastService
				| null;
			if (!service?.createCast) {
				throw new Error(
					"Farcaster cast service not available. Install/enable plugin-farcaster.",
				);
			}
			return service.createCast({
				agentId: runtime.agentId,
				text: input.text,
				parentHash: input.replyTo,
			});
		}
		case "nostr": {
			const service = runtime.getService("nostr-service") as NostrService | null;
			if (!service?.publishNote) {
				throw new Error(
					"Nostr service not available. Install/enable plugin-nostr.",
				);
			}
			return service.publishNote(input.text);
		}
	}
}

export const postToSocialAction: Action = {
	name: "POST_TO_SOCIAL",
	description:
		"Publish a public post to a social network (X, Bluesky, Farcaster, Nostr). Platform is selected by the `platform` parameter (or inferred from the message text). Optional `replyTo` references the parent post id/uri/hash.",
	descriptionCompressed:
		"Post to social network: x, bluesky, farcaster, nostr.",
	similes: [],
	contexts: ["social_posting", "connectors"],
	contextGate: { anyOf: ["social_posting", "connectors"] },
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "platform",
			description: "Target social network: x, bluesky, farcaster, nostr.",
			required: false,
			schema: { type: "string", enum: [...ALL_PLATFORMS] },
		},
		{
			name: "text",
			description: "Post body. Falls back to the user message text when omitted.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "replyTo",
			description:
				"Parent post id (X tweet id), uri (Bluesky), hash (Farcaster), or event id (Nostr). Optional.",
			required: false,
			schema: { type: "string" },
		},
	],
	validate: async (runtime: IAgentRuntime, message: Memory) => {
		const text =
			typeof message.content?.text === "string" ? message.content.text : "";
		if (!text.trim()) return false;
		// Cheap intent check: must mention one of the platforms or use a verb
		// like post/tweet/cast/publish.
		return (
			inferPlatformFromText(text) !== null ||
			/\b(post|publish|tweet|cast|skeet|broadcast|share)\b/i.test(text)
		);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const input = readInput(message, options);
		if (!input) {
			const platforms = ALL_PLATFORMS.join(", ");
			const text = `POST_TO_SOCIAL needs a non-empty text and a platform (one of: ${platforms}).`;
			await callback?.({ text, source: message.content?.source });
			return {
				success: false,
				text,
				values: { error: "MISSING_INPUT" },
				data: { actionName: "POST_TO_SOCIAL", availablePlatforms: platforms },
			};
		}

		try {
			const result = await dispatchPost(runtime, input);
			const id =
				result.id ?? result.uri ?? result.hash ?? result.eventId ?? "";
			const text = id
				? `Posted to ${input.platform} (${id}).`
				: `Posted to ${input.platform}.`;
			await callback?.({ text, source: message.content?.source });
			return {
				success: true,
				text,
				data: {
					actionName: "POST_TO_SOCIAL",
					platform: input.platform,
					id,
					raw: result,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			await callback?.({
				text: `Failed to post to ${input.platform}: ${errorMessage}`,
				source: message.content?.source,
			});
			return {
				success: false,
				text: errorMessage,
				values: { error: "POST_FAILED" },
				data: { actionName: "POST_TO_SOCIAL", platform: input.platform },
			};
		}
	},
	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "Tweet 'shipping the new release today'" },
			},
			{
				name: "{{agentName}}",
				content: { text: "Posting to X.", actions: ["POST_TO_SOCIAL"] },
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Post to Bluesky: 'eliza is fully open source'" },
			},
			{
				name: "{{agentName}}",
				content: { text: "Posting to Bluesky.", actions: ["POST_TO_SOCIAL"] },
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Cast on Farcaster: 'gm /eliza'" },
			},
			{
				name: "{{agentName}}",
				content: { text: "Casting to Farcaster.", actions: ["POST_TO_SOCIAL"] },
			},
		],
	],
};
