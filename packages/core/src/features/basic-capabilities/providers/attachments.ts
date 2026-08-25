/**
 * The ATTACHMENTS provider for the basic-capabilities bundle: it injects the
 * conversation's attachments into the prompt. Attachments from the current
 * message and recent room messages are merged by id (newest wins), sorted
 * most-recent-first without omitting older attachments.
 *
 * Prompt text is gated: it renders only when the current message carries its
 * own attachments, or when the current/reply message text both references and
 * asks to inspect an attachment — stale room attachments never leak into
 * unrelated turns, and sub-agent result turns are excluded outright. For each
 * visible attachment it advertises whether the content is readable via
 * `ATTACHMENT action=read`, keyed on stored `text`; images are the exception,
 * since the read action re-describes them at read time whenever an
 * `IMAGE_DESCRIPTION` model is registered.
 */
import { requireProviderSpec } from "../../../generated/spec-helpers.ts";
import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type Memory,
	ModelType,
	type Provider,
	type ProviderResult,
} from "../../../types/index.ts";
import { MESSAGE_SOURCE_SUB_AGENT } from "../../../types/message-source.ts";
import { toWellFormedUnicode } from "../../../utils/well-formed.ts";
import { addHeader } from "../../../utils.ts";
import { listConversationAttachments } from "../../working-memory/attachmentContext.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ATTACHMENTS");
const ATTACHMENT_REFERENCE_RE =
	/\b(?:attachments?|files?|documents?|pdfs?|images?|photos?|pictures?|screenshots?|videos?|audio|recordings?|links?|urls?)\b|https?:\/\/\S+/iu;
const ATTACHMENT_INSPECTION_RE =
	/\b(?:what|see|view|look(?:ing)?(?:\s+at)?|read|open|inspect|analy[sz]e|describe|summari[sz]e|transcribe|ocr|shown?|showing|contains?|content|find|found|anything|result|results|thoughts?|think|opinion|take)\b/iu;

/**
 * Render an attachment URL for the prompt without dumping raw bytes into
 * context. Inline `data:` URLs (e.g. a TTS audio clip stored as
 * `data:audio/wav;base64,…`) are replaced with a compact descriptor — the
 * agent still knows the media exists and can pull it via `ATTACHMENT
 * action=read`, but a multi-KB base64 blob never reaches the model. Remote
 * URLs are passed through completely.
 */
function formatAttachmentUrlForPrompt(url: string | undefined): string {
	if (!url) return "(none)";
	if (url.startsWith("data:")) {
		const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? "binary";
		return `[inline ${mime} data, ${url.length} chars]`;
	}
	return toWellFormedUnicode(url);
}

function contentString(message: Memory, key: string): string {
	const value = (message.content as Record<string, unknown> | undefined)?.[key];
	return typeof value === "string" ? value : "";
}

function messageTextForAttachmentRelevance(message: Memory): string {
	return [
		contentString(message, "currentMessageText"),
		typeof message.content.text === "string" ? message.content.text : "",
		contentString(message, "replyToMessageText"),
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * The half of the render gate decidable from the current message alone —
 * before any conversation-history fetch. When this is false the provider
 * skips `listConversationAttachments` entirely (the room-history scan plus
 * access-context resolution), which on a text-only turn was the single
 * largest composeState provider wall.
 */
function couldRenderAttachmentPromptText(message: Memory): boolean {
	if ((message.content.attachments ?? []).length > 0) return true;
	if (message.content.source === MESSAGE_SOURCE_SUB_AGENT) return false;
	const text = messageTextForAttachmentRelevance(message);
	return (
		ATTACHMENT_REFERENCE_RE.test(text) && ATTACHMENT_INSPECTION_RE.test(text)
	);
}

function shouldRenderAttachmentPromptText(
	message: Memory,
	allAttachments: readonly Media[],
): boolean {
	return allAttachments.length > 0 && couldRenderAttachmentPromptText(message);
}

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
		// When the message-side half of the render gate already fails, no
		// history result could make the provider relevant. Skip the room scan.
		if (!couldRenderAttachmentPromptText(message)) {
			return {
				values: { attachments: "" },
				data: {
					attachments: [],
					visibleAttachments: [],
					omittedCount: 0,
				},
				text: "",
			};
		}

		const allAttachments = await listConversationAttachments(runtime, message);
		const visibleAttachments = allAttachments;
		const omittedCount = 0;
		const shouldRenderText = shouldRenderAttachmentPromptText(
			message,
			allAttachments,
		);

		// Format attachments for display
		const formattedAttachments = shouldRenderText
			? visibleAttachments
					.map(
						(attachment) =>
							`ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${formatAttachmentUrlForPrompt(attachment.url)}
    Type: ${attachment.source}
    Content Type: ${attachment.contentType ?? "unknown"}
    Stored Content: ${
			// Keyed on text (the canonical readable-content field) only: failed
			// processing leaves text empty but stores failure prose in description,
			// which must not advertise an unsatisfiable ATTACHMENT read. Images are
			// the exception: the read action re-describes them at read time
			// (working-memory/attachmentContext), so the read is satisfiable
			// whenever an IMAGE_DESCRIPTION model is registered.
			attachment.text ||
			(
				attachment.contentType === ContentType.IMAGE &&
					typeof runtime.getModel(ModelType.IMAGE_DESCRIPTION) === "function"
			)
				? "available via ATTACHMENT action=read"
				: "none"
		}
    `,
					)
					.join("\n")
			: "";
		// Create formatted text with header
		const text =
			formattedAttachments && formattedAttachments.length > 0
				? addHeader("# Attachments", formattedAttachments)
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
	},
};
