/**
 * Render the interactive blocks an agent embeds in a reply (choice pickers,
 * suggestion chips, task cards, secret/OAuth requests) as native Discord
 * components — action rows of buttons — and decode the custom id when the user
 * clicks one.
 *
 * The block vocabulary, parsing, neutral layout, and the callback codec all live
 * in `@elizaos/core` (`messaging/interactions`) so the dashboard, Telegram, and
 * Discord render the same agent output identically. This module is the thin
 * Discord-specific projection: neutral buttons → `DiscordActionRow` specs that
 * `buildComponents` (utils.ts) turns into discord.js builders.
 */

import {
	type Content,
	type InteractionBlock,
	type NeutralButton,
	parseInteractionBlocks,
	toNeutralLayout,
} from "@elizaos/core";
import type { DiscordActionRow, DiscordComponentOptions } from "./types";

/** Discord allows ≤5 buttons per action row and ≤5 action rows per message. */
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;
const MAX_CUSTOM_ID_BYTES = 100;

/** discord.js ButtonStyle numeric values. */
const BUTTON_STYLE = { primary: 1, secondary: 2, danger: 4 } as const;
const LINK_STYLE = 5;

export interface DiscordInteractionRender {
	/** Prose with interaction markers stripped (plus any non-button block text). */
	text: string;
	/** Action-row specs; empty when the reply has no native controls. */
	components: DiscordActionRow[];
	/** True when a block expects a free-text reply (allowCustom / unrendered form). */
	needsFreeTextReply: boolean;
}

export interface DiscordInteractionOptions {
	/** Resolve a link-out URL for task / form / secret blocks. */
	resolveUrl?: (block: InteractionBlock) => string | undefined;
	/** Resolve a link-out URL for `navigate` followup chips. */
	resolveNavigateUrl?: (payload: string) => string | undefined;
}

function toComponent(button: NeutralButton): DiscordComponentOptions | null {
	if (button.url) {
		// Link buttons carry no custom_id; discord.js requires the URL + Link style.
		return {
			type: 2,
			custom_id: "",
			label: button.label,
			style: LINK_STYLE,
			url: button.url,
		};
	}
	if (button.callbackData) {
		return {
			type: 2,
			custom_id: button.callbackData,
			label: button.label,
			style: BUTTON_STYLE[button.style ?? "secondary"],
		};
	}
	return null;
}

/**
 * Project a reply's interaction blocks onto Discord action rows + the prose to
 * display. Plain replies (no blocks) pass through unchanged with no components,
 * so this is a safe no-op on the common path.
 */
export function renderDiscordInteractions(
	content: Content,
	opts: DiscordInteractionOptions = {},
): DiscordInteractionRender {
	const { blocks, cleanedText } = parseInteractionBlocks(content.text ?? "");
	if (blocks.length === 0) {
		return {
			text: content.text ?? "",
			components: [],
			needsFreeTextReply: false,
		};
	}

	const rows: DiscordActionRow[] = [];
	const extraLines: string[] = [];
	let needsFreeTextReply = false;

	for (const block of blocks) {
		const layout = toNeutralLayout(block, {
			resolveUrl: opts.resolveUrl,
			resolveNavigateUrl: opts.resolveNavigateUrl,
			maxButtonsPerRow: MAX_BUTTONS_PER_ROW,
			maxCallbackBytes: MAX_CUSTOM_ID_BYTES,
		});
		let producedButton = false;
		for (const row of layout.rows) {
			const components = (row.buttons ?? [])
				.map(toComponent)
				.filter((c): c is DiscordComponentOptions => c !== null);
			if (components.length > 0) {
				rows.push({ type: 1, components });
				producedButton = true;
			}
		}
		if (layout.needsFallback) needsFreeTextReply = true;
		if (!producedButton && layout.text) extraLines.push(layout.text);
	}

	const text = [cleanedText, ...extraLines]
		.filter((s) => s.trim().length > 0)
		.join("\n\n");
	return { text, components: rows.slice(0, MAX_ROWS), needsFreeTextReply };
}
