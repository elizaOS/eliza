/**
 * Review-response evidence probe (#28474 finding 4, #23103): REAL end-to-end
 * context-injection evidence that pinning changes provider prompt selection,
 * on a real AgentRuntime + real PGlite SQL adapter (createTestRuntime harness),
 * real DocumentService, real documentsProvider, and the REAL pin CAS path
 * (expectedPinned fence + service retry). getService is bound to the real
 * service instance exactly as service-authorization.real.test.ts does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import {
	ChannelType,
	type Memory,
	MemoryType,
	type UUID,
} from "../../types/index.ts";
import { documentsProvider } from "./provider.ts";
import { DocumentService } from "./service.ts";

const OWNER_ID = "f4300000-0000-4000-8000-000000000040" as UUID;
const WORLD_ID = "f4300000-0000-4000-8000-000000000041" as UUID;
const ROOM_ID = "f4300000-0000-4000-8000-000000000042" as UUID;
const DOC_ID = "f4300000-0000-4000-8000-000000000043" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;

const message = (): Memory => ({
	id: "f4300000-0000-4000-8000-000000000044" as UUID,
	agentId: runtime.agentId,
	entityId: OWNER_ID,
	roomId: ROOM_ID,
	worldId: WORLD_ID,
	content: { text: "What is the weather?" },
	metadata: {},
});

describe("pin -> provider context injection (real PGlite)", () => {
	beforeAll(async () => {
		({ runtime, cleanup } = await createTestRuntime({
			characterName: "PinContextInjectionProbe",
		}));
		await runtime.ensureConnection({
			entityId: OWNER_ID,
			roomId: ROOM_ID,
			worldId: WORLD_ID,
			worldName: "Pin context injection probe",
			userName: "Document owner",
			name: "Document owner",
			source: "test",
			type: ChannelType.DM,
		});
		await runtime.ensureWorldExists({
			id: WORLD_ID,
			name: "Pin context injection probe",
			agentId: runtime.agentId,
			metadata: {
				roles: { [OWNER_ID]: "OWNER" },
				roleSources: { [OWNER_ID]: "manual" },
			},
		});
	}, 120_000);

	afterAll(async () => {
		if (cleanup) await cleanup();
	});

	it("injects the pinned document body into provider context after a real pin, and removes it after unpin", async () => {
		const document: Memory = {
			id: DOC_ID,
			agentId: runtime.agentId,
			entityId: OWNER_ID,
			roomId: ROOM_ID,
			worldId: WORLD_ID,
			createdAt: 1_000,
			content: { text: "ALWAYS TELL THE TRUTH TO THE USER." },
			metadata: {
				type: MemoryType.DOCUMENT,
				documentId: DOC_ID,
				documentRevision: 0,
				scope: "global",
				addedBy: OWNER_ID,
				addedByRole: "OWNER",
				addedFrom: "upload",
				addedAt: 1_000,
				source: "test",
				title: "Operating rules",
				timestamp: 1_000,
			},
		} as Memory;
		await runtime.createMemories([
			{ memory: document, tableName: "documents" },
		]);

		// Real service + getService binding (service-authorization.real.test.ts pattern).
		const service = new DocumentService(runtime);
		const getService = vi
			.spyOn(runtime, "getService")
			.mockImplementation((serviceType) =>
				serviceType === DocumentService.serviceType ? service : null,
			);

		// BEFORE: unpinned — body absent from provider context.
		const before = await documentsProvider.get(
			runtime as never,
			message(),
			undefined,
		);
		expect(String(before.text)).not.toContain("ALWAYS TELL THE TRUTH");
		expect(before.data?.pinnedDocumentIds ?? []).toEqual([]);

		// REAL pin through the canonical CAS path.
		await service.setDocumentPinned(DOC_ID, true, message());

		// AFTER PIN: full body injected, id reported.
		const after = await documentsProvider.get(
			runtime as never,
			message(),
			undefined,
		);
		expect(String(after.text)).toContain("ALWAYS TELL THE TRUTH TO THE USER.");
		expect(after.data?.pinnedDocumentIds).toEqual([DOC_ID]);

		// REAL unpin — body removed again.
		await service.setDocumentPinned(DOC_ID, false, message());
		const unpinned = await documentsProvider.get(
			runtime as never,
			message(),
			undefined,
		);
		expect(String(unpinned.text)).not.toContain("ALWAYS TELL THE TRUTH");
		expect(unpinned.data?.pinnedDocumentIds ?? []).toEqual([]);

		getService.mockRestore();

		// Evidence log lines (inline transcript for the PR body).
		console.log(
			"PIN-PROBE before-pin contains-body:",
			String(before.text).includes("ALWAYS TELL THE TRUTH"),
		);
		console.log(
			"PIN-PROBE after-pin contains-body:",
			String(after.text).includes("ALWAYS TELL THE TRUTH"),
		);
		console.log(
			"PIN-PROBE after-pin pinnedDocumentIds:",
			JSON.stringify(after.data?.pinnedDocumentIds),
		);
		console.log(
			"PIN-PROBE after-unpin contains-body:",
			String(unpinned.text).includes("ALWAYS TELL THE TRUTH"),
		);
		console.log(
			"PIN-PROBE verdict: PASS (pin toggles provider prompt selection end-to-end on real PGlite)",
		);
	});
});
