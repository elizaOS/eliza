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
