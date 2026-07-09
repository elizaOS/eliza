/** Covers `TranscriptStore` persistence. Deterministic, temp store. */
import type { Memory, UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import {
	TRANSCRIPTS_TABLE,
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "./transcript-store";

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		title: "Standup",
		createdAt: 1000,
		durationMs: 2000,
		audioUrl: "/api/media/x.wav",
		source: "voice-session",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
		segments: [
			{
				id: "s1",
				speakerLabel: "Alice",
				startMs: 0,
				endMs: 2000,
				text: "hello world",
				words: [{ text: "hello", startMs: 0, endMs: 1000 }],
			},
		],
		...over,
	};
}

/** In-memory fake runtime backing the memory partition. */
function fakeRuntime(): TranscriptStoreRuntime & { rows: Map<string, Memory> } {
	const rows = new Map<string, Memory>();
	const tables = new Map<string, string>();
	return {
		rows,
		agentId: "agent-1" as UUID,
		async createMemory(memory, tableName) {
			const id = memory.id as UUID;
			rows.set(id, memory);
			tables.set(id, tableName);
			return id;
		},
		async getMemories({ tableName, roomId, orderDirection }) {
			let out = [...rows.values()].filter(
				(m) => tables.get(m.id as string) === tableName,
			);
			if (roomId) out = out.filter((m) => m.roomId === roomId);
			out.sort((a, b) =>
				orderDirection === "asc"
					? (a.createdAt ?? 0) - (b.createdAt ?? 0)
					: (b.createdAt ?? 0) - (a.createdAt ?? 0),
			);
			return out;
		},
		async getMemoryById(id) {
			return rows.get(id) ?? null;
		},
		async updateMemory(memory) {
			const existing = rows.get(memory.id);
			if (!existing) return false;
			rows.set(memory.id, { ...existing, ...memory });
			return true;
		},
		async deleteMemory(id) {
			rows.delete(id);
		},
	};
}

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

describe("TranscriptStore", () => {
	it("persists into the transcripts partition and round-trips the full record", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });

		// Stored as one memory row with the full transcript in content.transcript.
		const row = rt.rows.get(t.id) as Memory;
		expect(row.roomId).toBe(ROOM);
		expect(row.entityId).toBe(ENTITY);
		expect(row.metadata?.type).toBe("custom");
		expect(row.metadata?.source).toBe("transcript");
		// The full record is stored as a JSON blob in content.transcript.
		expect(typeof (row.content as { transcript: string }).transcript).toBe(
			"string",
		);
		// A text preview body is present for generic memory consumers.
		expect(row.content.text).toBe("hello world");

		// store.get parses the blob back into the exact record.
		const got = await store.get(t.id as UUID);
		expect(got).toEqual(t);
	});

	it("lists newest-first summaries scoped to a room", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		await store.create({
			roomId: ROOM,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000aa",
				title: "Older",
				createdAt: 1000,
			}),
		});
		await store.create({
			roomId: ROOM,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000bb",
				title: "Newer",
				createdAt: 2000,
			}),
		});
		// A transcript in a different room must not appear.
		await store.create({
			roomId: "33333333-3333-3333-3333-333333333333" as UUID,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000cc",
				title: "Other room",
				createdAt: 3000,
			}),
		});

		const list = await store.list(ROOM);
		expect(list.map((s) => s.title)).toEqual(["Newer", "Older"]);
		expect(list[0]).toMatchObject({
			durationMs: 2000,
			hasAudio: true,
			status: "ready",
		});
	});

	it("returns null for a missing id and deletes a record", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		expect(
			await store.get("deadbeef-0000-0000-0000-000000000000" as UUID),
		).toBeNull();
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });
		await store.delete(t.id as UUID);
		expect(await store.get(t.id as UUID)).toBeNull();
	});

	it("updates a record in place and re-derives the preview + metadata", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });

		const edited: Transcript = {
			...t,
			title: "Standup (edited)",
			segments: [{ ...t.segments[0], text: "hello edited world", words: [] }],
			editedAt: 5000,
		};
		const returned = await store.update(edited);
		expect(returned).toEqual(edited);

		// Same row id, overwritten content + re-derived preview text.
		const row = rt.rows.get(t.id) as Memory;
		expect(rt.rows.size).toBe(1);
		expect(row.content.text).toBe("hello edited world");
		expect(row.metadata?.transcriptId).toBe(t.id);
		// store.get round-trips the edited record exactly.
		expect(await store.get(t.id as UUID)).toEqual(edited);
	});

	it("throws when updating a record that does not exist", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		await expect(store.update(makeTranscript())).rejects.toThrow(/not found/);
	});

	it("exposes the partition name", () => {
		expect(TRANSCRIPTS_TABLE).toBe("transcripts");
	});

	describe("per-viewer disclosure selection (#14781)", () => {
		const VIEWER = "44444444-4444-4444-4444-444444444444" as UUID;
		const STRANGER = "55555555-5555-5555-5555-555555555555" as UUID;
		const ORIGINAL_ID = "00000000-0000-0000-0000-00000000or11";
		const VARIANT_ID = "00000000-0000-0000-0000-00000000va22";

		/** Original (owner-private, with audio) + linked redacted variant. */
		async function seed(rt: ReturnType<typeof fakeRuntime>) {
			const store = new TranscriptStore(rt);
			const original = makeTranscript({
				id: ORIGINAL_ID,
				title: "Payroll sync",
				createdAt: 1000,
				segments: [
					{
						id: "s1",
						speakerLabel: "Alice",
						startMs: 0,
						endMs: 2000,
						text: "Bob's SSN is 123-45-6789",
						words: [],
					},
				],
			});
			const variant = makeTranscript({
				id: VARIANT_ID,
				title: "Payroll sync (redacted)",
				createdAt: 1500,
				audioUrl: undefined,
				segments: [
					{
						id: "s1",
						speakerLabel: "Alice",
						startMs: 0,
						endMs: 2000,
						text: "Bob's SSN is [REDACTED]",
						words: [],
					},
				],
			});
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: original,
			});
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: variant,
			});
			// Read contract this issue owns; the write path is PERM-REDACT's
			// (#14779): original links its variant, variant backlinks its original,
			// and the redacted grant for VIEWER sits on the original's row.
			const originalRow = rt.rows.get(ORIGINAL_ID) as Memory;
			rt.rows.set(ORIGINAL_ID, {
				...originalRow,
				metadata: {
					...(originalRow.metadata as Record<string, unknown>),
					redactedVariantId: VARIANT_ID,
					share: { grants: [{ entityId: VIEWER, mode: "redacted" }] },
				} as Memory["metadata"],
			});
			const variantRow = rt.rows.get(VARIANT_ID) as Memory;
			rt.rows.set(VARIANT_ID, {
				...variantRow,
				metadata: {
					...(variantRow.metadata as Record<string, unknown>),
					redactionOf: ORIGINAL_ID,
				} as Memory["metadata"],
			});
			return { store, original, variant };
		}

		it("OWNER boundary (no context) and ADMIN rank see the full original", async () => {
			const rt = fakeRuntime();
			const { store, original } = await seed(rt);

			// No access context: single-owner boundary, full record.
			expect(await store.get(ORIGINAL_ID as UUID)).toEqual(original);

			// ADMIN rank context: full record with audio.
			const admin = { requesterEntityId: STRANGER, role: "ADMIN" as const };
			const got = await store.get(ORIGINAL_ID as UUID, admin);
			expect(got).toEqual(original);
			const list = await store.list(ROOM, 100, admin);
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({ id: ORIGINAL_ID, hasAudio: true });
			expect(list[0].redacted).toBeUndefined();
		});

		it("USER with a redacted grant gets the variant under the ORIGINAL id, flagged, audio withheld", async () => {
			const rt = fakeRuntime();
			const { store } = await seed(rt);
			const viewer = { requesterEntityId: VIEWER, role: "USER" as const };

			const got = await store.get(ORIGINAL_ID as UUID, viewer);
			expect(got).not.toBeNull();
			expect(got?.id).toBe(ORIGINAL_ID);
			expect(got?.redacted).toBe(true);
			expect(got?.audioUrl).toBeUndefined();
			expect(got?.audioContentType).toBeUndefined();
			expect(got?.segments[0]?.text).toBe("Bob's SSN is [REDACTED]");
			expect(got?.title).toBe("Payroll sync (redacted)");
			// Identity comes from the original, content from the variant.
			expect(got?.createdAt).toBe(1000);

			const list = await store.list(ROOM, 100, viewer);
			expect(list).toHaveLength(1);
			expect(list[0]).toMatchObject({
				id: ORIGINAL_ID,
				redacted: true,
				hasAudio: false,
			});
			expect(list[0].preview).toContain("[REDACTED]");
			expect(list[0].preview).not.toContain("123-45-6789");
		});

		it("USER with a full grant sees the original in full", async () => {
			const rt = fakeRuntime();
			const { store, original } = await seed(rt);
			const originalRow = rt.rows.get(ORIGINAL_ID) as Memory;
			rt.rows.set(ORIGINAL_ID, {
				...originalRow,
				metadata: {
					...(originalRow.metadata as Record<string, unknown>),
					share: { grants: [{ entityId: VIEWER, mode: "full" }] },
				} as Memory["metadata"],
			});
			const viewer = { requesterEntityId: VIEWER, role: "USER" as const };
			expect(await store.get(ORIGINAL_ID as UUID, viewer)).toEqual(original);
		});

		it("ungranted USER and GUEST see nothing: omitted from list, null on get", async () => {
			const rt = fakeRuntime();
			const { store } = await seed(rt);
			for (const role of ["USER", "GUEST"] as const) {
				const ctx = { requesterEntityId: STRANGER, role };
				expect(await store.get(ORIGINAL_ID as UUID, ctx)).toBeNull();
				expect(await store.get(VARIANT_ID as UUID, ctx)).toBeNull();
				expect(await store.list(ROOM, 100, ctx)).toEqual([]);
			}
		});

		it("variant rows never appear as standalone list rows", async () => {
			const rt = fakeRuntime();
			const { store } = await seed(rt);
			const list = await store.list(ROOM);
			expect(list.map((s) => s.id)).toEqual([ORIGINAL_ID]);
		});

		it("a redacted grant with a missing variant discloses NOTHING (fail closed)", async () => {
			const rt = fakeRuntime();
			const { store } = await seed(rt);
			rt.rows.delete(VARIANT_ID);
			const viewer = { requesterEntityId: VIEWER, role: "USER" as const };
			expect(await store.get(ORIGINAL_ID as UUID, viewer)).toBeNull();
			expect(await store.list(ROOM, 100, viewer)).toEqual([]);
		});

		it("share grants and variant links survive a text edit (update preserves metadata)", async () => {
			const rt = fakeRuntime();
			const { store, original } = await seed(rt);
			await store.update({
				...original,
				title: "Payroll sync (edited)",
				editedAt: 9000,
			});
			const row = rt.rows.get(ORIGINAL_ID) as Memory;
			const meta = row.metadata as Record<string, unknown>;
			expect(meta.redactedVariantId).toBe(VARIANT_ID);
			expect(meta.share).toEqual({
				grants: [{ entityId: VIEWER, mode: "redacted" }],
			});
			// The redacted-grant viewer still gets the variant after the edit.
			const viewer = { requesterEntityId: VIEWER, role: "USER" as const };
			expect((await store.get(ORIGINAL_ID as UUID, viewer))?.redacted).toBe(
				true,
			);
		});

		it("creates a deterministic redacted variant without mutating the original or audio", async () => {
			const rt = fakeRuntime();
			const store = new TranscriptStore(rt);
			const original = makeTranscript({
				id: ORIGINAL_ID,
				title: "Payroll sync",
				audioUrl: "/api/media/original.wav",
				audioContentType: "audio/wav",
				segments: [
					{
						id: "s1",
						speakerLabel: "Alice",
						startMs: 0,
						endMs: 2000,
						text: "Email bob@example.com and use SSN 123-45-6789.",
						words: [
							{
								text: "bob@example.com",
								startMs: 0,
								endMs: 1000,
							},
						],
					},
				],
			});
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: original,
			});

			const first = await store.createRedactedVariant({
				originalId: ORIGINAL_ID as UUID,
				redactedBy: VIEWER,
				seed: "fixed",
				nowMs: 3000,
			});
			const second = await store.createRedactedVariant({
				originalId: ORIGINAL_ID as UUID,
				redactedBy: VIEWER,
				seed: "fixed",
				nowMs: 3000,
			});

			expect(second.id).toBe(first.id);
			expect(first.audioUrl).toBeUndefined();
			expect(first.audioContentType).toBeUndefined();
			expect(first.segments[0]?.text).toContain("[EMAIL]");
			expect(first.segments[0]?.text).toContain("[SSN]");
			expect(first.segments[0]?.text).not.toContain("bob@example.com");
			expect(first.segments[0]?.text).not.toContain("123-45-6789");
			expect(first.segments[0]?.words[0]?.text).toBe("[EMAIL]");

			const originalAfter = await store.get(ORIGINAL_ID as UUID);
			expect(originalAfter).toEqual(original);
			const originalMeta = (rt.rows.get(ORIGINAL_ID) as Memory)
				.metadata as Record<string, unknown>;
			expect(originalMeta.redactedVariantId).toBe(first.id);
			const variantMeta = (rt.rows.get(first.id) as Memory).metadata as Record<
				string,
				unknown
			>;
			expect(variantMeta.redactionOf).toBe(ORIGINAL_ID);
			expect(variantMeta.redactedBy).toBe(VIEWER);
		});

		it("keeps seeded redacted variant ids scoped to the original transcript", async () => {
			const rt = fakeRuntime();
			const store = new TranscriptStore(rt);
			const firstId = "00000000-0000-4000-8000-000000000101";
			const secondId = "00000000-0000-4000-8000-000000000202";
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: makeTranscript({ id: firstId }),
			});
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: makeTranscript({ id: secondId }),
			});

			const first = await store.createRedactedVariant({
				originalId: firstId as UUID,
				seed: "same-seed",
				nowMs: 3000,
			});
			const second = await store.createRedactedVariant({
				originalId: secondId as UUID,
				seed: "same-seed",
				nowMs: 3000,
			});

			expect(first.id).not.toBe(second.id);
			expect((rt.rows.get(firstId) as Memory).metadata).toMatchObject({
				redactedVariantId: first.id,
			});
			expect((rt.rows.get(secondId) as Memory).metadata).toMatchObject({
				redactedVariantId: second.id,
			});
		});

		it("adds and replaces transcript share grants on the original row", async () => {
			const rt = fakeRuntime();
			const store = new TranscriptStore(rt);
			await store.create({
				roomId: ROOM,
				entityId: ENTITY,
				transcript: makeTranscript({ id: ORIGINAL_ID }),
			});

			await store.share({
				transcriptId: ORIGINAL_ID as UUID,
				entityId: VIEWER,
				mode: "redacted",
				grantedBy: ENTITY,
				grantedAtMs: 4000,
			});
			await store.share({
				transcriptId: ORIGINAL_ID as UUID,
				entityId: VIEWER,
				mode: "full",
				grantedBy: ENTITY,
				grantedAtMs: 5000,
			});

			const row = rt.rows.get(ORIGINAL_ID) as Memory;
			expect((row.metadata as Record<string, unknown>).share).toEqual({
				grants: [
					{
						entityId: VIEWER,
						mode: "full",
						grantedBy: ENTITY,
						grantedAtMs: 5000,
					},
				],
			});
		});

		it("refuses to attach grants to a redacted variant row", async () => {
			const rt = fakeRuntime();
			const { store } = await seed(rt);
			await expect(
				store.share({
					transcriptId: VARIANT_ID as UUID,
					entityId: VIEWER,
					mode: "full",
				}),
			).rejects.toThrow(/original transcript/);
		});
	});
});
