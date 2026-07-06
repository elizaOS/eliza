/**
 * Regression test for #14527 — "Discord drops widget components on DM".
 *
 * The DM send branch in `MessageManager` used to call
 * `user.send({ content, files })` with NO `components`, so a components-only
 * reply (e.g. a `[CHOICE]` block) rendered the "Choose an option:" fallback
 * text with zero buttons. This pins the fix: a reply carrying interaction
 * blocks, rendered through the SAME `renderDiscordInteractions` +
 * `buildDiscordComponents` path the guild send uses, must produce DM send
 * options that carry real discord.js action rows with buttons.
 *
 * The test walks the exact production seam:
 *   agent text (with [CHOICE] block)
 *     -> renderDiscordInteractions()        (interactions.ts)
 *     -> buildDiscordComponents()           (utils.ts)
 *     -> buildDmSendOptions()               (messages.ts, the DM branch helper)
 * and asserts `components` survives to the outgoing DM payload.
 */
import type { Content } from "@elizaos/core";
import {
	ActionRowBuilder,
	type MessageActionRowComponentBuilder,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { renderDiscordInteractions } from "../interactions";
import { buildDmSendOptions } from "../messages";
import { buildDiscordComponents } from "../utils";

/** A components-only agent reply: a choice picker with two options, no prose. */
function choiceOnlyContent(): Content {
	return {
		text: [
			"[CHOICE:confirm]",
			"yes=Yes, do it",
			"no=No, cancel",
			"[/CHOICE]",
		].join("\n"),
	} as Content;
}

describe("#14527 Discord keeps widget components on DM messages", () => {
	it("a components-only reply yields DM send options carrying the action row + buttons", () => {
		const rendered = renderDiscordInteractions(choiceOnlyContent());

		// The renderer must have produced native components for the choice block.
		expect(rendered.components.length).toBeGreaterThan(0);

		const built = buildDiscordComponents(rendered.components);
		expect(built).toBeDefined();
		expect(built?.length).toBeGreaterThan(0);
		expect(built?.[0]).toBeInstanceOf(ActionRowBuilder);

		// Prose is empty on a components-only reply — mirror the fallback the DM
		// branch applies before delivery.
		const textContent =
			rendered.text.trim().length > 0 ? rendered.text : "Choose an option:";

		const options = buildDmSendOptions(textContent, [], built);

		// THE REGRESSION: before the fix these components were dropped and the DM
		// went out with only { content, files }. Now they must be present.
		expect(options.components).toBeDefined();
		expect(options.components?.length).toBe(built?.length);
		expect(options.components?.[0]).toBeInstanceOf(ActionRowBuilder);

		// And the buttons carry the option labels + custom ids (they render, not
		// just exist). Serialize the built row to inspect the button payloads.
		const row = options
			.components?.[0] as ActionRowBuilder<MessageActionRowComponentBuilder>;
		const json = row.toJSON();
		const labels = json.components.map((c) => (c as { label?: string }).label);
		expect(labels).toEqual(["Yes, do it", "No, cancel"]);
	});

	it("omits the components key entirely for a plain-text reply (no empty array)", () => {
		const rendered = renderDiscordInteractions({
			text: "just a normal reply, no widgets",
		} as Content);
		expect(rendered.components.length).toBe(0);

		const built = buildDiscordComponents(rendered.components);
		expect(built).toBeUndefined();

		const options = buildDmSendOptions(
			"just a normal reply, no widgets",
			[],
			built,
		);
		// Discord rejects `components: []`; the key must be absent, not empty.
		expect("components" in options).toBe(false);
		expect(options.content).toBe("just a normal reply, no widgets");
	});
});
