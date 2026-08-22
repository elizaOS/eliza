/**
 * Tests the DOCUMENT action's `validate` and structured-routing `handler` — that
 * the subaction comes from the planner's structured `action` param (via
 * resolveActionArgs), not natural-language keywords, and that missing NL values
 * are supplied by the extractor rather than stripped from message text. Fully
 * deterministic: the runtime, DocumentService, and useModel are vi.fn stubs (the
 * planner-trust path asserts useModel is never called); no live model or DB.
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

// ── Structured-routing tests ───────────────────────────────────────────────
//
// The DOCUMENT umbrella action selects its subaction from the planner's
// structured English-enum `action` parameter (via `resolveActionArgs`), NOT
// from natural-language keywords in the user's `message.content.text`. The
// planner-trust path in `resolveActionArgs` resolves a valid `action` value
// synchronously when the required structured params are already present. When
// natural-language values such as `query` or `text` are missing, the shared
// extractor supplies them instead of the handler stripping English prefixes from
// `message.content.text`.

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-00000000face" as UUID;
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
		searchDocuments: vi.fn(async () => []),
		getDocumentById: vi.fn(async () => null),
		readDocumentRange: vi.fn(async () => null),
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

function makeRuntime(service: ReturnType<typeof makeService>): {
	runtime: IAgentRuntime;
	useModel: ReturnType<typeof vi.fn>;
} {
	const categories = new Map<string, SearchCategoryRegistration>();
	const useModel = vi.fn(async () => {
		throw new Error("useModel must not be called on the planner-trust path");
	});
	const runtime = {
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
		getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
		getWorld: vi.fn(async () => ({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: { roles: { [USER_ID]: "USER" } },
		})),
		getRoomsForParticipants: vi.fn(async () => {
			throw new Error("room lookup is unavailable");
		}),
		reportError: vi.fn(),
		useModel,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("documentAction.validate", () => {
	it("offers an explicit no-filter scope for strict guided decoding", () => {
		const scope = documentAction.parameters?.find(
			(parameter) => parameter.name === "scope",
		);

		expect(scope?.schema).toMatchObject({
			type: "string",
			enum: [
				"global",
				"owner-private",
				"user-private",
				"agent-private",
				"all-visible",
			],
		});
		expect(scope?.description).toContain(
			"use all-visible unless the user explicitly names",
		);
	});

	it("allows the strict-decoder zero sentinel for irrelevant limit fields", () => {
		const limit = documentAction.parameters?.find(
			(parameter) => parameter.name === "limit",
		);

		expect(limit?.schema).toMatchObject({
			type: "number",
			minimum: 0,
			maximum: 100,
		});
		expect(limit?.description).toContain(
			"Use 0 when this field is not applicable",
		);
	});

	it("is service-presence only — true when the service is registered", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		await expect(
			documentAction.validate?.(runtime, makeMessage("anything"), undefined),
		).resolves.toBe(true);
	});

	it("registers the documents search category as a side effect", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		await documentAction.validate?.(runtime, makeMessage("hi"), undefined);
		expect(runtime.registerSearchCategory).toHaveBeenCalledTimes(1);
		expect(runtime.getSearchCategory("documents")).toMatchObject({
			category: "documents",
			serviceType: DocumentService.serviceType,
		});
	});

	it("is false when no documents service is present (no NL inference)", async () => {
		const { runtime } = makeRuntime(makeService());
		(runtime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
		await expect(
			documentAction.validate?.(
				runtime,
				makeMessage("please search my documents for launch notes"),
				undefined,
			),
		).resolves.toBe(false);
	});
});

describe("documentAction.handler structured routing", () => {
	it("routes on the planner action value, ignoring conflicting NL keywords", async () => {
		const service = makeService();
		const { runtime, useModel } = makeRuntime(service);
		// Text screams "delete"; the structured action says "list" — list wins.
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("delete remove drop forget everything"),
			undefined,
			options({ action: "list" }),
		);
		expect(useModel).not.toHaveBeenCalled();
		expect(service.listDocumentsDetailed).toHaveBeenCalledTimes(1);
		expect(service.deleteDocument).not.toHaveBeenCalled();
		expect(res?.data).toMatchObject({
			actionName: "DOCUMENT",
			subaction: "list",
		});
	});

	it.each([
		["search", "searchDocuments"],
		["list", "listDocumentsDetailed"],
	] as const)(
		"routes the %s subaction to the matching service call",
		async (action, method) => {
			const service = makeService();
			const { runtime } = makeRuntime(service);
			await documentAction.handler?.(
				runtime,
				makeMessage("placeholder text"),
				undefined,
				options(
					action === "search" ? { action, query: "launch notes" } : { action },
				),
			);
			expect(service[method]).toHaveBeenCalledTimes(1);
		},
	);

	it("treats all-visible as no scope filter for list", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);

		await documentAction.handler?.(
			runtime,
			makeMessage("What documents are stored right now?"),
			undefined,
			options({ action: "list", scope: "all-visible" }),
		);

		expect(service.listDocumentsDetailed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ scope: undefined }),
		);
	});

	it("ignores ungrounded strict-decoder zero sentinels on list", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);

		await documentAction.handler?.(
			runtime,
			makeMessage("List my documents"),
			undefined,
			options({
				action: "list",
				limit: 0,
				query: "0",
				timeRangeStart: "0",
				timeRangeEnd: "0",
				scope: "all-visible",
			}),
		);

		expect(service.listDocumentsDetailed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				limit: 25,
				query: undefined,
				timeRangeStart: undefined,
				timeRangeEnd: undefined,
			}),
		);
	});

	it("preserves zero when the user explicitly asks for it", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);

		await documentAction.handler?.(
			runtime,
			makeMessage("List documents matching 0"),
			undefined,
			options({ action: "list", query: "0", scope: "all-visible" }),
		);

		expect(service.listDocumentsDetailed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ query: "0" }),
		);
	});

	it("keeps query-miss fallback documents separate from matched documents", async () => {
		const service = makeService();
		const document = {
			id: DOC_ID,
			content: { text: "Launch is Friday." },
			metadata: { title: "Launch Notes" },
		} as Memory;
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "query_miss",
				query: "list all",
				availableDocuments: [document],
				totalVisible: 1,
				totalAvailable: 1,
			}),
		);
		const { runtime } = makeRuntime(service);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("list all documents"),
			undefined,
			options({ action: "list", query: "list all" }),
		);

		expect(res?.text).toBe(
			`No documents matched "list all". Showing available documents instead:\nAvailable documents:\n1. Launch Notes (${DOC_ID})`,
		);
		expect(res?.data).toMatchObject({
			status: "query_miss",
			query: "list all",
			documents: [],
			availableDocuments: [document],
			totalMatched: 0,
			availableOffset: 0,
			availableHasMore: false,
		});
	});

	it("reports fallback pagination independently from query matches", async () => {
		const service = makeService();
		const document = {
			id: DOC_ID,
			content: { text: "Launch is Friday." },
			metadata: { title: "Launch Notes" },
		} as Memory;
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "query_miss",
				query: "missing",
				offset: 5,
				availableOffset: 5,
				availableDocuments: [document],
				totalVisible: 10,
				totalAvailable: 10,
				availableHasMore: true,
			}),
		);
		const { runtime } = makeRuntime(service);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("list missing documents"),
			undefined,
			options({ action: "list", query: "missing", offset: 5 }),
		);

		expect(res?.text).toContain("available documents from offset 5");
		expect(res?.data).toMatchObject({
			hasMore: false,
			availableOffset: 5,
			availableHasMore: true,
		});
	});

	it("reports an exhausted page without calling the store empty", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValueOnce(
			listResult({
				status: "page_exhausted",
				query: "launch",
				offset: 2,
				totalVisible: 2,
				totalAvailable: 2,
				totalMatched: 2,
			}),
		);
		const { runtime } = makeRuntime(service);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("list launch documents"),
			undefined,
			options({ action: "list", query: "launch", offset: 2 }),
		);

		expect(res?.text).toBe(
			'Offset 2 is past the 2 documents matching "launch".',
		);
		expect(res?.data).toMatchObject({
			status: "page_exhausted",
			documents: [],
			availableDocuments: [],
			offset: 2,
			totalMatched: 2,
		});
	});

	it("uses empty-store semantics only when no visible documents exist", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("list all documents"),
			undefined,
			options({ action: "list" }),
		);

		expect(res?.text).toBe("No documents are available.");
		expect(res?.data).toMatchObject({
			status: "empty_store",
			totalVisible: 0,
			documents: [],
			availableDocuments: [],
		});
	});

	it("extracts a missing search query instead of stripping English prose in the handler", async () => {
		const service = makeService();
		const { runtime, useModel } = makeRuntime(service);
		useModel.mockResolvedValueOnce(
			JSON.stringify({
				action: "search",
				params: { query: "launch notes" },
				missing: [],
				confidence: 1,
			}),
		);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("search my documents for launch notes"),
			undefined,
			options({ action: "search" }),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(service.searchDocuments).toHaveBeenCalledTimes(1);
		expect(service.searchDocuments.mock.calls[0]?.[0]).toMatchObject({
			content: { text: "launch notes" },
		});
		expect(res?.data).toMatchObject({
			subaction: "search",
			query: "launch notes",
		});
	});

	it("extracts write text instead of stripping an English save prefix", async () => {
		const service = makeService();
		const { runtime, useModel } = makeRuntime(service);
		useModel.mockResolvedValueOnce(
			JSON.stringify({
				action: "write",
				params: { text: "Launch is Friday." },
				missing: [],
				confidence: 1,
			}),
		);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("save this as a document: Launch is Friday."),
			undefined,
			options({ action: "write" }),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(service.addDocument).toHaveBeenCalledTimes(1);
		expect(service.addDocument.mock.calls[0]?.[0]).toMatchObject({
			content: "Launch is Friday.",
			addedByRole: "USER",
			roomId: ROOM_ID,
			worldId: WORLD_ID,
		});
		expect(runtime.getRoomsForParticipants).not.toHaveBeenCalled();
		expect(res?.data).toMatchObject({ subaction: "write" });
	});

	it("fails closed when canonical room lookup fails during a write", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		const lookupFailure = new Error("database unavailable");
		(runtime.getRoom as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({ id: ROOM_ID, worldId: WORLD_ID })
			.mockRejectedValueOnce(lookupFailure);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("save Launch is Friday"),
			undefined,
			options({ action: "write", text: "Launch is Friday." }),
		);

		expect(service.addDocument).not.toHaveBeenCalled();
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({
			error: "DOCUMENT_ROOM_LOOKUP_FAILED",
		});
	});

	it("asks for clarification when search has no query the extractor can supply", async () => {
		const service = makeService();
		const { runtime, useModel } = makeRuntime(service);
		const clarifications: string[] = [];
		useModel.mockResolvedValueOnce(
			JSON.stringify({
				action: "search",
				params: {},
				missing: ["query"],
				confidence: 1,
			}),
		);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("search my documents"),
			undefined,
			options({ action: "search" }),
			async (content) => {
				if (typeof content.text === "string") {
					clarifications.push(content.text);
				}
				return [];
			},
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(service.searchDocuments).not.toHaveBeenCalled();
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({
			error: "missing_sub_action",
			missing: ["query"],
		});
		// Planner-facing contract: the clarification ask rides result.text;
		// no visible callback fires (the evaluator voices the question).
		expect(clarifications).toHaveLength(0);
	});

	it("asks for clarification when write has no text the extractor can supply", async () => {
		const service = makeService();
		const { runtime, useModel } = makeRuntime(service);
		const clarifications: string[] = [];
		useModel.mockResolvedValueOnce(
			JSON.stringify({
				action: "write",
				params: {},
				missing: ["text"],
				confidence: 1,
			}),
		);

		const res = await documentAction.handler?.(
			runtime,
			makeMessage("save this as a document"),
			undefined,
			options({ action: "write" }),
			async (content) => {
				if (typeof content.text === "string") {
					clarifications.push(content.text);
				}
				return [];
			},
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(service.addDocument).not.toHaveBeenCalled();
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({
			error: "missing_sub_action",
			missing: ["text"],
		});
		// Planner-facing contract: the clarification ask rides result.text;
		// no visible callback fires (the evaluator voices the question).
		expect(clarifications).toHaveLength(0);
	});

	it("forwards a structured documentId to read without scanning the text", async () => {
		const service = makeService();
		service.readDocumentRange.mockResolvedValueOnce({
			text: "hello doc",
			start: 0,
			end: 1,
			total: 1,
			documentRevision: 0,
			sourceFingerprint: "md5:test",
		} as never);
		const { runtime } = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("no uuid in this text"),
			undefined,
			options({ action: "read", documentId: DOC_ID }),
		);
		expect(service.readDocumentRange).toHaveBeenCalledWith(
			DOC_ID,
			{ unit: "line", offset: 0, limit: 100 },
			expect.anything(),
		);
		expect(res?.data).toMatchObject({ subaction: "read" });
	});

	it("returns service-unavailable when the service disappears at dispatch", async () => {
		const { runtime } = makeRuntime(makeService());
		(runtime.getService as ReturnType<typeof vi.fn>).mockReturnValue(null);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("list documents"),
			undefined,
			options({ action: "list" }),
		);
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({ error: "service_unavailable" });
	});
});
