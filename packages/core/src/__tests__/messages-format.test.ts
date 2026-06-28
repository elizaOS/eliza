import { describe, expect, it } from "vitest";
import type { Media, Memory, UUID } from "../types/index.ts";
import { formatMessages } from "../utils.ts";

const roomId = "00000000-0000-0000-0000-000000000001" as UUID;

function messageWithAttachment(attachment: Media): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000011" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId,
		createdAt: 1765381653000,
		content: {
			text: "How can I max profit from this",
			attachments: [attachment],
		},
	} as Memory;
}

describe("formatMessages", () => {
	it("does not advertise a stored-content read for a failure-prose description without text", () => {
		// 2026-06-10 incident shape: mp4 ingest failed (no ffprobe), leaving
		// placeholder prose in description and empty text; conversation history
		// must not advertise an unsatisfiable ATTACHMENT read.
		const rendered = formatMessages({
			messages: [
				messageWithAttachment({
					id: "generated-video",
					url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
					title: "Generated_Video.mp4",
					source: "Video",
					contentType: "video",
					description: "An audio/video attachment (transcription failed)",
					text: "",
				}),
			],
			entities: [],
		});

		expect(rendered).toContain("Generated_Video.mp4");
		expect(rendered).not.toContain(
			"Stored content available via ATTACHMENT action=read",
		);
	});

	it("preserves the full reacted-to message text in context (#9874)", () => {
		// A reaction memory's `text` truncates the reacted-to content to a short
		// stub; the untruncated original lives in `reactedMessageText`. Context
		// formatting must surface the full statement so the planner does not
		// back-rationalize a truncated fragment into a phantom task.
		const full =
			"can you pull the Q3 revenue numbers and compare them against Q2 for me";
		const rendered = formatMessages({
			messages: [
				{
					id: "00000000-0000-0000-0000-000000000021" as UUID,
					entityId: "00000000-0000-0000-0000-000000000002" as UUID,
					roomId,
					createdAt: 1765381653000,
					content: {
						text: `*Added 👍 to: "${full.slice(0, 50)}…"*`,
						reactedMessageText: full,
					},
				} as Memory,
			],
			entities: [],
		});

		expect(rendered).toContain(full);
		expect(rendered).toContain("reacted-to message in full");
	});

	it("omits the reacted-to context line when no reactedMessageText is set", () => {
		const rendered = formatMessages({
			messages: [
				{
					id: "00000000-0000-0000-0000-000000000022" as UUID,
					entityId: "00000000-0000-0000-0000-000000000002" as UUID,
					roomId,
					createdAt: 1765381653000,
					content: { text: "just a normal message" },
				} as Memory,
			],
			entities: [],
		});

		expect(rendered).not.toContain("reacted-to message in full");
	});

	it("advertises a stored-content read when readable text is stored", () => {
		const rendered = formatMessages({
			messages: [
				messageWithAttachment({
					id: "generated-video",
					url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
					title: "Generated_Video.mp4",
					source: "Video",
					contentType: "video",
					description: "A clip about the coffee shop",
					text: "welcome to the coffee shop, home of the $50 latte",
				}),
			],
			entities: [],
		});

		expect(rendered).toContain(
			"Stored content available via ATTACHMENT action=read",
		);
	});
});
