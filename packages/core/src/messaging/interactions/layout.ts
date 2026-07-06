/**
 * Project an interaction block onto platform-neutral button rows that each
 * connector maps to its native primitive (Telegram inline keyboard, Discord
 * action rows). Centralizing the projection here keeps every connector's
 * rendering consistent and the per-connector glue thin.
 *
 * Buttons round-trip via `callbackData` (the user's answer, re-injected as a
 * message) or open a `url` (link-out for secret entry and task views). A button
 * always carries exactly one of the two.
 */

import type {
	InteractionBlock,
	InteractionOption,
} from "../../types/interactions";
import type { Content } from "../../types/primitives";
import { encodeReplyCallback } from "./callback";
import { parseInteractionBlocks } from "./parse";

export interface NeutralButton {
	label: string;
	/** Re-inject this text as a user message when tapped. */
	callbackData?: string;
	/** Open this URL when tapped (link-out). */
	url?: string;
	style?: "primary" | "secondary" | "danger";
}

export interface NeutralRow {
	buttons?: NeutralButton[];
}

export interface NeutralLayout {
	/** Prompt / title shown above the controls. */
	text?: string;
	rows: NeutralRow[];
	/**
	 * True when the block could not be rendered as native controls (e.g. a form
	 * with no link-out URL available) and the connector should fall back to a
	 * free-text reply flow.
	 */
	needsFallback?: boolean;
}

export interface PlainTextFallbackOptions {
	/** Resolve an external entry URL for task or navigate blocks. */
	resolveUrl?: (block: InteractionBlock) => string | undefined;
	/** Resolve an external URL for a `navigate` followup chip. */
	resolveNavigateUrl?: (payload: string) => string | undefined;
}

export interface LayoutOptions {
	/**
	 * Resolve an external entry URL for blocks that link out: secret/OAuth entry
	 * and the task view. Returning undefined marks the block as needing a
	 * free-text fallback (this is the designed path for `form` blocks, which have
	 * no hosted page — see {@link buildInteractionUrlResolver}).
	 */
	resolveUrl?: (block: InteractionBlock) => string | undefined;
	/**
	 * Resolve an external URL for a `navigate` followup chip (payload is a viewId
	 * or `/`-prefixed path). When provided, navigate chips render as link-out
	 * buttons instead of being re-injected as a reply. Returning undefined keeps
	 * the reply-callback behavior.
	 */
	resolveNavigateUrl?: (payload: string) => string | undefined;
	/** Buttons per row before wrapping (Telegram ~8, Discord 5). Default 3. */
	maxButtonsPerRow?: number;
	/**
	 * Native callback payload budget for reply buttons. Defaults to Telegram's
	 * 64-byte `callback_data` limit; Discord passes its 100-character custom_id
	 * budget so valid Discord buttons are not forced into free-text fallback.
	 */
	maxCallbackBytes?: number;
}

/**
 * Copy appended to a form block's prose when it cannot render natively and no
 * link-out URL exists — the free-text fallback affordance connectors show
 * instead of a dead button (#14321).
 */
export const FORM_FREE_TEXT_INVITE = "Reply with your answer.";

function firstNonBlankText(
	...values: Array<string | undefined>
): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size)
		rows.push(items.slice(i, i + size));
	return rows;
}

function optionButtons(
	options: InteractionOption[],
	perRow: number,
	maxCallbackBytes?: number,
): { rows: NeutralRow[]; anyDropped: boolean } {
	let anyDropped = false;
	const buttons: NeutralButton[] = [];
	for (const o of options) {
		const callbackData = encodeReplyCallback(o.value, {
			maxBytes: maxCallbackBytes,
		});
		if (!callbackData) {
			anyDropped = true;
			continue;
		}
		buttons.push({ label: o.label, callbackData, style: "secondary" });
	}
	return {
		rows: chunk(buttons, perRow).map((b) => ({ buttons: b })),
		anyDropped,
	};
}

/** Build a platform-neutral control layout for a single interaction block. */
export function toNeutralLayout(
	block: InteractionBlock,
	opts: LayoutOptions = {},
): NeutralLayout {
	const perRow = opts.maxButtonsPerRow ?? 3;
	const resolveUrl = opts.resolveUrl;
	const maxCallbackBytes = opts.maxCallbackBytes;

	switch (block.kind) {
		case "choice": {
			const { rows, anyDropped } = optionButtons(
				block.options,
				perRow,
				maxCallbackBytes,
			);
			return {
				text: block.prompt,
				rows,
				needsFallback: anyDropped || block.allowCustom === true,
			};
		}
		case "followups": {
			const buttons: NeutralButton[] = [];
			for (const o of block.options) {
				if (o.kind === "navigate") {
					const url = opts.resolveNavigateUrl?.(o.payload);
					if (url) {
						buttons.push({ label: o.label, url, style: "secondary" });
						continue;
					}
				}
				const callbackData = encodeReplyCallback(o.payload, {
					maxBytes: maxCallbackBytes,
				});
				if (callbackData)
					buttons.push({ label: o.label, callbackData, style: "secondary" });
			}
			return { rows: chunk(buttons, perRow).map((b) => ({ buttons: b })) };
		}
		case "task": {
			const url = resolveUrl?.(block);
			return {
				text: block.title,
				rows: url
					? [{ buttons: [{ label: "Open task", url, style: "primary" }] }]
					: [],
				needsFallback: !url,
			};
		}
		case "form": {
			const url = resolveUrl?.(block);
			if (url) {
				return {
					text: firstNonBlankText(block.title, block.description),
					rows: [
						{
							buttons: [
								{
									label: block.submitLabel ?? "Open form",
									url,
									style: "primary",
								},
							],
						},
					],
				};
			}
			// No hosted form page: show the form's prose and invite a free-text
			// reply instead of leaving a bare title with no affordance (#14321).
			const prose = firstNonBlankText(block.title, block.description);
			return {
				text: prose
					? `${prose}\n\n${FORM_FREE_TEXT_INVITE}`
					: FORM_FREE_TEXT_INVITE,
				rows: [],
				needsFallback: true,
			};
		}
		case "secret": {
			const url = resolveUrl?.(block) ?? block.url;
			const label =
				block.secretKind === "oauth"
					? `Connect ${block.provider ?? "account"}`
					: (block.submitLabel ?? "Provide securely");
			return {
				text: block.reason,
				rows: url ? [{ buttons: [{ label, url, style: "primary" }] }] : [],
				needsFallback: !url,
			};
		}
		default: {
			const _exhaustive: never = block;
			return _exhaustive;
		}
	}
}

/** Project a block onto text-only transports such as SMS/iMessage. */
export function toPlainTextFallback(
	block: InteractionBlock,
	opts: PlainTextFallbackOptions = {},
): string | undefined {
	switch (block.kind) {
		case "choice": {
			const prompt = firstNonBlankText(block.prompt);
			const options = block.options.map(
				(option, index) => `${index + 1}. ${option.label}`,
			);
			const invite = block.allowCustom
				? "Reply with a number or your own answer."
				: "Reply with a number.";
			return [prompt, options.join("\n"), invite]
				.filter((part): part is string => Boolean(part?.trim()))
				.join("\n");
		}
		case "followups": {
			const suggestions = block.options
				.map((option) => {
					const label = option.label.trim();
					if (!label) return "";
					if (option.kind !== "navigate") return label;
					const url = opts.resolveNavigateUrl?.(option.payload);
					return url ? `${label} (${url})` : label;
				})
				.filter((label) => label.length > 0);
			return suggestions.length > 0
				? `Suggestions: ${suggestions.join(" / ")}`
				: undefined;
		}
		case "task": {
			const url = opts.resolveUrl?.(block);
			return [block.title, url].filter(Boolean).join("\n");
		}
		case "form": {
			const prose = [block.title, block.description]
				.map((part) => part?.trim())
				.filter((part): part is string => Boolean(part));
			return [...prose, FORM_FREE_TEXT_INVITE].join("\n\n");
		}
		case "secret": {
			const url = opts.resolveUrl?.(block) ?? block.url;
			const reason = firstNonBlankText(block.reason);
			return url
				? [reason, url].filter(Boolean).join("\n")
				: [reason, "A secure link for this is not available here yet."]
						.filter(Boolean)
						.join("\n");
		}
		default: {
			const _exhaustive: never = block;
			return _exhaustive;
		}
	}
}

/**
 * Render interaction-bearing text for button-less transports before their own
 * chunking layer sees the message. This strips every marker body and appends
 * the text fallback for each parsed block, so long form JSON cannot be split
 * into user-visible bracket fragments.
 */
export function renderInteractionsAsPlainText(
	text: string | undefined | null,
	opts: PlainTextFallbackOptions = {},
): { text: string; hadBlocks: boolean } {
	const source = text ?? "";
	const { blocks, cleanedText } = parseInteractionBlocks(source);
	if (blocks.length === 0) {
		return { text: source, hadBlocks: false };
	}
	const fallbacks = blocks
		.map((block) => toPlainTextFallback(block, opts))
		.filter((part): part is string => Boolean(part?.trim()));
	return {
		text: [cleanedText, ...fallbacks]
			.filter((part) => part.trim().length > 0)
			.join("\n\n"),
		hadBlocks: true,
	};
}

/**
 * Render a full `Content` object for a text-only transport. When the runtime has
 * already normalized typed `interactions`, those blocks are authoritative; this
 * preserves out-of-band secret/OAuth requests that do not have a bracket-marker
 * text representation.
 */
export function renderContentInteractionsAsPlainText(
	content: Pick<Content, "text" | "interactions"> | undefined | null,
	opts: PlainTextFallbackOptions = {},
): { text: string; hadBlocks: boolean } {
	const source = typeof content?.text === "string" ? content.text : "";
	const interactions = Array.isArray(content?.interactions)
		? content.interactions
		: [];
	if (interactions.length === 0) {
		return renderInteractionsAsPlainText(source, opts);
	}
	const { cleanedText } = parseInteractionBlocks(source);
	const fallbacks = interactions
		.map((block) => toPlainTextFallback(block, opts))
		.filter((part): part is string => Boolean(part?.trim()));
	return {
		text: [cleanedText, ...fallbacks]
			.filter((part) => part.trim().length > 0)
			.join("\n\n"),
		hadBlocks: true,
	};
}

/**
 * Build the canonical link-out resolvers connectors pass to {@link toNeutralLayout}
 * so Telegram, Discord, and any other surface produce identical URLs for task
 * and navigate blocks. `appBaseUrl` is the deployment's app/dashboard origin
 * (`ELIZA_APP_URL`, falling back to the cloud URL). Returns `undefined`
 * resolvers when no base URL is configured, which keeps the free-text fallback.
 *
 * `form` blocks are intentionally NOT resolved: there is no hosted `/forms/:id`
 * page and form specs are never persisted, so any link-out would be a dead
 * route. Leaving them unresolved routes them to the layout's free-text reply
 * fallback instead of fabricating a healthy-looking dead control (#14321).
 */
export function buildInteractionUrlResolver(
	appBaseUrl: string | undefined | null,
): Pick<LayoutOptions, "resolveUrl" | "resolveNavigateUrl"> {
	if (!appBaseUrl) return {};
	const base = appBaseUrl.replace(/\/+$/, "");
	return {
		resolveUrl: (block) => {
			switch (block.kind) {
				case "task":
					return `${base}/orchestrator?taskId=${encodeURIComponent(block.threadId)}`;
				// `form` and secret/OAuth blocks fall through to undefined: a form
				// has no hosted `/forms/:id` page (degrade to free-text reply), and
				// secret/OAuth blocks carry their own out-of-band entry URL that the
				// layout defers to.
				default:
					return undefined;
			}
		},
		resolveNavigateUrl: (payload) => {
			if (!payload) return undefined;
			// A `/`-prefixed path is a dashboard route; a bare token is a viewId.
			const path = payload.startsWith("/")
				? payload
				: `/?view=${encodeURIComponent(payload)}`;
			return `${base}${path}`;
		},
	};
}
