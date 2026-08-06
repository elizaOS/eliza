/**
 * Handler-level tests for transcript privacy actions. The fake runtime uses the
 * real `TranscriptStore` against an in-memory memories partition so assertions
 * cover the same metadata that route disclosure reads.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it, vi } from "vitest";
import { localInferencePlugin } from "../provider";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "../services/voice/transcript-store";
import {
	redactTranscriptAction,
	shareTranscriptAction,
} from "./transcript-permissioning";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const OWNER = "22222222-2222-2222-2222-222222222222" as UUID;
const ADMIN = "33333333-3333-3333-3333-333333333333" as UUID;
const VIEWER = "44444444-4444-4444-4444-444444444444" as UUID;
const STRANGER = "55555555-5555-5555-5555-555555555555" as UUID;
const TRANSCRIPT_ID = "66666666-6666-6666-6666-666666666666" as UUID;
const REDACTED_AUDIO_URL = `/api/media/${"b".repeat(64)}.wav`;

function makeTranscript(overrides: Partial<Transcript> = {}): Transcript {
	return {
		id: TRANSCRIPT_ID,
		title: "Payroll sync",
		createdAt: 1000,
		durationMs: 2000,
		audioUrl: "/api/media/original.wav",
		audioContentType: "audio/wav",
		source: "meeting",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
		metadata: {
			consent: { state: "granted" },
			participants: [
				{ id: "alice", displayName: "Alice", entityId: VIEWER },
				{ id: "carol", displayName: "Carol", entityId: STRANGER },
			],
		},
		segments: [
			{
				id: "s1",
				speakerLabel: "Alice",
				startMs: 0,
				endMs: 2000,
				text: "Email bob@example.com and use SSN 123-45-6789.",
				words: [
					{ text: "Email", startMs: 0, endMs: 200 },
					{ text: "bob@example.com", startMs: 200, endMs: 600 },
					{ text: "and", startMs: 600, endMs: 800 },
					{ text: "use", startMs: 800, endMs: 1000 },
					{ text: "SSN", startMs: 1000, endMs: 1200 },
					{ text: "123-45-6789", startMs: 1200, endMs: 1600 },
					{ text: "today", startMs: 1600, endMs: 1900 },
				],
			},
		],
		...overrides,
	};
}

function fakeRuntime(): TranscriptStoreRuntime &
	IAgentRuntime & {
		rows: Map<string, Memory>;
		reportError: ReturnType<typeof vi.fn>;
		audioRedaction: ReturnType<typeof vi.fn>;
	} {
	const rows = new Map<string, Memory>();
	const tables = new Map<string, string>();
	const reportError = vi.fn();
	const audioRedaction = vi.fn(async () => ({ url: REDACTED_AUDIO_URL }));
	return {
		rows,
		agentId: AGENT,
		reportError,
		audioRedaction,
		getService: (type: string) =>
			type === "audio-redaction" ? { redactAndVerify: audioRedaction } : null,
		getSetting: (key: string) =>
			key === "ELIZA_ADMIN_ENTITY_ID" ? ADMIN : undefined,
		getRoom: async () => null,
		getWorld: async () => null,
		getEntityById: async () => null,
		getRelationships: async () => [],
		async createMemory(memory, tableName) {
			const id = memory.id as UUID;
			rows.set(id, memory);
			tables.set(id, tableName);
			return id;
		},
		async getMemories({ tableName, roomId, orderDirection }) {
			let out = [...rows.values()].filter(
				(memory) => tables.get(memory.id as string) === tableName,
			);
			if (roomId) out = out.filter((memory) => memory.roomId === roomId);
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
	} as unknown as TranscriptStoreRuntime &
		IAgentRuntime & {
			rows: Map<string, Memory>;
			reportError: ReturnType<typeof vi.fn>;
			audioRedaction: ReturnType<typeof vi.fn>;
		};
}

function message(entityId: UUID): Memory {
	return {
		id: "77777777-7777-7777-7777-777777777777" as UUID,
		entityId,
		roomId: ROOM,
		agentId: AGENT,
		content: { text: "share the transcript", source: "test" },
	} as Memory;
}

async function seed(runtime: TranscriptStoreRuntime): Promise<TranscriptStore> {
	const store = new TranscriptStore(runtime);
	await store.create({
		roomId: ROOM,
		entityId: OWNER,
		transcript: makeTranscript(),
	});
	return store;
}

describe("transcript permission actions", () => {
	it("registers redaction and share actions on the local-inference plugin", () => {
		expect(localInferencePlugin.actions?.map((action) => action.name)).toEqual(
			expect.arrayContaining(["REDACT_TRANSCRIPT", "SHARE_TRANSCRIPT"]),
		);
		expect(redactTranscriptAction.roleGate).toEqual({ minRole: "USER" });
		expect(shareTranscriptAction.roleGate).toEqual({ minRole: "USER" });
	});

	it("creates a redacted variant before granting redacted transcript access", async () => {
		const runtime = fakeRuntime();
		const store = await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{
				parameters: {
					transcriptId: TRANSCRIPT_ID,
					entityId: VIEWER,
					mode: "redacted",
				},
			},
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			actionName: "SHARE_TRANSCRIPT",
			transcriptId: TRANSCRIPT_ID,
			entityId: VIEWER,
			mode: "redacted",
		});
		expect(result?.data?.variantId).toBeUndefined();

		const viewerTranscript = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: VIEWER,
			role: "USER",
		});
		expect(viewerTranscript?.id).toBe(TRANSCRIPT_ID);
		expect(viewerTranscript?.redacted).toBe(true);
		expect(viewerTranscript?.audioUrl).toBe(REDACTED_AUDIO_URL);
		expect(viewerTranscript?.audioUrl).not.toBe("/api/media/original.wav");
		expect(viewerTranscript?.segments[0]?.text).toContain("[EMAIL]");
		expect(viewerTranscript?.segments[0]?.text).not.toContain(
			"bob@example.com",
		);

		const adminTranscript = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: ADMIN,
			role: "ADMIN",
		});
		expect(adminTranscript?.audioUrl).toBe("/api/media/original.wav");
		expect(adminTranscript?.redacted).toBeUndefined();
		expect(runtime.audioRedaction).toHaveBeenCalledWith(
			expect.objectContaining({
				originalAudioUrl: "/api/media/original.wav",
				durationMs: 2000,
				piiSpans: expect.arrayContaining([
					expect.objectContaining({ text: "bob@example.com" }),
					expect.objectContaining({ text: "123-45-6789" }),
				]),
			}),
		);
	});

	it("lets a transcript owner create a redacted variant without changing the original", async () => {
		const runtime = fakeRuntime();
		const store = await seed(runtime);

		const result = await redactTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ parameters: { transcriptId: TRANSCRIPT_ID } },
		);

		expect(result).toMatchObject({
			success: true,
			data: {
				actionName: "REDACT_TRANSCRIPT",
				transcriptId: TRANSCRIPT_ID,
				redacted: true,
				hasAudio: true,
			},
		});
		expect(result?.data?.variantId).toBeUndefined();

		const original = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: OWNER,
			role: "USER",
			isOwner: true,
		});
		expect(original?.audioUrl).toBe("/api/media/original.wav");
		expect(original?.segments[0]?.text).toContain("bob@example.com");

		const variantId = (
			runtime.rows.get(TRANSCRIPT_ID)?.metadata as Record<string, unknown>
		)?.redactedVariantId as UUID;
		const variant = await store.get(variantId, {
			requesterEntityId: OWNER,
			role: "USER",
			isOwner: true,
		});
		expect(variant?.audioUrl).toBe(REDACTED_AUDIO_URL);
		expect(variant?.segments[0]?.text).toContain("[EMAIL]");

		const nested = await redactTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ parameters: { transcriptId: variantId } },
		);
		expect(nested).toMatchObject({
			success: false,
			error: "REDACT_TRANSCRIPT_DENIED",
		});
	});

	it("requires admin access for full transcript grants", async () => {
		const runtime = fakeRuntime();
		await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{
				parameters: {
					transcriptId: TRANSCRIPT_ID,
					entityId: VIEWER,
					mode: "full",
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "SHARE_TRANSCRIPT_DENIED",
		});
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TranscriptPermissioningDenied",
			expect.any(Error),
			expect.objectContaining({
				action: "SHARE_TRANSCRIPT",
				transcriptId: TRANSCRIPT_ID,
				entityId: VIEWER,
				requesterEntityId: OWNER,
			}),
		);
	});

	it("audits role-allowed attempts to redact another user's transcript", async () => {
		const runtime = fakeRuntime();
		await seed(runtime);

		const result = await redactTranscriptAction.handler(
			runtime,
			message(STRANGER),
			undefined,
			{ parameters: { transcriptId: TRANSCRIPT_ID } },
		);

		expect(result).toMatchObject({
			success: false,
			error: "REDACT_TRANSCRIPT_DENIED",
		});
		expect(runtime.reportError).toHaveBeenCalledWith(
			"TranscriptPermissioningDenied",
			expect.any(Error),
			expect.objectContaining({
				action: "REDACT_TRANSCRIPT",
				transcriptId: TRANSCRIPT_ID,
				requesterEntityId: STRANGER,
			}),
		);
		expect(runtime.rows.size).toBe(1);
	});

	it("rejects malformed ids before reading transcript storage", async () => {
		const runtime = fakeRuntime();
		const getMemoryById = vi.spyOn(runtime, "getMemoryById");

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{
				parameters: {
					transcriptId: "not-a-uuid",
					entityId: VIEWER,
					mode: "redacted",
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "SHARE_TRANSCRIPT_INVALID",
		});
		expect(getMemoryById).not.toHaveBeenCalled();
	});

	it("fails closed without the verifier service and writes no share grant", async () => {
		const runtime = fakeRuntime();
		runtime.getService = () => null;
		await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{
				parameters: {
					transcriptId: TRANSCRIPT_ID,
					entityId: VIEWER,
					mode: "redacted",
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "SHARE_TRANSCRIPT_FAILED",
		});
		const metadata = runtime.rows.get(TRANSCRIPT_ID)?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(metadata?.share).toBeUndefined();
		expect(metadata?.redactedVariantId).toBeUndefined();
		expect(runtime.rows.size).toBe(1);
	});

	it("lets an admin redact for the persisted room roster while privileged viewers retain full access", async () => {
		const runtime = fakeRuntime();
		const store = await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{
				parameters: {
					transcriptId: TRANSCRIPT_ID,
					redactForAll: true,
					mode: "redacted",
				},
			},
		);

		expect(result).toMatchObject({
			success: true,
			data: {
				actionName: "SHARE_TRANSCRIPT",
				transcriptId: TRANSCRIPT_ID,
				roomId: ROOM,
				entityCount: 2,
				redactForAll: true,
				mode: "redacted",
			},
		});
		for (const entityId of [VIEWER, STRANGER]) {
			const participantView = await store.get(TRANSCRIPT_ID, {
				requesterEntityId: entityId,
				role: "USER",
			});
			expect(participantView?.redacted).toBe(true);
			expect(participantView?.segments[0]?.text).not.toContain(
				"bob@example.com",
			);
		}
		const adminView = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: ADMIN,
			role: "ADMIN",
		});
		expect(adminView?.redacted).toBeUndefined();
		expect(adminView?.segments[0]?.text).toContain("bob@example.com");
		expect(runtime.rows.get(TRANSCRIPT_ID)?.metadata).toMatchObject({
			share: {
				roomSnapshot: {
					roomId: ROOM,
					entityIds: [VIEWER, STRANGER],
				},
				grants: [
					expect.objectContaining({ entityId: VIEWER, mode: "redacted" }),
					expect.objectContaining({ entityId: STRANGER, mode: "redacted" }),
				],
			},
		});
	});

	it("fails closed before variant or grant writes when consent is not affirmative", async () => {
		const runtime = fakeRuntime();
		const store = new TranscriptStore(runtime);
		await store.create({
			roomId: ROOM,
			entityId: OWNER,
			transcript: makeTranscript({
				metadata: {
					consent: { state: "revoked" },
					participants: [
						{ id: "alice", displayName: "Alice", entityId: VIEWER },
					],
				},
			}),
		});

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{
				parameters: {
					transcriptId: TRANSCRIPT_ID,
					entityId: VIEWER,
					mode: "redacted",
				},
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: "SHARE_TRANSCRIPT_CONSENT_REQUIRED",
		});
		const metadata = runtime.rows.get(TRANSCRIPT_ID)?.metadata as
			| Record<string, unknown>
			| undefined;
		expect(metadata?.share).toBeUndefined();
		expect(metadata?.redactedVariantId).toBeUndefined();
		expect(runtime.rows.size).toBe(1);
	});
});
