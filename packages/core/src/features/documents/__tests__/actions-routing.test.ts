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
import { DocumentService } from "../service";

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
const DOC_ID = "11111111-2222-3333-4444-555555555555" as UUID;

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
		listDocuments: vi.fn(async () => []),
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
		useModel,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("documentAction.validate", () => {
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
		expect(service.listDocuments).toHaveBeenCalledTimes(1);
		expect(service.deleteDocument).not.toHaveBeenCalled();
		expect(res?.data).toMatchObject({
			actionName: "DOCUMENT",
			subaction: "list",
		});
	});

	it.each([
		["search", "searchDocuments"],
		["list", "listDocuments"],
	] as const)("routes the %s subaction to the matching service call", async (action, method) => {
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
		});
		expect(res?.data).toMatchObject({ subaction: "write" });
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
		expect(clarifications).toHaveLength(1);
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
		expect(clarifications).toHaveLength(1);
	});

	it("forwards a structured documentId to read without scanning the text", async () => {
		const service = makeService();
		service.getDocumentById.mockResolvedValueOnce({
			content: { text: "hello doc" },
		} as never);
		const { runtime } = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("no uuid in this text"),
			undefined,
			options({ action: "read", documentId: DOC_ID }),
		);
		expect(service.getDocumentById).toHaveBeenCalledWith(
			DOC_ID,
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
