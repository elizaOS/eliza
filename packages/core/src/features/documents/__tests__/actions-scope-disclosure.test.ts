/**
 * Pins the scope-disclosure contract of the DOCUMENT action's read paths: a
 * search result that was filtered or capped, and a list page that is a slice of
 * a larger match set, must say so in the text the model reads. Without it,
 * "nothing in your documents about X" is returned for a store that had matches
 * a planner-supplied filter dropped, and a 25-row page answers "how many
 * documents do I have?" as though 25 were the total. Deterministic: the runtime
 * and DocumentService are vi.fn stubs; no live model or database.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	UUID,
} from "../../../types";
import { documentAction } from "../actions";
import { type DocumentListResult, DocumentService } from "../service";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const DOC_ID = "11111111-2222-3333-4444-555555555555" as UUID;

function listResult(
	overrides: Partial<DocumentListResult> = {},
): DocumentListResult {
	return {
		status: "empty_store",
		documents: [],
		availableDocuments: [],
		limit: 25,
		offset: 0,
		totalVisible: 0,
		totalAvailable: 0,
		totalMatched: 0,
		hasMore: false,
		availableOffset: 0,
		availableHasMore: false,
		...overrides,
	};
}

function storedFragment(index: number, metadata: Record<string, unknown> = {}) {
	return {
		id: `00000000-0000-0000-0000-00000000f0${index}` as UUID,
		content: { text: `fragment ${index}` },
		metadata: { documentId: DOC_ID, ...metadata },
	};
}

function storedDocument(index: number): Memory {
	return {
		id: `00000000-0000-0000-0000-00000000d0${index}` as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: `document ${index}` },
		metadata: { title: `Doc ${index}` },
	} as unknown as Memory;
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
}

function makeService() {
	return {
		listDocumentsDetailed: vi.fn(async () => listResult()),
		searchDocuments: vi.fn(
			async () => [] as ReturnType<typeof storedFragment>[],
		),
		getDocumentById: vi.fn(async () => null),
		addDocument: vi.fn(async () => ({
			clientDocumentId: DOC_ID,
			fragmentCount: 1,
		})),
		updateDocument: vi.fn(async () => ({
			documentId: DOC_ID,
			fragmentCount: 1,
		})),
		deleteDocument: vi.fn(async () => undefined),
	};
}

function makeRuntime(service: ReturnType<typeof makeService>): IAgentRuntime {
	const categories = new Map<string, SearchCategoryRegistration>();
	return {
		agentId: AGENT_ID,
		getService: vi.fn(<T>(type: string): T | null =>
			type === DocumentService.serviceType ? (service as unknown as T) : null,
		),
		registerSearchCategory: vi.fn((reg: SearchCategoryRegistration) => {
			categories.set(reg.category, reg);
		}),
		getSearchCategory: vi.fn((category: string) => {
			const found = categories.get(category);
			if (!found) throw new Error(`unknown category ${category}`);
			return found;
		}),
		getSetting: vi.fn(() => undefined),
		getRoom: vi.fn(async () => null),
		getRoomsForParticipants: vi.fn(async () => {
			throw new Error("room lookup is unavailable");
		}),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be called on the planner-trust path");
		}),
	} as unknown as IAgentRuntime;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("DOCUMENT search discloses what narrowed the result", () => {
	it("names the tag filter that emptied a non-empty retrieval", async () => {
		const service = makeService();
		service.searchDocuments.mockResolvedValueOnce([
			storedFragment(1, { tags: ["other"] }),
			storedFragment(2),
		]);

		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "search", query: "launch", tags: ["q3"] }),
		);

		// The bare sentence claims the store has nothing about the query.
		expect(res.text).not.toBe(
			'I couldn\'t find any documents matching "launch".',
		);
		expect(res.text).toContain("searched 2 retrieved fragment(s)");
		expect(res.text).toContain("0 matched filters");
		expect(res.text).toContain('tags="q3"');
		expect(res.text).toContain("Retry without those filters");
	});

	it("names the result cap when matches are truncated", async () => {
		const service = makeService();
		service.searchDocuments.mockResolvedValueOnce(
			Array.from({ length: 7 }, (_, i) => storedFragment(i)),
		);

		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "search", query: "launch" }),
		);

		expect(res.text).toContain("Found 5 document fragment(s)");
		expect(res.text).toContain("showing the top 5");
		expect(res.text).toContain("Raise limit above 5");
	});

	it("leaves an unfiltered, uncapped search text unchanged", async () => {
		const service = makeService();
		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "search", query: "launch" }),
		);
		expect(res.text).toBe('I couldn\'t find any documents matching "launch".');
	});
});

describe("DOCUMENT list discloses the page against the total", () => {
	it("reports the page size against totalMatched and how to page on", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "ok",
				documents: [storedDocument(1)],
				limit: 25,
				offset: 0,
				totalVisible: 200,
				totalAvailable: 200,
				totalMatched: 200,
				hasMore: true,
			}),
		);

		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "list" }),
		);

		expect(res.text).toContain("Showing 1 of 200 document(s)");
		expect(res.text).toContain("request offset 1");
		expect(res.text).toContain("Available documents:");
		expect(res.text).toContain("Doc 1");
	});

	it("names the pre-filter visible total when filters narrowed the list", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "ok",
				documents: [storedDocument(1)],
				limit: 25,
				offset: 0,
				totalVisible: 40,
				totalAvailable: 1,
				totalMatched: 1,
				hasMore: false,
			}),
		);

		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "list", scope: "global" }),
		);

		expect(res.text).toContain("40 document(s) are visible before");
	});

	it("adds nothing when the page already is the whole store", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "ok",
				documents: [storedDocument(1)],
				limit: 25,
				offset: 0,
				totalVisible: 1,
				totalAvailable: 1,
				totalMatched: 1,
				hasMore: false,
			}),
		);

		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "list" }),
		);

		expect(res.text).toBe(
			`Available documents:\n1. Doc 1 (${storedDocument(1).id})`,
		);
	});
});
