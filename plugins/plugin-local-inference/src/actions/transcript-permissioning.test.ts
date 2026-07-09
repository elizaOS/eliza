/**
 * Handler-level tests for transcript privacy actions. The fake runtime uses the
 * real `TranscriptStore` against an in-memory memories partition so assertions
 * cover the same metadata that route disclosure reads.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localInferencePlugin } from "../provider";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "../services/voice/transcript-store";
import {
	type RoleAccessCheck,
	redactTranscriptAction,
	resetTranscriptPermissioningRoleAccessForTests,
	setTranscriptPermissioningRoleAccessForTests,
	shareTranscriptAction,
} from "./transcript-permissioning";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const OWNER = "22222222-2222-2222-2222-222222222222" as UUID;
const ADMIN = "33333333-3333-3333-3333-333333333333" as UUID;
const VIEWER = "44444444-4444-4444-4444-444444444444" as UUID;
const STRANGER = "55555555-5555-5555-5555-555555555555" as UUID;
const TRANSCRIPT_ID = "66666666-6666-6666-6666-666666666666" as UUID;

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
		segments: [
			{
				id: "s1",
				speakerLabel: "Alice",
				startMs: 0,
				endMs: 2000,
				text: "Email bob@example.com and use SSN 123-45-6789.",
				words: [{ text: "bob@example.com", startMs: 0, endMs: 500 }],
			},
		],
		...overrides,
	};
}

function fakeRuntime(): TranscriptStoreRuntime &
	IAgentRuntime & {
		rows: Map<string, Memory>;
		reportError: ReturnType<typeof vi.fn>;
	} {
	const rows = new Map<string, Memory>();
	const tables = new Map<string, string>();
	const reportError = vi.fn();
	return {
		rows,
		agentId: AGENT,
		reportError,
		getService: () => null,
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

function setRoles(check: RoleAccessCheck): void {
	setTranscriptPermissioningRoleAccessForTests(check);
}

describe("transcript permission actions", () => {
	afterEach(() => {
		resetTranscriptPermissioningRoleAccessForTests();
	});

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
		setRoles(
			async (_runtime, _message, role) => role === "USER" || role === "ADMIN",
		);

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
		expect(result?.data?.variantId).toEqual(expect.any(String));

		const viewerTranscript = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: VIEWER,
			role: "USER",
		});
		expect(viewerTranscript?.id).toBe(TRANSCRIPT_ID);
		expect(viewerTranscript?.redacted).toBe(true);
		expect(viewerTranscript?.audioUrl).toBeUndefined();
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
	});

	it("lets a transcript owner create a redacted variant without changing the original", async () => {
		const runtime = fakeRuntime();
		const store = await seed(runtime);
		setRoles(async (_runtime, _message, role) => role === "USER");

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
				hasAudio: false,
			},
		});
		expect(result?.data?.variantId).toEqual(expect.any(String));

		const original = await store.get(TRANSCRIPT_ID, {
			requesterEntityId: OWNER,
			role: "USER",
			isOwner: true,
		});
		expect(original?.audioUrl).toBe("/api/media/original.wav");
		expect(original?.segments[0]?.text).toContain("bob@example.com");

		const variantId = result?.data?.variantId as UUID;
		const variant = await store.get(variantId, {
			requesterEntityId: OWNER,
			role: "USER",
			isOwner: true,
		});
		expect(variant?.audioUrl).toBeUndefined();
		expect(variant?.segments[0]?.text).toContain("[EMAIL]");
	});

	it("requires admin access for full transcript grants", async () => {
		const runtime = fakeRuntime();
		await seed(runtime);
		setRoles(async (_runtime, _message, role) => role === "USER");

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
		setRoles(async (_runtime, _message, role) => role === "USER");

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
});
