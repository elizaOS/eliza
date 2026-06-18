/**
 * Project an interaction block onto a platform-neutral control layout — rows of
 * buttons and select menus — that each connector maps to its native primitive
 * (Telegram inline keyboard, Discord action row / string select). Centralizing
 * the projection here keeps every connector's rendering consistent and the
 * per-connector glue thin.
 *
 * Buttons round-trip via `callbackData` (the user's answer, re-injected as a
 * message) or open a `url` (link-out for forms, secret entry, and task views).
 * A button always carries exactly one of the two.
 */

import type {
	InteractionBlock,
	InteractionOption,
} from "../../types/interactions";
import { encodeReplyCallback } from "./callback";

export interface NeutralButton {
	label: string;
	/** Re-inject this text as a user message when tapped. */
	callbackData?: string;
	/** Open this URL when tapped (link-out). */
	url?: string;
	style?: "primary" | "secondary" | "danger";
}

export interface NeutralSelect {
	customId: string;
	placeholder?: string;
	options: InteractionOption[];
}

export interface NeutralRow {
	buttons?: NeutralButton[];
	select?: NeutralSelect;
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

export interface LayoutOptions {
	/**
	 * Resolve an external entry URL for blocks that link out: complex forms,
	 * secret/OAuth entry, and the task view. Returning undefined marks the block
	 * as needing a free-text fallback.
	 */
	resolveUrl?: (block: InteractionBlock) => string | undefined;
	/** Buttons per row before wrapping (Telegram ~8, Discord 5). Default 3. */
	maxButtonsPerRow?: number;
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
): { rows: NeutralRow[]; anyDropped: boolean } {
	let anyDropped = false;
	const buttons: NeutralButton[] = [];
	for (const o of options) {
		const callbackData = encodeReplyCallback(o.value);
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

	switch (block.kind) {
		case "choice": {
			const { rows, anyDropped } = optionButtons(block.options, perRow);
			return {
				text: block.prompt,
				rows,
				needsFallback: anyDropped || block.allowCustom === true,
			};
		}
		case "followups": {
			const buttons: NeutralButton[] = [];
			for (const o of block.options) {
				const callbackData = encodeReplyCallback(o.payload);
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
			return {
				text: block.title ?? block.description,
				rows: url
					? [
							{
								buttons: [
									{
										label: block.submitLabel ?? "Open form",
										url,
										style: "primary",
									},
								],
							},
						]
					: [],
				needsFallback: !url,
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
