/**
 * Coverage for `formatMessages` and `formatPosts` conversation-history
 * rendering: attachment read-advertisement gating, reacted-to message
 * restoration, bot-sender tagging, and timestamp tense in the rendered
 * transcript. Pure formatter test — no runtime or model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity, Media, Memory, UUID } from "../types/index.ts";
import { formatMessages, formatPosts } from "../utils.ts";

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

	it("tags a bot sender's name with (bot) so the model knows the participant is a bot", () => {
		// Bot-ness surfaced as plain transcript context — what the agent KNOWS about
		// a participant — not a behavioral branch. A message stamped fromBot at
		// ingestion renders the speaker as "Name (bot)".
		const rendered = formatMessages({
			messages: [
				{
					id: "00000000-0000-0000-0000-000000000031" as UUID,
					entityId: "00000000-0000-0000-0000-000000000003" as UUID,
					roomId,
					createdAt: 1765381653000,
					content: { text: "hey AgentC, can you deploy the site" },
					metadata: { fromBot: true },
				} as Memory,
			],
			entities: [
				{
					id: "00000000-0000-0000-0000-000000000003" as UUID,
					names: ["OtherBot"],
				} as never,
			],
		});

		expect(rendered).toContain("OtherBot (bot):");
	});

	it("also reads fromBot from content.metadata (connector stamps either shape)", () => {
		const rendered = formatMessages({
			messages: [
				{
					id: "00000000-0000-0000-0000-000000000033" as UUID,
					entityId: "00000000-0000-0000-0000-000000000005" as UUID,
					roomId,
					createdAt: 1765381653000,
					content: {
						text: "status: queue drained",
						metadata: { fromBot: true },
					},
				} as Memory,
			],
			entities: [
				{
					id: "00000000-0000-0000-0000-000000000005" as UUID,
					names: ["RelayBot"],
				} as never,
			],
		});

		expect(rendered).toContain("RelayBot (bot):");
	});

	it("does NOT tag a human sender's name with (bot)", () => {
		const rendered = formatMessages({
			messages: [
				{
					id: "00000000-0000-0000-0000-000000000032" as UUID,
					entityId: "00000000-0000-0000-0000-000000000004" as UUID,
					roomId,
					createdAt: 1765381653000,
					content: { text: "can you deploy the site" },
				} as Memory,
			],
			entities: [
				{
					id: "00000000-0000-0000-0000-000000000004" as UUID,
					names: ["Alice"],
				} as never,
			],
		});

		expect(rendered).toContain("Alice:");
		expect(rendered).not.toContain("(bot)");
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

describe("transcript timestamp tense", () => {
	// These transcripts are rendered into prompt text the model reads, so a
	// future-dated memory (clock skew, a scheduled item) must not be described
	// as having already happened. The clock is frozen to pin exact offsets.
	const NOW = 1768478400000;
	const entityId = "00000000-0000-0000-0000-000000000002" as UUID;
	const agentId = "00000000-0000-0000-0000-000000000003" as UUID;
	const entities: Entity[] = [{ id: entityId, names: ["Ada"], agentId }];

	function messageAt(createdAt: number): Memory {
		return {
			id: "00000000-0000-0000-0000-000000000031" as UUID,
			entityId,
			roomId,
			createdAt,
			content: { text: "the demo starts soon", source: "discord" },
		} as Memory;
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("formatMessages renders a future createdAt as 'in …', not '… ago'", () => {
		const rendered = formatMessages({
			messages: [messageAt(NOW + 5 * 60_000)],
			entities,
		});

		expect(rendered).toContain("(in 5 minutes)");
		expect(rendered).not.toContain("ago)");
	});

	it("formatMessages keeps rendering a past createdAt as '… ago'", () => {
		const rendered = formatMessages({
			messages: [messageAt(NOW - 5 * 60_000)],
			entities,
		});

		expect(rendered).toContain("(5 minutes ago)");
	});

	it("formatPosts renders a future createdAt as 'in …', not '… ago'", () => {
		const rendered = formatPosts({
			messages: [messageAt(NOW + 5 * 60_000)],
			entities,
		});

		expect(rendered).toContain("Date: in 5 minutes");
	});

	it("formatPosts keeps rendering a past createdAt as '… ago'", () => {
		const rendered = formatPosts({
			messages: [messageAt(NOW - 5 * 60_000)],
			entities,
		});

		expect(rendered).toContain("Date: 5 minutes ago");
	});
});
