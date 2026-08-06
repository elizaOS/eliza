/**
 * Regression tests for the DOCUMENT action's external-content envelope
 * unwrap/echo-clamp: query/path echoes never rebroadcast core's security
 * envelope or a planner-filled blob (live leak tj-2dc95f75456876), machine-text
 * renders are length-bounded, and structural extraction (document id) runs on
 * the user's actual words of a hardened message. Fully deterministic: the
 * runtime and DocumentService are vi.fn stubs.
 */
import { describe, expect, it, vi } from "vitest";
import { hardenIncomingUserMessage } from "../../../security/incoming-message-security.ts";
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

const BLOB_QUERY = `first line of a pasted document\n${"lorem ipsum ".repeat(30)}`;

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

function makeMessage(text: string, source?: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text, ...(source ? { source } : {}) },
		createdAt: Date.now(),
	} as Memory;
}

function makeService() {
	return {
		listDocumentsDetailed: vi.fn(async () => listResult()),
		searchDocuments: vi.fn(async () => []),
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
			if (!found) {
				throw new Error(`unknown category ${category}`);
			}
			return found;
		}),
		getSetting: vi.fn(() => undefined),
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be called on the planner-trust path");
		}),
	} as unknown as IAgentRuntime;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("DOCUMENT search/list echo clamping", () => {
	it("renders a blob-shaped planner search query as the neutral noun", async () => {
		const service = makeService();
		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "search", query: BLOB_QUERY }),
		);
		// Matching still runs on the raw query.
		expect(service.searchDocuments).toHaveBeenCalledTimes(1);
		expect(res.text).toBe(
			"I couldn't find any documents matching that search.",
		);
		const query = (res.data as { query: string }).query;
		expect(query).not.toContain("\n");
		expect(query.length).toBeLessThanOrEqual(121);
	});

	it("never echoes the security envelope from an envelope-shaped query param", async () => {
		const memory = makeMessage("find my launch notes", "discord");
		hardenIncomingUserMessage(memory);
		expect(memory.content.text).toContain("SECURITY NOTICE");
		expect(memory.content.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");

		// A fallback that grabbed the hardened content.text and passed it as the
		// planner query must not ship the envelope to chat.
		const res = await documentAction.handler(
			makeRuntime(makeService()),
			memory,
			undefined,
			options({ action: "search", query: memory.content.text }),
		);
		expect(res.text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(res.text).not.toContain("SECURITY NOTICE");
		expect(res.text).toBe(
			"I couldn't find any documents matching that search.",
		);
	});

	it("clamps a blob list query in the query_miss text and data", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({ status: "query_miss", query: BLOB_QUERY }),
		);
		const res = await documentAction.handler(
			makeRuntime(service),
			makeMessage(""),
			undefined,
			options({ action: "list", query: BLOB_QUERY }),
		);
		expect(res.text).toContain("No documents matched that search.");
		const query = (res.data as { query: string }).query;
		expect(query).not.toContain("\n");
		expect(query.length).toBeLessThanOrEqual(121);
	});

	it("still quotes a name-shaped search query", async () => {
		const res = await documentAction.handler(
			makeRuntime(makeService()),
			makeMessage(""),
			undefined,
			options({ action: "search", query: "launch notes" }),
		);
		expect(res.text).toBe(
			'I couldn\'t find any documents matching "launch notes".',
		);
	});
});

describe("DOCUMENT structural extraction on hardened messages", () => {
	it("recovers the document id from the user's words inside the envelope", async () => {
		const service = makeService();
		const memory = makeMessage(`read document ${DOC_ID}`, "discord");
		hardenIncomingUserMessage(memory);
		expect(memory.content.text).toContain("SECURITY NOTICE");

		const res = await documentAction.handler(
			makeRuntime(service),
			memory,
			undefined,
			options({ action: "read" }),
		);
		expect(service.getDocumentById).toHaveBeenCalledWith(DOC_ID, memory);
		expect(res.text).not.toContain("SECURITY NOTICE");
	});

	it("renders a blob-shaped filePath as the neutral noun with a bounded log view", async () => {
		const res = await documentAction.handler(
			makeRuntime(makeService()),
			makeMessage(""),
			undefined,
			options({ action: "import_file", filePath: `/tmp/${BLOB_QUERY}` }),
		);
		expect(res.text).toBe(
			"No file exists at that path; tell the user it couldn't be found.",
		);
		const filePath = (res.values as { filePath: string }).filePath;
		expect(filePath).not.toContain("\n");
		expect(filePath.length).toBeLessThanOrEqual(121);
	});
});
