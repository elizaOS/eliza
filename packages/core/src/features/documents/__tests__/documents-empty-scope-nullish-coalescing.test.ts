/**
 * Regression coverage for the worldId `|| agentId` → `?? agentId` hardening
 * across docs-loader.ts, document-processor.ts, and service.ts.
 *
 * `||` collapses an explicit empty-string worldId (a real sentinel used
 * elsewhere in this codebase, e.g. `clientDocumentId: "" as UUID`) into the
 * agent's own id, silently widening a document's tenant scope. `??` only
 * falls back when the caller omitted the value (`undefined`).
 *
 * roomId and entityId deliberately keep `||`: every persisted document must
 * satisfy `readDocumentMutationSnapshot`'s `isUuid(roomId)` / `isUuid(entityId)`
 * gate (`database/document-list-query.ts`) to stay listable/mutable/visible at
 * all, and "" is never a valid UUID. Switching those two to `??` was verified
 * against a real `DocumentService.addDocument` call below: it makes
 * `addDocument` itself throw `DOCUMENT_INGESTION_IN_PROGRESS` (the freshly
 * written document fails its own post-write readability check), which is
 * worse than the tenant-scope concern it would have "fixed". worldId carries
 * no such gate, so preserving "" there is safe.
 *
 * These tests drive real persistence through `DocumentService.addDocument`
 * (both the auto-fragmentation and pre-chunked-fragments paths) and the real
 * `addDocumentFromFilePath` call boundary.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../database/inMemoryAdapter";
import { AgentRuntime } from "../../../runtime";
import type { Character, Memory, UUID } from "../../../types";
import { addDocumentFromFilePath } from "../docs-loader";
import { DocumentService } from "../service";
import type { AddDocumentOptions } from "../types";

const AGENT_ID = "00000000-0000-0000-0000-00000000f00d" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const EMPTY = "" as UUID;

async function makeHarness(): Promise<{
	runtime: AgentRuntime;
	service: DocumentService;
}> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.initialize();
	const runtime = new AgentRuntime({
		agentId: AGENT_ID,
		character: {
			name: "DocumentScopeIntegrationAgent",
			bio: "Exercises document/fragment scope-id fallback semantics.",
			settings: {},
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	return { runtime, service: new DocumentService(runtime) };
}

async function fragmentsFor(
	runtime: AgentRuntime,
	documentId: UUID,
): Promise<Memory[]> {
	const fragments = await runtime.getMemories({
		tableName: "document_fragments",
		agentId: AGENT_ID,
		count: 50,
	});
	return fragments.filter(
		(fragment) =>
			(fragment.metadata as { documentId?: string } | undefined)?.documentId ===
			documentId,
	);
}

describe("document worldId preserves an explicit empty-string sentinel", () => {
	it("auto-fragmentation path: addDocument keeps worldId as '' end to end", async () => {
		const { runtime, service } = await makeHarness();

		const { storedDocumentMemoryId } = await service.addDocument({
			agentId: AGENT_ID,
			worldId: EMPTY,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			clientDocumentId: EMPTY,
			contentType: "text/plain",
			originalFilename: "scope-sentinel.txt",
			content: "Empty-string worldId sentinel must survive persistence.",
			addedBy: AGENT_ID,
			addedByRole: "RUNTIME",
			addedFrom: "runtime-internal",
		} satisfies AddDocumentOptions);

		const fragments = await fragmentsFor(runtime, storedDocumentMemoryId);
		expect(fragments.length).toBeGreaterThan(0);
		for (const fragment of fragments) {
			expect(fragment.worldId).toBe("");
		}
	});

	it("pre-chunked-fragments path: addDocument keeps worldId as '' end to end", async () => {
		const { runtime, service } = await makeHarness();

		const { storedDocumentMemoryId } = await service.addDocument({
			agentId: AGENT_ID,
			worldId: EMPTY,
			roomId: ROOM_ID,
			entityId: ENTITY_ID,
			clientDocumentId: EMPTY,
			contentType: "text/plain",
			originalFilename: "scope-sentinel-prechunked.txt",
			content: "unused when fragments are pre-chunked",
			addedBy: AGENT_ID,
			addedByRole: "RUNTIME",
			addedFrom: "runtime-internal",
			fragments: [
				{
					text: "First pre-chunked fragment body.",
					metadata: { startMs: 0, endMs: 100, segmentIds: ["seg-1"] },
				},
				{
					text: "Second pre-chunked fragment body.",
					metadata: { startMs: 100, endMs: 200, segmentIds: ["seg-2"] },
				},
			],
		} satisfies AddDocumentOptions);

		const fragments = await fragmentsFor(runtime, storedDocumentMemoryId);
		expect(fragments).toHaveLength(2);
		for (const fragment of fragments) {
			expect(fragment.worldId).toBe("");
		}
	});

	it("an explicit empty roomId is coerced to agentId, keeping the document readable", async () => {
		const { runtime, service } = await makeHarness();

		const { storedDocumentMemoryId } = await service.addDocument({
			agentId: AGENT_ID,
			worldId: AGENT_ID,
			roomId: EMPTY,
			entityId: ENTITY_ID,
			clientDocumentId: EMPTY,
			contentType: "text/plain",
			originalFilename: "empty-room-coerced.txt",
			content: "roomId '' must still resolve to a valid, readable document",
			addedBy: AGENT_ID,
			addedByRole: "RUNTIME",
			addedFrom: "runtime-internal",
		} satisfies AddDocumentOptions);

		const persisted = await runtime.getMemoryById(storedDocumentMemoryId);
		expect(persisted?.roomId).toBe(AGENT_ID);
	});

	it("addDocumentFromFilePath forwards an explicit worldId '' unchanged, but still normalizes roomId/entityId", async () => {
		const calls: AddDocumentOptions[] = [];
		const stubService = {
			reportError: () => undefined,
			addDocument: async (options: AddDocumentOptions) => {
				calls.push(options);
				return {
					clientDocumentId: options.clientDocumentId,
					storedDocumentMemoryId: "doc-1" as UUID,
					fragmentCount: 1,
				};
			},
		};

		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const filePath = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "eliza-docs-loader-")),
			"scope-sentinel.txt",
		);
		fs.writeFileSync(filePath, "fixture body");

		try {
			await addDocumentFromFilePath({
				service: stubService,
				agentId: AGENT_ID,
				worldId: EMPTY,
				roomId: EMPTY,
				entityId: EMPTY,
				filePath,
			});
			await addDocumentFromFilePath({
				service: stubService,
				agentId: AGENT_ID,
				filePath,
			});
		} finally {
			fs.rmSync(filePath, { force: true });
		}

		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			worldId: "",
			roomId: AGENT_ID,
			entityId: AGENT_ID,
		});
		expect(calls[1]).toMatchObject({
			worldId: AGENT_ID,
			roomId: AGENT_ID,
			entityId: AGENT_ID,
		});
	});
});
