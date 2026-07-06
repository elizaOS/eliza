/**
 * Unit tests for the draft-stream controller's finalize path — the final
 * streamed message must carry the reply's rendered components (#14527).
 * Hand-rolled channel/message stubs capture the exact discord.js send/edit
 * payloads; no network, no discord.com.
 */
import type {
	ActionRowBuilder,
	MessageActionRowComponentBuilder,
	TextChannel,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { createDraftStreamController } from "../draft-stream";
import type { DiscordActionRow } from "../types";
import { buildDiscordComponents } from "../utils";

interface CapturedSend {
	content?: string;
	components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

function makeChannel() {
	const sends: CapturedSend[] = [];
	const edits: CapturedSend[] = [];
	const channel = {
		send: async (options: CapturedSend) => {
			sends.push(options);
			return {
				id: `msg-${sends.length}`,
				content: options.content ?? "",
				createdTimestamp: Date.now(),
				attachments: { size: 0 },
				edit: async (editOptions: CapturedSend) => {
					edits.push(editOptions);
					return { id: `msg-${sends.length}` };
				},
			};
		},
	} as unknown as TextChannel;
	return { channel, sends, edits };
}

const choiceRow: DiscordActionRow = {
	type: 1,
	components: [
		{ type: 2, custom_id: "ia1:yes", label: "Yes", style: 2 },
		{ type: 2, custom_id: "ia1:no", label: "No", style: 2 },
	],
};

function choiceComponents() {
	const components = buildDiscordComponents([choiceRow]);
	if (components?.length !== 1) {
		throw new Error("choice row did not build into a Discord component");
	}
	return components;
}

function rowJson(component: unknown): {
	type: number;
	components: Array<{ custom_id?: string; label?: string }>;
} {
	return (component as { toJSON: () => ReturnType<typeof rowJson> }).toJSON();
}

describe("draft-stream finalize components (#14527)", () => {
	it("attaches components to the finalized message", async () => {
		const { channel, sends } = makeChannel();
		const controller = createDraftStreamController();
		await controller.start(channel);

		const messages = await controller.finalize("Pick one", choiceComponents());

		expect(messages).toHaveLength(1);
		expect(sends).toHaveLength(1);
		expect(sends[0].components).toHaveLength(1);
		const row = rowJson(sends[0].components?.[0]);
		expect(row.type).toBe(1);
		expect(row.components.map((c) => c.custom_id)).toEqual([
			"ia1:yes",
			"ia1:no",
		]);
	});

	it("edits the last snapshot to attach components when the final text already streamed", async () => {
		const { channel, sends, edits } = makeChannel();
		const controller = createDraftStreamController({
			throttleMs: 250,
			minInitialChars: 1,
		});
		await controller.start(channel);

		controller.update("Pick one");
		// Let the throttled snapshot flush so the full final text is already out.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(sends).toHaveLength(1);

		await controller.finalize("Pick one", choiceComponents());

		// No duplicate message; the streamed snapshot gained the components.
		expect(sends).toHaveLength(1);
		expect(edits).toHaveLength(1);
		expect(edits[0].content).toBe("Pick one");
		const row = rowJson(edits[0].components?.[0]);
		expect(row.components.map((c) => c.label)).toEqual(["Yes", "No"]);
	});

	it("attaches components only to the last chunk of a multi-message finalize", async () => {
		const { channel, sends } = makeChannel();
		const controller = createDraftStreamController({ maxChars: 60 });
		await controller.start(channel);

		const longText = Array.from(
			{ length: 8 },
			(_, i) => `Sentence number ${i} pads the reply.`,
		).join(" ");
		expect(longText.length).toBeGreaterThan(60);

		await controller.finalize(longText, choiceComponents());

		expect(sends.length).toBeGreaterThan(1);
		const last = sends[sends.length - 1];
		expect(last.components).toHaveLength(1);
		for (const earlier of sends.slice(0, -1)) {
			expect(earlier.components).toBeUndefined();
		}
	});

	it("finalize without components stays component-free", async () => {
		const { channel, sends } = makeChannel();
		const controller = createDraftStreamController();
		await controller.start(channel);

		await controller.finalize("Just prose");

		expect(sends).toHaveLength(1);
		expect(sends[0].components).toBeUndefined();
	});
});
