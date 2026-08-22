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
	buildInteractionUrlResolver,
	type Content,
	encodePreparedInteractionCallback,
	type IAgentRuntime,
	type InteractionBlock,
	type NeutralButton,
	type PreparedMessageInteraction,
	parseInteractionBlocks,
	renderContentInteractionsAsPlainText,
	stripDashboardOnlyMarkers,
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
			text: cleanedText,
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

	// Discord hard-caps a message at 5 action rows. When controls overflow the
	// cap, surface the dropped options as prose and invite a typed reply so no
	// option is silently unreachable.
	const visibleRows = rows.slice(0, MAX_ROWS);
	const droppedButtons = rows.slice(MAX_ROWS).flatMap((row) => row.components);
	if (droppedButtons.length > 0) {
		needsFreeTextReply = true;
		const droppedLabels = droppedButtons
			.map((button) =>
				button.url && button.label
					? `${button.label} (${button.url})`
					: (button.label ?? ""),
			)
			.filter((label) => label.trim().length > 0);
		if (droppedLabels.length > 0) {
			extraLines.push(
				`More options (reply with one): ${droppedLabels.join(", ")}`,
			);
		}
	}

	// Parsed blocks can add fallback prose after the first cleanup. Apply the
	// dashboard-only marker boundary to the complete Discord message as well.
	const text = stripDashboardOnlyMarkers(
		[cleanedText, ...extraLines]
			.filter((s) => s.trim().length > 0)
			.join("\n\n"),
	);
	return { text, components: visibleRows, needsFreeTextReply };
}

/** Render only host-prepared authority as Discord buttons. */
export function renderPreparedDiscordInteraction(
	prepared: PreparedMessageInteraction,
): DiscordInteractionRender {
	const block = prepared.block;
	const fallback = renderContentInteractionsAsPlainText({
		interactions: [block],
	}).text;
	const hostedUrl =
		prepared.hostedUrl ?? (block.kind === "secret" ? block.url : undefined);
	if (hostedUrl) {
		const label =
			block.kind === "form"
				? (block.submitLabel ?? "Open form")
				: block.kind === "task"
					? "Open task"
					: block.kind === "secret"
						? block.secretKind === "oauth"
							? `Connect ${block.provider ?? "account"}`
							: (block.submitLabel ?? "Provide securely")
						: "Open";
		return {
			text: block.kind === "task" ? block.title : fallback,
			components: [
				{
					type: 1,
					components: [
						{
							type: 2,
							custom_id: "",
							label,
							style: LINK_STYLE,
							url: hostedUrl,
						},
					],
				},
			],
			needsFreeTextReply: false,
		};
	}
	if (
		prepared.delivery.mode !== "native" ||
		(block.kind !== "choice" && block.kind !== "followups")
	) {
		return { text: fallback, components: [], needsFreeTextReply: true };
	}
	const providerOptions =
		block.kind === "choice"
			? block.options.map((option) => ({
					label: option.label,
					value: option.value,
				}))
			: block.options
					.filter((option) => option.kind !== "navigate")
					.map((option) => ({ label: option.label, value: option.payload }));
	const concrete: DiscordComponentOptions[] = [];
	for (const option of providerOptions) {
		const customId = encodePreparedInteractionCallback(
			prepared.callbackData,
			{ value: option.value },
			MAX_CUSTOM_ID_BYTES,
		);
		if (!customId) {
			return { text: fallback, components: [], needsFreeTextReply: true };
		}
		concrete.push({
			type: 2,
			custom_id: customId,
			label: option.label,
			style: 2,
		});
	}
	if (concrete.length > MAX_ROWS * MAX_BUTTONS_PER_ROW)
		return { text: fallback, components: [], needsFreeTextReply: true };
	const components: DiscordActionRow[] = [];
	for (let index = 0; index < concrete.length; index += MAX_BUTTONS_PER_ROW) {
		components.push({
			type: 1,
			components: concrete.slice(index, index + MAX_BUTTONS_PER_ROW),
		});
	}
	return {
		text:
			block.kind === "choice"
				? (block.prompt ?? "Choose an option.")
				: "Choose an option.",
		components,
		needsFreeTextReply: false,
	};
}

/**
 * Canonical entry point for turning an outbound `Content` into Discord text +
 * components. Every Discord send path — the streaming/DM/channel reply in
 * `messages.ts` and the button-tap replay in `discord-interactions.ts` — routes
 * through here so link-out blocks (task cards, `navigate` chips) resolve their
 * URL identically. Rendering without the resolver silently drops those buttons
 * (a `[TASK:…]` reply degrades to bare prose), so the resolver must not be a
 * per-call-site detail: it is derived once, here, from the deployment's app
 * origin (`ELIZA_APP_URL`, then `ELIZA_CLOUD_URL`).
 */
export function buildDiscordReplyPayload(
	runtime: Pick<IAgentRuntime, "getSetting">,
	content: Content,
): DiscordInteractionRender {
	const rawAppUrl =
		runtime.getSetting("ELIZA_APP_URL") ??
		runtime.getSetting("ELIZA_CLOUD_URL");
	const appBaseUrl = typeof rawAppUrl === "string" ? rawAppUrl : undefined;
	return renderDiscordInteractions(
		content,
		buildInteractionUrlResolver(appBaseUrl),
	);
}
