/**
 * Proves updateDocument publishes document revisions atomically (#16021): the
 * replacement fragment generation is staged reader-invisible before the parent
 * compare-and-swap commits, every failure (embed outage, Nth insert, CAS
 * conflict, discard outage) preserves the complete prior committed revision,
 * and readers never observe zero, partial, or mixed fragment generations.
 * Integration-backed: a real AgentRuntime over a real PGLite SQL adapter
 * (plugin-sql); only the embedding model handler is injected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import type { Memory, UUID } from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { DocumentService } from "./service.ts";

const DOCUMENT_FRAGMENTS_TABLE = "document_fragments";

const V1_TEXT = [
	"Version one alpha: original refund policy paragraph for the atomic test.",
	"Version one bravo: original service level agreement paragraph retained.",
	"Version one charlie: original data retention paragraph kept verbatim.",
].join("\n\n");

const V2_TEXT = [
	"Version two alpha: revised refund policy paragraph replaces the original.",
	"Version two bravo: revised service level agreement paragraph installed.",
].join("\n\n");

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let service: DocumentService;
let embedShouldFail = false;
let embedGate: Promise<void> | undefined;
let notifyEmbed: (() => void) | undefined;
let docCounter = 0;

function readerContext() {
	return {
		agentId: runtime.agentId,
		requesterEntityId: runtime.agentId,
		requesterRoomIds: [runtime.agentId as UUID],
		requesterRole: "OWNER" as const,
	};
}

/** Committed fragments as an authorized reader sees them. */
async function visibleFragmentTexts(documentId: UUID): Promise<string[]> {
	const fragments = await runtime.adapter.queryDocumentFragments({
		...readerContext(),
		limit: 1_000,
	});
	return fragments
		.filter(
			(memory) =>
				(memory.metadata as { documentId?: string } | undefined)?.documentId ===
				documentId,
		)
		.map((memory) => memory.content.text ?? "");
}

/** Raw rows in the fragment table for a document, visibility rules bypassed. */
async function rawFragmentsFor(documentId: UUID): Promise<Memory[]> {
	const memories = await runtime.getMemories({
		tableName: DOCUMENT_FRAGMENTS_TABLE,
		agentId: runtime.agentId,
		count: 10_000,
	});
	return memories.filter(
		(memory) =>
			(memory.metadata as { documentId?: string } | undefined)?.documentId ===
			documentId,
	);
}

async function seedDocument(): Promise<UUID> {
	docCounter += 1;
	// addDocument derives a content-based document id, so every seed gets
	// unique content and the returned id is authoritative.
	const result = await service.addDocument({
		agentId: runtime.agentId,
		content: `Seed lane ${docCounter}.\n\n${V1_TEXT}`,
		contentType: "text/plain",
		scope: "agent-private",
		originalFilename: `atomic-update-${docCounter}.txt`,
		worldId: runtime.agentId as UUID,
		roomId: runtime.agentId as UUID,
		entityId: runtime.agentId as UUID,
	});
	expect(result.fragmentCount).toBeGreaterThan(0);
	return result.clientDocumentId as UUID;
}

async function expectCommittedV1(documentId: UUID): Promise<void> {
	const parent = await runtime.getMemoryById(documentId);
	expect(parent?.content?.text).toContain("Version one alpha");
	const visible = await visibleFragmentTexts(documentId);
	expect(visible.length).toBeGreaterThan(0);
	expect(visible.join(" ")).toContain("Version one alpha");
	expect(visible.join(" ")).not.toContain("Version two");
}

beforeAll(async () => {
	({ runtime, cleanup } = await createTestRuntime({
		characterName: "AtomicUpdateAgent",
		embeddingDimensions: 384,
	}));
	const embed = async () => {
		notifyEmbed?.();
		await embedGate;
		if (embedShouldFail) {
			throw new Error("injected embedding provider outage");
		}
		return Array.from({ length: 384 }, (_, i) => ((i % 7) + 1) / 10);
	};
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING,
		async () => embed(),
		"atomic-update-test",
		1_000,
	);
	runtime.registerModel(
		ModelType.TEXT_EMBEDDING_BATCH,
		async (_runtime, params: { texts?: string[] }) => {
			const texts = Array.isArray(params.texts) ? params.texts : [];
			return Promise.all(texts.map(() => embed()));
		},
		"atomic-update-test",
		1_000,
	);
	service = new DocumentService(runtime);
}, 180_000);

afterAll(async () => {
	await cleanup();
});

describe("updateDocument atomic revision publication (#16021)", () => {
	it("publishes the complete new generation and removes the superseded one", async () => {
		const documentId = await seedDocument();
		const updated = await service.updateDocument({
			documentId,
			content: V2_TEXT,
		});
		expect(updated.fragmentCount).toBeGreaterThan(0);

		const parent = await runtime.getMemoryById(documentId);
		expect(parent?.content?.text).toBe(V2_TEXT);
		const metadata = parent?.metadata as
			| { documentRevision?: number; revisionAttemptId?: string }
			| undefined;
		expect(metadata?.documentRevision).toBe(1);
		expect(typeof metadata?.revisionAttemptId).toBe("string");

		const visible = await visibleFragmentTexts(documentId);
		expect(visible).toHaveLength(updated.fragmentCount);
		expect(visible.join(" ")).toContain("Version two alpha");
		expect(visible.join(" ")).not.toContain("Version one");
		// Superseded generation is physically gone, not just invisible.
		expect(await rawFragmentsFor(documentId)).toHaveLength(
			updated.fragmentCount,
		);
	}, 120_000);

	it("preserves the complete old revision when embedding fails mid-update", async () => {
		const documentId = await seedDocument();
		embedShouldFail = true;
		try {
			await expect(
				service.updateDocument({ documentId, content: V2_TEXT }),
			).rejects.toThrow(/stage replacement fragments/);
		} finally {
			embedShouldFail = false;
		}
		await expectCommittedV1(documentId);
		// Staged partials were discarded from storage too.
		const raw = await rawFragmentsFor(documentId);
		expect(
			raw.filter((memory) => memory.content.text?.includes("Version two")),
		).toHaveLength(0);
	}, 120_000);

	it("preserves the old revision when the Nth fragment insert fails", async () => {
		const documentId = await seedDocument();
		// Long enough to split into multiple fragments so the injected outage
		// hits the Nth insert, leaving a genuinely partial staged generation.
		const longV2 = Array.from(
			{ length: 200 },
			(_, i) => `Version two long paragraph ${i}: ${V2_TEXT}`,
		).join("\n\n");
		const realCreateMemory = runtime.createMemory.bind(runtime);
		let fragmentWrites = 0;
		runtime.createMemory = async (memory, tableName, unique) => {
			if (
				tableName === DOCUMENT_FRAGMENTS_TABLE &&
				memory.content.text?.includes("Version two")
			) {
				fragmentWrites += 1;
				if (fragmentWrites >= 2) {
					throw new Error("injected Nth fragment insert outage");
				}
			}
			return realCreateMemory(memory, tableName, unique);
		};
		try {
			await expect(
				service.updateDocument({ documentId, content: longV2 }),
			).rejects.toThrow(/stage replacement fragments/);
		} finally {
			runtime.createMemory = realCreateMemory;
		}
		expect(fragmentWrites).toBeGreaterThanOrEqual(2);
		await expectCommittedV1(documentId);
		const raw = await rawFragmentsFor(documentId);
		expect(
			raw.filter((memory) => memory.content.text?.includes("Version two")),
		).toHaveLength(0);
	}, 120_000);

	it("keeps the old revision committed when a concurrent writer wins the CAS", async () => {
		const documentId = await seedDocument();
		const adapter = runtime.adapter;
		const realCompareAndSwap = adapter.compareAndSwapDocument.bind(adapter);
		adapter.compareAndSwapDocument = async () => ({ status: "conflict" });
		try {
			await expect(
				service.updateDocument({ documentId, content: V2_TEXT }),
			).rejects.toThrow(/authorization changed before update/);
		} finally {
			adapter.compareAndSwapDocument = realCompareAndSwap;
		}
		await expectCommittedV1(documentId);
		const raw = await rawFragmentsFor(documentId);
		expect(
			raw.filter((memory) => memory.content.text?.includes("Version two")),
		).toHaveLength(0);
	}, 120_000);

	it("readers see only the complete old generation while an update is staging", async () => {
		const documentId = await seedDocument();
		const committedBefore = await visibleFragmentTexts(documentId);
		expect(committedBefore.length).toBeGreaterThan(0);

		let releaseEmbed!: () => void;
		embedGate = new Promise<void>((resolve) => {
			releaseEmbed = resolve;
		});
		let enteredEmbed!: () => void;
		const embeddingStarted = new Promise<void>((resolve) => {
			enteredEmbed = resolve;
		});
		notifyEmbed = enteredEmbed;

		const update = service.updateDocument({ documentId, content: V2_TEXT });
		await embeddingStarted;
		notifyEmbed = undefined;

		// Mid-staging: the committed revision is still complete and exclusive.
		const midUpdate = await visibleFragmentTexts(documentId);
		expect(midUpdate).toEqual(committedBefore);
		expect((await runtime.getMemoryById(documentId))?.content?.text).toContain(
			"Version one alpha",
		);

		releaseEmbed();
		embedGate = undefined;
		const updated = await update;
		const after = await visibleFragmentTexts(documentId);
		expect(after).toHaveLength(updated.fragmentCount);
		expect(after.join(" ")).toContain("Version two alpha");
		expect(after.join(" ")).not.toContain("Version one");
	}, 120_000);

	it("leaves discard leftovers invisible when staged cleanup is unavailable", async () => {
		const documentId = await seedDocument();
		const realDeleteMemory = runtime.deleteMemory.bind(runtime);
		const realCompareAndSwap = runtime.adapter.compareAndSwapDocument.bind(
			runtime.adapter,
		);
		runtime.adapter.compareAndSwapDocument = async () => ({
			status: "conflict",
		});
		runtime.deleteMemory = async () => {
			throw new Error("injected discard outage");
		};
		try {
			await expect(
				service.updateDocument({ documentId, content: V2_TEXT }),
			).rejects.toThrow(/authorization changed before update/);
		} finally {
			runtime.deleteMemory = realDeleteMemory;
			runtime.adapter.compareAndSwapDocument = realCompareAndSwap;
		}
		// Leftover staged rows exist in storage but never reach readers: the
		// committed parent still declares revision 0 with no attempt token.
		const raw = await rawFragmentsFor(documentId);
		expect(
			raw.filter((memory) => memory.content.text?.includes("Version two"))
				.length,
		).toBeGreaterThan(0);
		await expectCommittedV1(documentId);

		// The next successful update sweeps the stale staged generation.
		const recovered = await service.updateDocument({
			documentId,
			content: V2_TEXT,
		});
		const swept = await rawFragmentsFor(documentId);
		expect(swept).toHaveLength(recovered.fragmentCount);
		const visible = await visibleFragmentTexts(documentId);
		expect(visible).toHaveLength(recovered.fragmentCount);
		expect(visible.join(" ")).not.toContain("Version one");
	}, 120_000);

	it("fences same-revision fragments from a different update attempt", async () => {
		const documentId = await seedDocument();
		const updated = await service.updateDocument({
			documentId,
			content: V2_TEXT,
		});
		// Simulate a losing concurrent attempt that staged the same revision
		// number under a different attempt token and failed to discard it.
		await runtime.createMemory(
			{
				id: runtime.createRunId(),
				agentId: runtime.agentId,
				roomId: runtime.agentId,
				entityId: runtime.agentId,
				content: { text: "Version rogue: losing attempt fragment" },
				metadata: {
					type: "fragment",
					documentId,
					position: 0,
					documentRevision: 1,
					revisionAttemptId: runtime.createRunId(),
				} as unknown as Memory["metadata"],
			},
			DOCUMENT_FRAGMENTS_TABLE,
		);
		const visible = await visibleFragmentTexts(documentId);
		expect(visible).toHaveLength(updated.fragmentCount);
		expect(visible.join(" ")).not.toContain("Version rogue");
	}, 120_000);
});
