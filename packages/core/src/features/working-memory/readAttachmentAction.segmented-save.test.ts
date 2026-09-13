/**
 * Regression tests for the #25140 review round 4 fixes at the ATTACHMENT and
 * MESSAGE action boundaries (deterministic harness — hand-rolled runtime
 * doubles with a page-capable and a method-only runtime; no module mocks).
 *
 * Pins three contracts:
 * 1. save_as_document on a segmented attachment reassembles the source via
 *    paged reads and never persists the inline segmented-content marker
 *    (review finding: saved documents contained the internal storage
 *    descriptor because the save path ran before the paging branch).
 * 2. save_as_document fails explicitly (typed error, no document write) when
 *    the runtime exposes the method but not the capability advertisement, or
 *    when the owning stored message is unknown.
 * 3. A method-only runtime (capability advertisement absent) never receives
 *    page calls on the read path — the dispatch sites gate on the capability
 *    pair, not method presence.
 */

import { describe, expect, it, vi } from "vitest";
import {
	buildSegmentedContentMarker,
	segmentMemoryContent,
} from "../../memory/content-segmentation.ts";
import { createMockRuntime } from "../../testing/mock-runtime.ts";
import type {
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType } from "../../types/index.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-0000000000a2" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-0000000000a3" as UUID;
const MEMORY_ID = "00000000-0000-0000-0000-0000000000a4" as UUID;
const ATTACHMENT_ID = "doc-9f31";

const SOURCE = `${"segurança שלום 🌏 body ".repeat(120)}TERMINAL-9f31`;

const PLAN = segmentMemoryContent(SOURCE, {
	kind: "attachment.text",
	attachmentId: ATTACHMENT_ID,
});
const MARKER = buildSegmentedContentMarker(PLAN.descriptor);

/** Serves the planned segments through a fake page endpoint, exactly like the
 * SQL adapter does: revision fencing, half-open windows, completeness. */
function fakePageEndpoint() {
	const calls: Array<{ byteStart: number; expectedRevision?: string }> = [];
	const getMemoryContentPage = vi.fn(
		async (params: { byteStart: number; expectedRevision?: string }) => {
			calls.push({
				byteStart: params.byteStart,
				expectedRevision: params.expectedRevision,
			});
			const sourceBytes = Buffer.from(SOURCE, "utf8");
			const windowStart = params.byteStart;
			let windowEnd = Math.min(windowStart + 2048, sourceBytes.length);
			// Snap the end back off a partial trailing code point, matching the
			// real adapter's boundary behavior so pages reassemble exactly.
			while (
				windowEnd > windowStart &&
				(sourceBytes[windowEnd] & 0xc0) === 0x80
			) {
				windowEnd -= 1;
			}
			const text = sourceBytes
				.subarray(windowStart, windowEnd)
				.toString("utf8");
			return {
				text,
				start: windowStart,
				end: windowEnd,
				total: PLAN.descriptor.totalBytes,
				sliceSha256: "0".repeat(64),
				sourceSha256: PLAN.descriptor.totalSha256,
				revision: PLAN.descriptor.revision,
				completeness: (windowEnd >= PLAN.descriptor.totalBytes
					? "complete"
					: "partial-recoverable") as "complete" | "partial-recoverable",
			};
		},
	);
	return { getMemoryContentPage, calls };
}

function makeMessage(): Memory {
	return {
		id: MEMORY_ID,
		roomId: ROOM_ID,
		entityId: REQUESTER_ID,
		agentId: AGENT_ID,
		content: {
			text: "save the document attachment",
			source: "discord",
			attachmentId: ATTACHMENT_ID,
		},
		createdAt: 1,
	} as Memory;
}

function baseRuntime(pageCapable: boolean): IAgentRuntime {
	const endpoint = fakePageEndpoint();
	const runtime = {
		agentId: AGENT_ID,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getMemoryById: async () => null,
		getRoom: async () => ({ id: ROOM_ID, worldId: ROOM_ID, agentId: AGENT_ID }),
		getWorld: async () => null,
		getService: () => null,
		getSetting: () => undefined,
		reportError: () => {},
		...(pageCapable
			? {
					memoryContentPageCapability: 1,
					getMemoryContentPage: endpoint.getMemoryContentPage,
				}
			: { getMemoryContentPage: endpoint.getMemoryContentPage }),
	} as unknown as IAgentRuntime;
	return runtime;
}

/** Stands in for listConversationAttachments: one segmented record whose
 * inline content is the published marker and whose owner is MEMORY_ID. */
function runtimeWithRecords(
	runtime: IAgentRuntime,
	messageId: UUID | undefined,
) {
	const stored: Memory = {
		// An undefined messageId leaves the owning message id unresolved.
		...(messageId === undefined ? {} : { id: messageId }),
		roomId: ROOM_ID,
		entityId: REQUESTER_ID,
		agentId: AGENT_ID,
		content: {
			text: "attachment message",
			source: "discord",
			attachments: [
				{
					id: ATTACHMENT_ID,
					url: "https://example.test/doc",
					title: "large doc",
					source: "Web",
					contentType: ContentType.DOCUMENT,
					text: MARKER,
				},
			],
		},
		createdAt: 1,
	} as Memory;
	return {
		...runtime,
		getMemories: async () => [stored],
	} as IAgentRuntime;
}

function documentSavingRuntime(runtime: IAgentRuntime) {
	const saved: Array<Record<string, unknown>> = [];
	return {
		runtime: {
			...runtime,
			getService: () => ({
				addDocument: async (params: Record<string, unknown>) => {
					saved.push(params);
					return {
						clientDocumentId: "00000000-0000-0000-0000-0000000000b1",
						fragmentCount: 1,
					};
				},
			}),
		} as unknown as IAgentRuntime,
		saved,
	};
}

async function save(runtime: IAgentRuntime): Promise<ActionResult> {
	const callback: HandlerCallback = async () => [] as Memory[];
	const result = await readAttachmentAction.handler(
		runtime,
		makeMessage(),
		undefined,
		{ parameters: { action: "save_as_document", attachmentId: ATTACHMENT_ID } },
		callback,
		undefined,
	);
	if (!result) throw new Error("ATTACHMENT handler returned no result");
	return result;
}

describe("ATTACHMENT save_as_document over segmented content (#25140 R4)", () => {
	it("reassembles the segmented source via paged reads and saves the full text, never the marker", async () => {
		const { runtime, saved } = documentSavingRuntime(
			runtimeWithRecords(baseRuntime(true), MEMORY_ID),
		);
		const result = await save(runtime);

		expect(result.success).toBe(true);
		expect(saved).toHaveLength(1);
		const content = saved[0]?.content as string;
		expect(content).not.toContain("[elizaos:segmented-content");
		expect(content).toBe(SOURCE);
	});

	it("fails explicitly when the runtime has the method but no capability advertisement", async () => {
		const { runtime, saved } = documentSavingRuntime(
			runtimeWithRecords(baseRuntime(false), MEMORY_ID),
		);
		const result = await save(runtime);

		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"ATTACHMENT_SAVE_REASSEMBLY_UNAVAILABLE",
		);
		expect(saved).toHaveLength(0);
	});

	it("fails explicitly when the segmented record has no owning stored message", async () => {
		const { runtime, saved } = documentSavingRuntime(
			runtimeWithRecords(baseRuntime(true), undefined),
		);
		const result = await save(runtime);

		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"ATTACHMENT_PAGE_OWNER_UNRESOLVED",
		);
		expect(saved).toHaveLength(0);
	});

	it("translates a typed page-read failure into a structured save failure", async () => {
		const runtime = runtimeWithRecords(baseRuntime(true), MEMORY_ID);
		const failing = {
			...runtime,
			getMemoryContentPage: vi.fn(async () => {
				const { ElizaError } = await import("../../errors.ts");
				throw new ElizaError(
					"The stored content changed before this page could be read.",
					{
						code: "MEMORY_CONTENT_STALE_REVISION",
					},
				);
			}),
		} as unknown as IAgentRuntime;
		const { runtime: withDocs, saved } = documentSavingRuntime(failing);
		const result = await save(withDocs);

		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"MEMORY_CONTENT_STALE_REVISION",
		);
		expect(saved).toHaveLength(0);
	});
});

/**
 * Dispatch-gate regression: a runtime exposing the paging METHOD without the
 * capability advertisement must never receive page calls on either dispatch
 * site (ATTACHMENT read, MESSAGE read_channel). Restoring method-only
 * dispatch at either site fails these tests.
 */
describe("native-paging dispatch gate (#25140 R4)", () => {
	it("ATTACHMENT read never pages a segmented marker on a method-only runtime", async () => {
		const runtime = runtimeWithRecords(baseRuntime(false), MEMORY_ID);
		const result = await readAttachmentAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{
				parameters: { action: "read", attachmentId: ATTACHMENT_ID, limit: 64 },
			},
			async () => [] as Memory[],
			undefined,
		);
		// The method existed on the runtime but was NOT called: the capability
		// gate, not method presence, decides dispatch. The marker must surface
		// as an explicit failure, never as served content.
		expect(result).toBeTruthy();
		expect(result?.success).toBe(false);
		expect((result?.data as { error: string } | undefined)?.error).toBe(
			"segmented_read_unavailable",
		);
		expect(
			(runtime.getMemoryContentPage as unknown as ReturnType<typeof vi.fn>).mock
				.calls,
		).toHaveLength(0);
	});

	it("MESSAGE read_channel never pages on a method-only runtime", async () => {
		const { messageAction } = await import(
			"../advanced-capabilities/actions/message.ts"
		);
		const endpoint = fakePageEndpoint();
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			getMemoryById: async () =>
				({
					id: MEMORY_ID,
					roomId: ROOM_ID,
					entityId: REQUESTER_ID,
					agentId: AGENT_ID,
					content: { text: MARKER, source: "discord" },
					metadata: { scope: "room" },
					createdAt: 1,
				}) as Memory,
			getParticipantsForRoom: async () => [REQUESTER_ID],
			// Method WITHOUT the capability advertisement.
			getMemoryContentPage: endpoint.getMemoryContentPage,
		} as never);
		const result = await messageAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{
				parameters: {
					action: "read_channel",
					messageId: MEMORY_ID,
					limit: 64,
				},
			},
			async () => [] as Memory[],
			undefined,
		);
		// No capability advertisement: never dispatched, and the internal
		// marker descriptor surfaces as an explicit failure, never as text.
		expect(result).toBeTruthy();
		expect(result?.success).toBe(false);
		expect((result?.data as { error?: string } | undefined)?.error).toBe(
			"MESSAGE_MEMORY_SEGMENTED_READ_UNAVAILABLE",
		);
		expect(endpoint.getMemoryContentPage.mock.calls).toHaveLength(0);
	});
});

/**
 * #25140 R4 integrity fence: segmented save reassembly must validate every
 * page against the record's published descriptor (revision, totals, window
 * coherence, source digest) and the final whole against the descriptor
 * digest. A page store that serves a different generation, an inconsistent
 * window, or tampered text must fail the save explicitly with zero document
 * writes — never persist a mismatched or partial source as a document.
 */
describe("segmented save reassembly integrity fence (#25140 R4)", () => {
	function capableRuntimeWithPages(
		pages: Array<Record<string, unknown> | undefined>,
	) {
		const base = runtimeWithRecords(baseRuntime(true), MEMORY_ID);
		let call = 0;
		const runtime = {
			...base,
			getMemoryContentPage: async () => {
				const page = pages[call];
				call += 1;
				return page ? { ...page } : undefined;
			},
		} as unknown as IAgentRuntime;
		return documentSavingRuntime(runtime);
	}

	it("rejects a page served from a different generation than the marker descriptor", async () => {
		const sourceBytes = Buffer.from(SOURCE, "utf8");
		const { runtime, saved } = capableRuntimeWithPages([
			{
				text: SOURCE,
				start: 0,
				end: sourceBytes.length,
				total: PLAN.descriptor.totalBytes,
				sourceSha256: PLAN.descriptor.totalSha256,
				revision: `${PLAN.descriptor.revision}-newer`,
				completeness: "complete",
			},
		]);
		const result = await save(runtime);
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"ATTACHMENT_SAVE_REASSEMBLY_INCONSISTENT",
		);
		expect(saved).toHaveLength(0);
	});

	it("rejects a page window that disagrees with the requested offset and totals", async () => {
		const { runtime, saved } = capableRuntimeWithPages([
			{
				text: SOURCE.slice(0, 10),
				start: 4,
				end: 14,
				total: PLAN.descriptor.totalBytes,
				sourceSha256: PLAN.descriptor.totalSha256,
				revision: PLAN.descriptor.revision,
				completeness: "partial-recoverable",
			},
		]);
		const result = await save(runtime);
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"ATTACHMENT_SAVE_REASSEMBLY_INCONSISTENT",
		);
		expect(saved).toHaveLength(0);
	});

	it("rejects reassembled text whose digest does not match the descriptor", async () => {
		// Serve coherent windows of TAMPERED text: correct shape, wrong bytes.
		const tampered = `${SOURCE.slice(0, -1)}X`;
		const sourceBytes = Buffer.from(tampered, "utf8");
		const { runtime, saved } = capableRuntimeWithPages([
			{
				text: tampered,
				start: 0,
				end: sourceBytes.length,
				total: PLAN.descriptor.totalBytes,
				sourceSha256: PLAN.descriptor.totalSha256,
				revision: PLAN.descriptor.revision,
				completeness: "complete",
			},
		]);
		const result = await save(runtime);
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"ATTACHMENT_SAVE_REASSEMBLY_DIGEST_MISMATCH",
		);
		expect(saved).toHaveLength(0);
	});

	it("fences the first page to the marker's revision (stale-generation store throws)", async () => {
		const base = runtimeWithRecords(baseRuntime(true), MEMORY_ID);
		const seenRevisions: Array<string | undefined> = [];
		const runtime = {
			...base,
			getMemoryContentPage: async (params: { expectedRevision?: string }) => {
				seenRevisions.push(params.expectedRevision);
				const { ElizaError } = await import("../../errors.ts");
				throw new ElizaError(
					"The stored content changed before this page could be read.",
					{ code: "MEMORY_CONTENT_STALE_REVISION" },
				);
			},
		} as unknown as IAgentRuntime;
		const { runtime: withDocs, saved } = documentSavingRuntime(runtime);
		const result = await save(withDocs);
		expect(result.success).toBe(false);
		// The FIRST page request already carried the descriptor revision.
		expect(seenRevisions).toEqual([PLAN.descriptor.revision]);
		expect(saved).toHaveLength(0);
	});

	it("detects the marker before inline pagination: a small limit truncating the prefix still routes to native paging", async () => {
		const endpoint = fakePageEndpoint();
		const base = {
			...runtimeWithRecords(baseRuntime(true), MEMORY_ID),
			// answerAttachmentRequest summarizes the page with a small model;
			// a deterministic stub keeps the probe on the paging contract.
			useModel: async () => "summarized page answer",
			getMemoryContentPage: endpoint.getMemoryContentPage,
		} as unknown as IAgentRuntime;
		// A 16-byte limit slices the marker prefix in pageAttachmentRecords;
		// detection must still happen on the ORIGINAL record content.
		const result = await readAttachmentAction.handler(
			base,
			makeMessage(),
			undefined,
			{
				parameters: { action: "read", attachmentId: ATTACHMENT_ID, limit: 16 },
			},
			async () => [] as Memory[],
			undefined,
		);
		expect(result?.success).toBe(true);
		expect(endpoint.getMemoryContentPage.mock.calls.length).toBeGreaterThan(0);
		// The served text is a page of the real SOURCE, never the marker.
		expect(result?.text).not.toContain("[elizaos:segmented-content");
	});

	it("continuation offsets past the marker length page natively instead of failing inline offset validation", async () => {
		const endpoint = fakePageEndpoint();
		const base = {
			...runtimeWithRecords(baseRuntime(true), MEMORY_ID),
			useModel: async () => "summarized page answer",
			getMemoryContentPage: endpoint.getMemoryContentPage,
		} as unknown as IAgentRuntime;
		// 2048 bytes is far past the marker's own length; inline validation
		// against the marker would throw ATTACHMENT_READ_INVALID_OFFSET before
		// the native branch ran (RP round-3 finding).
		const continuation = 2048;
		const result = await readAttachmentAction.handler(
			base,
			makeMessage(),
			undefined,
			{
				parameters: {
					action: "read",
					attachmentId: ATTACHMENT_ID,
					offset: continuation,
					expectedRevision: PLAN.descriptor.revision,
				},
			},
			async () => [] as Memory[],
			undefined,
		);
		expect(result?.success).toBe(true);
		expect(endpoint.getMemoryContentPage.mock.calls.length).toBeGreaterThan(0);
		expect(endpoint.getMemoryContentPage.mock.calls[0]?.[0]?.byteStart).toBe(
			continuation,
		);
		expect(result?.text).not.toContain("[elizaos:segmented-content");
	});

	it("fails explicitly when a capable adapter returns null for a segmented record (authorization gone)", async () => {
		const base = runtimeWithRecords(baseRuntime(true), MEMORY_ID);
		const runtime = {
			...base,
			getMemoryContentPage: async () => null,
		} as unknown as IAgentRuntime;
		const result = await readAttachmentAction.handler(
			runtime,
			makeMessage(),
			undefined,
			{
				parameters: { action: "read", attachmentId: ATTACHMENT_ID },
			},
			async () => [] as Memory[],
			undefined,
		);
		expect(result?.success).toBe(false);
		expect((result?.data as { error?: string } | undefined)?.error).toBe(
			"segmented_page_unavailable",
		);
	});
});
