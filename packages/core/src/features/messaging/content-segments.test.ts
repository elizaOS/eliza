/**
 * Deterministic unit coverage for native message/attachment source projection:
 * exercises Unicode-safe segmentation, bounded traversal, identity stability,
 * and fail-explicit missing, repeated, overlapping, and corrupt rows.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { ContentType, type Media, type Memory, type UUID } from "../../types";
import { createHash } from "../../utils/crypto-compat";
import {
	attachmentTextSourceDescriptor,
	authorizeMessageContentRead,
	buildMessageContentProjection,
	collectMessageContentSegmentIds,
	MESSAGE_CONTENT_READ_MAX_SEGMENTS,
	MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
	messageTextSourceDescriptor,
	readMessageContentProjection,
} from "./content-segments";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const AGENT_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const ENTITY_ID = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM_ID = "44444444-4444-4444-8444-444444444444" as UUID;

function memory(text: string, attachments?: Media[]): Memory & { id: UUID } {
	return {
		id: MESSAGE_ID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		createdAt: 1_700_000_000_000,
		content: { text, ...(attachments ? { attachments } : {}) },
	};
}

function rowsForRange(
	segments: Memory[],
	offset: number,
	limit: number,
): Memory[] {
	const requestedEnd = offset + limit;
	return segments
		.filter((segment) => {
			const metadata = segment.metadata as Record<string, unknown>;
			return (
				typeof metadata.byteStart === "number" &&
				typeof metadata.byteEnd === "number" &&
				metadata.byteEnd > offset &&
				metadata.byteStart < requestedEnd
			);
		})
		.slice(0, MESSAGE_CONTENT_READ_MAX_SEGMENTS);
}

describe("message content segments", () => {
	it("publishes, replaces by CAS, and reauthorizes in memory", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
		const original = memory("first revision 🙂\n".repeat(20_000));
		original.metadata = { type: "message", scope: "room" };
		const firstProjection = buildMessageContentProjection(original);
		await expect(
			adapter.publishMessageContentSegments({
				mode: "create",
				parent: { ...original, content: firstProjection.content },
				segments: firstProjection.segments,
			}),
		).resolves.toMatchObject({ status: "created" });
		const firstRead = await adapter.readMessageContentRange({
			agentId: AGENT_ID,
			messageId: MESSAGE_ID,
			authorizedRoomId: ROOM_ID,
			accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
			source: { kind: "message-text" },
			offset: 0,
			limit: 32 * 1024,
		});
		expect(firstRead.status).toBe("ok");
		if (firstRead.status !== "ok") throw new Error("expected segmented read");

		const replacement = {
			...original,
			content: {
				...original.content,
				text: "second revision 漢字\n".repeat(20_000),
			},
		};
		const secondProjection = buildMessageContentProjection(replacement);
		await expect(
			adapter.publishMessageContentSegments({
				mode: "replace",
				agentId: AGENT_ID,
				messageId: MESSAGE_ID,
				expectedContent: firstProjection.content,
				replacementContent: secondProjection.content,
				segments: secondProjection.segments,
				removeSegmentIds: collectMessageContentSegmentIds(
					MESSAGE_ID,
					firstProjection.content,
				),
			}),
		).resolves.toMatchObject({ status: "updated" });
		await expect(
			adapter.readMessageContentRange({
				agentId: AGENT_ID,
				messageId: MESSAGE_ID,
				authorizedRoomId: ROOM_ID,
				accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
				source: { kind: "message-text" },
				offset: firstRead.page.end,
				limit: 32 * 1024,
				expectedRevision: firstRead.page.revision,
			}),
		).rejects.toMatchObject({ code: "MESSAGE_CONTENT_STALE_REVISION" });
		await adapter.deleteParticipants([
			{ entityId: ENTITY_ID, roomId: ROOM_ID },
		]);
		await expect(
			adapter.readMessageContentRange({
				agentId: AGENT_ID,
				messageId: MESSAGE_ID,
				authorizedRoomId: ROOM_ID,
				accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
				source: { kind: "message-text" },
				offset: 0,
				limit: 1024,
			}),
		).resolves.toEqual({ status: "forbidden" });
	});

	it("rejects oversized legacy inline sources with a typed reindex error", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.createRoomParticipants([ENTITY_ID], ROOM_ID);
		await adapter.createMemories([
			{
				tableName: "messages",
				memory: {
					...memory("legacy source ".repeat(8_000)),
					metadata: { type: "message", scope: "room" },
				},
			},
		]);
		await expect(
			adapter.readMessageContentRange({
				agentId: AGENT_ID,
				messageId: MESSAGE_ID,
				authorizedRoomId: ROOM_ID,
				accessContext: { requesterEntityId: ENTITY_ID, role: "USER" },
				source: { kind: "message-text" },
				offset: 0,
				limit: 1024,
			}),
		).rejects.toMatchObject({ code: "MESSAGE_REINDEX_REQUIRED" });
	});

	it("projects deterministic complete UTF-8 rows and a content-free parent", () => {
		const text = "🙂漢字e\u0301\n".repeat(12_000);
		const first = buildMessageContentProjection(memory(text));
		const second = buildMessageContentProjection(memory(text));
		const descriptor = messageTextSourceDescriptor(first.content);
		expect(descriptor).not.toBeNull();
		expect(first.content.text).toBeUndefined();
		expect(JSON.stringify(first.content)).not.toContain(text.slice(-256));
		expect(first.segments.map(({ id }) => id)).toEqual(
			second.segments.map(({ id }) => id),
		);
		expect(first.segments.length).toBeGreaterThan(1);
		for (const segment of first.segments) {
			const stored = new TextEncoder().encode(segment.content.text ?? "");
			expect(stored.length).toBeLessThanOrEqual(
				MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
			);
			expect(() =>
				new TextDecoder("utf-8", { fatal: true }).decode(stored),
			).not.toThrow();
		}
	});

	it("accepts deterministic elizaOS parent IDs with non-RFC version nibbles", () => {
		const projection = buildMessageContentProjection({
			...memory("non-rfc parent\n".repeat(20_000)),
			id: "af14ea58-6002-0262-999b-708b87c485dd" as UUID,
		});
		expect(projection.segments.length).toBeGreaterThan(0);
		expect(projection.segments.every((segment) => segment.id)).toBe(true);
		expect(new Set(projection.segments.map((segment) => segment.id)).size).toBe(
			projection.segments.length,
		);
	});

	it("traverses a 1 MiB Unicode message with bounded rows and exact SHA", () => {
		const block = "prefix🙂עברית漢字e\u0301\r\n";
		const text = block.repeat(Math.ceil((1024 * 1024) / block.length));
		const projection = buildMessageContentProjection(memory(text));
		const descriptor = messageTextSourceDescriptor(projection.content);
		expect(descriptor).not.toBeNull();
		if (!descriptor) throw new Error("missing descriptor");
		let offset = 0;
		let rebuilt = "";
		while (offset < descriptor.byteLength) {
			const rows = rowsForRange(
				projection.segments,
				offset,
				MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
			);
			const page = readMessageContentProjection({
				descriptor,
				segments: rows,
				messageId: MESSAGE_ID,
				offset,
				limit: MESSAGE_CONTENT_SEGMENT_MAX_BYTES,
			});
			expect(page.returnedSegments).toBeLessThanOrEqual(
				MESSAGE_CONTENT_READ_MAX_SEGMENTS,
			);
			expect(page.end).toBeGreaterThan(offset);
			rebuilt += page.text;
			offset = page.end;
		}
		expect(rebuilt).toBe(text);
		expect(createHash("sha256").update(rebuilt).digest("hex")).toBe(
			descriptor.sha256,
		);
	});

	it("projects attachment text independently with an owner-bound hash", () => {
		const attachmentText = "late attachment canary 🙂\n".repeat(5_000);
		const attachment: Media = {
			id: "private-attachment-id",
			url: "/api/media/example.txt",
			text: attachmentText,
			contentType: ContentType.DOCUMENT,
		};
		const projection = buildMessageContentProjection(
			memory("small", [attachment]),
		);
		const stored = projection.content.attachments?.[0];
		expect(stored?.text).toBeUndefined();
		const descriptor = stored ? attachmentTextSourceDescriptor(stored) : null;
		expect(descriptor?.attachmentIdHash).toMatch(/^[a-f0-9]{64}$/u);
		expect(JSON.stringify(projection.segments)).not.toContain(
			"private-attachment-id",
		);
	});

	it("reauthorizes every page and denies revoked or redacted readers", () => {
		const projection = buildMessageContentProjection(
			memory("authorized source ".repeat(8_000)),
		);
		const parent = { ...memory("placeholder"), content: projection.content };
		const requester = { requesterEntityId: ENTITY_ID, role: "USER" as const };
		expect(
			authorizeMessageContentRead({
				parent,
				authorizedRoomId: ROOM_ID,
				requester,
				agentId: AGENT_ID,
				participantCurrent: true,
				selector: { kind: "message-text" },
			}),
		).toBe(true);
		expect(
			authorizeMessageContentRead({
				parent,
				authorizedRoomId: ROOM_ID,
				requester,
				agentId: AGENT_ID,
				participantCurrent: false,
				selector: { kind: "message-text" },
			}),
		).toBe(false);
		const redactedParent: Memory = {
			...parent,
			metadata: {
				type: "message",
				scope: "room",
				share: {
					grants: [{ entityId: ENTITY_ID, mode: "redacted" }],
				},
			},
		};
		expect(
			authorizeMessageContentRead({
				parent: redactedParent,
				authorizedRoomId: ROOM_ID,
				requester,
				agentId: AGENT_ID,
				participantCurrent: true,
				selector: { kind: "message-text" },
			}),
		).toBe(false);
	});

	it.each([
		["missing", (rows: Memory[]) => rows.slice(1)],
		["repeat", (rows: Memory[]) => [rows[0], rows[0], ...rows.slice(1)]],
		[
			"overlap",
			(rows: Memory[]) => {
				const changed = structuredClone(rows);
				if (changed[1]) {
					const metadata = changed[1].metadata as Record<string, unknown>;
					metadata.byteStart = (metadata.byteStart as number) - 1;
				}
				return changed;
			},
		],
		[
			"digest",
			(rows: Memory[]) => {
				const changed = structuredClone(rows);
				if (changed[0]) changed[0].content.text = `x${changed[0].content.text}`;
				return changed;
			},
		],
	] as const)("rejects %s segment corruption", (_name, mutate) => {
		const text = "a".repeat(MESSAGE_CONTENT_SEGMENT_MAX_BYTES * 2 + 100);
		const projection = buildMessageContentProjection(memory(text));
		const descriptor = messageTextSourceDescriptor(projection.content);
		if (!descriptor) throw new Error("missing descriptor");
		const rows = rowsForRange(
			projection.segments,
			MESSAGE_CONTENT_SEGMENT_MAX_BYTES - 10,
			100,
		);
		expect(() =>
			readMessageContentProjection({
				descriptor,
				segments: mutate(rows),
				messageId: MESSAGE_ID,
				offset: MESSAGE_CONTENT_SEGMENT_MAX_BYTES - 10,
				limit: 100,
			}),
		).toThrow();
	});
});
