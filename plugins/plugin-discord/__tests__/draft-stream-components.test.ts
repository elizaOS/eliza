/**
 * Draft-stream finalization must preserve Discord component rows. The harness
 * records the exact channel send/edit payloads so widget buttons cannot vanish
 * when streaming drafts are enabled.
 */
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type MessageActionRowComponentBuilder,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { createDraftStreamController } from "../draft-stream";

function buttonRow(): ActionRowBuilder<MessageActionRowComponentBuilder> {
	return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId("choice:yes")
			.setLabel("Yes")
			.setStyle(ButtonStyle.Primary),
	);
}

function makeChannelHarness() {
	const sends: unknown[] = [];
	const edits: unknown[] = [];
	let nextId = 0;
	const channel = {
		send: async (options: unknown) => {
			sends.push(options);
			nextId += 1;
			return {
				id: `msg-${nextId}`,
				edit: async (editOptions: unknown) => {
					edits.push(editOptions);
					return {
						id: `msg-${nextId}`,
						edit: async (nextEditOptions: unknown) => {
							edits.push(nextEditOptions);
							return { id: `msg-${nextId}` };
						},
					};
				},
			};
		},
	};
	return { channel, sends, edits };
}

describe("#14527 Discord draft stream preserves widget components", () => {
	it("attaches components to the final draft message", async () => {
		const { channel, sends } = makeChannelHarness();
		const controller = createDraftStreamController();
		const components = [buttonRow()];

		await controller.start(channel as never);
		await controller.finalize("Choose one:", components);

		expect(sends).toHaveLength(1);
		expect(sends[0]).toMatchObject({
			content: "Choose one:",
			components,
		});
	});

	it("edits the last identical draft snapshot to add final components", async () => {
		const { channel, sends, edits } = makeChannelHarness();
		const controller = createDraftStreamController({
			minInitialChars: 0,
			throttleMs: 250,
		});
		const components = [buttonRow()];

		await controller.start(channel as never);
		controller.update("Choose one:");
		await new Promise((resolve) => setTimeout(resolve, 300));

		await controller.finalize("Choose one:", components);

		expect(sends).toHaveLength(1);
		expect(edits).toHaveLength(1);
		expect(edits[0]).toMatchObject({
			content: "Choose one:",
			components,
		});
	});
});
