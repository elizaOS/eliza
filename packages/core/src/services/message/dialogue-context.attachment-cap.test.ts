/**
 * Link attachments carry the complete fetched page text (33.5K characters on
 * one live turn, 2026-09-13) and the message:user block inlined all of it. The
 * rendered copy is capped per attachment and per message, head-preserving with
 * a marker, while the stored attachment stays complete.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import type { Media, UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import {
	ATTACHMENT_TEXT_MAX_CHARS,
	ATTACHMENTS_TOTAL_MAX_CHARS,
	attachmentTextCaps,
	capAttachmentsForContext,
	currentMessageContentForContext,
	verifiedCrossRoomContent,
} from "./dialogue-context";

const USER_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;

function link(index: number, text: string, description?: string): Media {
	return {
		id: `webpage-${index}`,
		url: `https://example.test/${index}`,
		title: "Web Page",
		source: "Web",
		contentType: "link",
		text,
		...(description === undefined ? {} : { description }),
	};
}

function message(attachments: Media[]): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text: "look at this", source: "test", attachments },
		createdAt: 1_000,
	} as Memory;
}

function runtimeWith(
	settings: Record<string, string>,
): Pick<IAgentRuntime, "getSetting"> {
	return { getSetting: (key: string) => settings[key] ?? null };
}

describe("attachment text caps", () => {
	it("leaves a short attachment untouched and keeps the content identity", () => {
		const attachments = [link(1, "a short page", "a short summary")];
		expect(capAttachmentsForContext(attachments, attachmentTextCaps())).toBe(
			attachments,
		);
		const memory = message(attachments);
		expect(currentMessageContentForContext(memory)).toBe(memory.content);
		expect(currentMessageContentForContext(memory, runtimeWith({}))).toBe(
			memory.content,
		);
	});

	it("truncates a long attachment head-first with a marker and leaves the stored memory complete", () => {
		const page = `${"a".repeat(9_000)}TAIL`;
		const memory = message([link(1, page)]);

		const content = currentMessageContentForContext(memory);

		const rendered = content.attachments?.[0]?.text ?? "";
		expect(rendered.startsWith("a".repeat(ATTACHMENT_TEXT_MAX_CHARS))).toBe(
			true,
		);
		expect(rendered).toBe(
			`${"a".repeat(ATTACHMENT_TEXT_MAX_CHARS)} [truncated ${page.length - ATTACHMENT_TEXT_MAX_CHARS} chars]`,
		);
		expect(rendered).not.toContain("TAIL");
		expect(content.text).toBe("look at this");
		expect(content.attachments?.[0]?.url).toBe("https://example.test/1");
		expect(memory.content.attachments?.[0]?.text).toBe(page);
		expect(memory.content.attachments?.[0]?.text).toHaveLength(page.length);
	});

	it("spreads the per-message total across three long attachments", () => {
		const caps = attachmentTextCaps(
			runtimeWith({
				ATTACHMENT_TEXT_MAX_CHARS: "4000",
				ATTACHMENTS_TOTAL_MAX_CHARS: "10000",
			}),
		);
		expect(caps).toEqual({ perAttachment: 4_000, total: 10_000 });

		const capped =
			capAttachmentsForContext(
				[
					link(1, "a".repeat(9_000)),
					link(2, "b".repeat(9_000)),
					link(3, "c".repeat(9_000)),
				],
				caps,
			) ?? [];

		expect(capped.map((attachment) => attachment.text)).toEqual([
			`${"a".repeat(4_000)} [truncated 5000 chars]`,
			`${"b".repeat(4_000)} [truncated 5000 chars]`,
			`${"c".repeat(2_000)} [truncated 7000 chars]`,
		]);

		const defaults =
			capAttachmentsForContext(
				[1, 2, 3, 4].map((index) => link(index, "z".repeat(9_000))),
				attachmentTextCaps(),
			) ?? [];
		expect(defaults[3]?.text).toBe("[truncated 9000 chars]");
		const marker = " [truncated 9000 chars]".length;
		const inlined = defaults.reduce(
			(total, attachment) => total + (attachment.text?.length ?? 0),
			0,
		);
		expect(inlined).toBeLessThanOrEqual(
			ATTACHMENTS_TOTAL_MAX_CHARS + 4 * marker,
		);
	});

	it("caps the readable text of verified cross-room attachments the same way", () => {
		const memory = message([
			{
				id: "webpage-1",
				url: "https://example.test/1",
				title: "Web Page",
				description: "d".repeat(9_000),
			},
		]);
		const rendered = verifiedCrossRoomContent(memory, attachmentTextCaps());
		expect(rendered).toContain(
			`${"d".repeat(ATTACHMENT_TEXT_MAX_CHARS)} [truncated 5000 chars]`,
		);
		expect(rendered).not.toContain("d".repeat(ATTACHMENT_TEXT_MAX_CHARS + 1));
		expect(verifiedCrossRoomContent(memory)).toContain("d".repeat(9_000));
	});
});
