/**
 * Unit coverage for the ATTACHMENTS provider (`attachmentsProvider`): stale
 * room attachments stay out of unrelated prompt text and out of sub-agent
 * result turns, relevance is judged from the current/reply message text, and
 * an `ATTACHMENT action=read` is advertised only when readable text is stored —
 * with images the exception when a vision (`IMAGE_DESCRIPTION`) model is
 * registered. Deterministic harness: a hand-stubbed runtime, no live model or DB.
 */
import { describe, expect, it } from "vitest";
import {
	type IAgentRuntime,
	type Memory,
	ModelType,
	type UUID,
} from "../../../types/index.ts";
import { attachmentsProvider } from "./attachments.ts";

const roomId = "00000000-0000-0000-0000-000000000001" as UUID;

function attachmentMemory(createdAt = 1): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000011" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId,
		createdAt,
		content: {
			text: "old link",
			attachments: [
				{
					id: "webpage-old",
					url: "https://example.test/old-link",
					title: "Old Link",
					source: "Web",
					contentType: "link",
					text: "old page text",
				},
			],
		},
	} as Memory;
}

function makeRuntime(
	recentMessages: Memory[],
	options: { hasImageDescriptionModel?: boolean } = {},
): IAgentRuntime {
	return {
		getConversationLength: () => 20,
		getMemories: async () => recentMessages,
		getModel: (modelType: string) =>
			options.hasImageDescriptionModel &&
			modelType === ModelType.IMAGE_DESCRIPTION
				? async () => ({ title: "", description: "" })
				: undefined,
	} as unknown as IAgentRuntime;
}

function makeMessage(content: Partial<Memory["content"]>): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000012" as UUID,
		entityId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId,
		createdAt: 2,
		content: {
			text: "can you try this?",
			...content,
		},
	} as Memory;
}

describe("attachmentsProvider", () => {
	it("keeps stale room attachments out of unrelated prompt text", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({ text: "can you try this?" }),
		);

		expect(result.text).toBe("");
		expect(result.data?.visibleAttachments).toHaveLength(1);
	});

	it("renders attachment prompt text when the current message asks about a link", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({ text: "can you read the link?" }),
		);

		expect(result.text).toContain("# Attachments");
		expect(result.text).toContain("webpage-old");
	});

	it("uses reply target text when deciding attachment relevance", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({
				text: "find anything?",
				replyToMessageText: "can you read this link?",
			}),
		);

		expect(result.text).toContain("# Attachments");
		expect(result.text).toContain("webpage-old");
	});

	it("does not inject stale room attachments into sub-agent result turns", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({
				source: "sub_agent",
				text: "[sub-agent: app-build (opencode) — task_complete]\nResult: https://example.test/apps/demo/",
			}),
		);

		expect(result.text).toBe("");
		expect(result.data?.visibleAttachments).toHaveLength(1);
	});

	it("does not advertise an ATTACHMENT read for a failure-prose description without stored text", async () => {
		// 2026-06-10 incident: mp4 transcription failed (no ffprobe) so the
		// attachment carried only placeholder prose in description with empty
		// text; the advertised read was unsatisfiable and the turn died in a
		// forced-tool IGNORE loop.
		const result = await attachmentsProvider.get(
			makeRuntime([]),
			makeMessage({
				text: "How can I max profit from this",
				attachments: [
					{
						id: "generated-video",
						url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
						title: "Generated_Video.mp4",
						source: "Video",
						contentType: "video",
						description: "An audio/video attachment (transcription failed)",
						text: "",
					},
				],
			}),
		);

		expect(result.text).toContain("Stored Content: none");
		expect(result.text).not.toContain("available via ATTACHMENT action=read");
	});

	it("advertises an ATTACHMENT read when readable text is stored", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([]),
			makeMessage({
				text: "How can I max profit from this",
				attachments: [
					{
						id: "generated-video",
						url: "https://cdn.discordapp.test/attachments/1/2/Generated_Video.mp4",
						title: "Generated_Video.mp4",
						source: "Video",
						contentType: "video",
						description: "A clip about the coffee shop",
						text: "welcome to the coffee shop, home of the $50 latte",
					},
				],
			}),
		);

		expect(result.text).toContain(
			"Stored Content: available via ATTACHMENT action=read",
		);
	});

	it("advertises a read for a failed-ingest image when a vision model is registered", async () => {
		// The read action re-describes IMAGEs at read time, so a working-vision
		// deploy can satisfy the read even though ingest stored only the
		// failure placeholder.
		const result = await attachmentsProvider.get(
			makeRuntime([], { hasImageDescriptionModel: true }),
			makeMessage({
				text: "what is in this image?",
				attachments: [
					{
						id: "failed-ingest-image",
						url: "https://cdn.discordapp.test/attachments/1/3/photo.png",
						title: "photo.png",
						source: "Image",
						contentType: "image",
						description: "An image attachment (recognition failed)",
						text: "",
					},
				],
			}),
		);

		expect(result.text).toContain(
			"Stored Content: available via ATTACHMENT action=read",
		);
	});

	it("does not advertise a read for a failed-ingest image without a vision model", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([], { hasImageDescriptionModel: false }),
			makeMessage({
				text: "what is in this image?",
				attachments: [
					{
						id: "failed-ingest-image",
						url: "https://cdn.discordapp.test/attachments/1/3/photo.png",
						title: "photo.png",
						source: "Image",
						contentType: "image",
						description: "An image attachment (recognition failed)",
						text: "",
					},
				],
			}),
		);

		expect(result.text).toContain("Stored Content: none");
	});
});
