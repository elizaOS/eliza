import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import type {
	IAgentRuntime,
	Media,
	Memory,
	Provider,
	ProviderResult,
} from "../../../types/index.ts";
import { addHeader } from "../../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ATTACHMENTS");
const MAX_VISIBLE_ATTACHMENTS = 3;
const MAX_ATTACHMENT_MEMORY_LOOKBACK = 50;

type AttachmentWithCreatedAt = Media & {
	_createdAt?: number;
};

function mergeConversationAttachments(
	message: Memory,
	recentMessages: Memory[] | null | undefined,
): AttachmentWithCreatedAt[] {
	const attachmentsById = new Map<string, AttachmentWithCreatedAt>();

	const rememberAttachment = (attachment: Media, createdAt: number): void => {
		const existing = attachmentsById.get(attachment.id);
		if (existing && (existing._createdAt ?? 0) >= createdAt) {
			return;
		}
		attachmentsById.set(attachment.id, {
			...attachment,
			_createdAt: createdAt,
		});
	};

	for (const attachment of message.content.attachments ?? []) {
		rememberAttachment(attachment, message.createdAt ?? Date.now());
	}

	for (const recentMessage of recentMessages ?? []) {
		for (const attachment of recentMessage.content.attachments ?? []) {
			rememberAttachment(attachment, recentMessage.createdAt ?? Date.now());
		}
	}

	return Array.from(attachmentsById.values()).sort(
		(left, right) => (right._createdAt ?? 0) - (left._createdAt ?? 0),
	);
}

/**
 * Provides a list of attachments in the current conversation.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {Memory} message - The message memory object.
 * @returns {Object} The attachments values, data, and text.
 */
/**
 * Provides a list of attachments sent during the current conversation, including names, descriptions, and summaries.
 * @type {Provider}
 * @property {string} name - The name of the provider (ATTACHMENTS).
 * @property {string} description - Description of the provider.
 * @property {boolean} dynamic - Indicates if the provider is dynamic.
 * @property {function} get - Asynchronous function that retrieves attachments based on the runtime and message provided.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {Memory} message - The message object containing content and attachments.
 * @returns {Object} An object containing values, data, and text about the attachments retrieved.
 */
export const attachmentsProvider: Provider = {
	name: spec.name,
	description: spec.description,
	dynamic: spec.dynamic ?? true,
	contexts: ["media", "messaging"],
	contextGate: { anyOf: ["media", "messaging"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		try {
		const { roomId } = message;
		const conversationLength = Math.min(
			runtime.getConversationLength(),
			MAX_ATTACHMENT_MEMORY_LOOKBACK,
		);

		const recentMessagesData = await runtime.getMemories({
			roomId,
			limit: conversationLength,
			unique: false,
			tableName: "messages",
		});

		const allAttachments = mergeConversationAttachments(
			message,
			Array.isArray(recentMessagesData) ? recentMessagesData : [],
		);
		const visibleAttachments = allAttachments.slice(0, MAX_VISIBLE_ATTACHMENTS);
		const omittedCount = Math.max(
			0,
			allAttachments.length - visibleAttachments.length,
		);

		// Format attachments for display
		const formattedAttachments = visibleAttachments
			.map(
				(attachment) =>
					`ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${attachment.url}
    Type: ${attachment.source}
    Content Type: ${attachment.contentType ?? "unknown"}
    Stored Content: ${
			attachment.text || attachment.description
				? "available via READ_ATTACHMENT"
				: "none"
		}
    `,
			)
			.join("\n");
		const omissionNotice =
			omittedCount > 0
				? `Showing the ${visibleAttachments.length} most recent attachments. ${omittedCount} older attachment${omittedCount === 1 ? "" : "s"} omitted from context; use READ_ATTACHMENT to inspect one.`
				: "";

		// Create formatted text with header
		const text =
			formattedAttachments && formattedAttachments.length > 0
				? addHeader(
						"# Attachments",
						[formattedAttachments, omissionNotice].filter(Boolean).join("\n\n"),
					)
				: "";

		const values = {
			attachments: text,
		};
		const data = {
			attachments: allAttachments,
			visibleAttachments,
			omittedCount,
		};

			return {
				values,
				data,
				text,
			};
		} catch (error) {
			return {
				values: {
					attachments: "",
				},
				data: {
					attachments: [],
					visibleAttachments: [],
					omittedCount: 0,
					error: error instanceof Error ? error.message : String(error),
				},
				text: "",
			};
		}
	},
};
