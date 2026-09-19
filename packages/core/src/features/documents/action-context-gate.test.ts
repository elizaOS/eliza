/**
 * Exercises provider/action admission and read-only knowledge routing through
 * the real gates and document handler with controlled storage collaborators.
 * Message and merged app-state routing retain their separate entry contracts.
 */
import { describe, expect, it, vi } from "vitest";
import { actionGateRejection } from "../../runtime/action-gate.ts";
import { filterByContextGate } from "../../runtime/context-gates.ts";
import type {
	AgentContext,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	State,
	UUID,
} from "../../types";
import {
	CONTEXT_ROUTING_STATE_KEY,
	setContextRoutingMetadata,
} from "../../utils/context-routing.ts";
import { documentAction } from "./actions.ts";
import { documentsProvider } from "./provider.ts";
import { type DocumentListResult, DocumentService } from "./service.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-00000000face" as UUID;
const DOC_ID = "11111111-2222-3333-4444-555555555555" as UUID;

function expectAdmission(activeContexts: AgentContext[], allowed: boolean) {
	expect(
		filterByContextGate([documentsProvider], activeContexts, ["USER"])
			.length === 1,
	).toBe(allowed);
	const rejection = actionGateRejection(documentAction, {
		message: { content: {} } as Memory,
		activeContexts,
		userRoles: ["USER"],
	});
	if (allowed) expect(rejection).toBeUndefined();
	else expect(rejection?.kind).toBe("context");
}

function makeMessage(text: string, routedContext?: AgentContext): Memory {
	const message = {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
	if (routedContext) {
		setContextRoutingMetadata(message, { primaryContext: routedContext });
	}
	return message;
}

function makeKnowledgeState(): State {
	return {
		values: {
			[CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "knowledge" },
		},
	} as unknown as State;
}

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

function makeService() {
	return {
		listDocumentsDetailed: vi.fn(async () => listResult()),
		searchDocuments: vi.fn(async () => []),
		getDocumentById: vi.fn(async () => null),
		// The `read` subaction goes through the bounded progressive-read API
		// (#24305), not getDocumentById; a missing document is the null case.
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
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be called on the planner-trust path");
		}),
	} as unknown as IAgentRuntime;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("DOCUMENT provider and action admission", () => {
	it("admits the provider and action in exact stored-document contexts", () => {
		expectAdmission(["documents"], true);
		expectAdmission(["knowledge"], true);
		expectAdmission(["knowledge", "general"], true);
		expectAdmission(["simple", "knowledge"], true);
	});

	it("rejects both surfaces in unrelated contexts", () => {
		expectAdmission(["web"], false);
		expectAdmission(["wallet"], false);
		expectAdmission(["simple"], false);
	});
});

describe("DOCUMENT handler operation gate on knowledge-routed turns", () => {
	it.each([
		["list", {}, "listDocumentsDetailed"],
		["search", { query: "launch notes" }, "searchDocuments"],
		["read", { id: DOC_ID }, "readDocumentRange"],
	] as const)(
		"allows the read-only %s subaction when routed to knowledge",
		async (action, extraParams, method) => {
			const service = makeService();
			const runtime = makeRuntime(service);
			await documentAction.handler?.(
				runtime,
				makeMessage("what do we know about the launch?", "knowledge"),
				undefined,
				options({ action, ...extraParams }),
			);
			expect(service[method]).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["write", { text: "Launch is Friday." }],
		["edit", { id: DOC_ID, text: "Launch moved." }],
		["delete", { id: DOC_ID }],
		["import_file", { filePath: "/tmp/launch.md" }],
		// Unroutable loopback port: the gate must reject before any fetch, so a
		// regression fails fast on a connection error instead of a live request.
		["import_url", { url: "https://127.0.0.1:9/launch" }],
	] as const)(
		"rejects the mutating %s subaction when routed to knowledge",
		async (action, extraParams) => {
			const service = makeService();
			const runtime = makeRuntime(service);
			const res = await documentAction.handler?.(
				runtime,
				makeMessage("do the thing", "knowledge"),
				undefined,
				options({ action, ...extraParams }),
			);
			expect(res?.success).toBe(false);
			expect(res?.values).toMatchObject({
				error: "knowledge_context_read_only",
			});
			expect(service.addDocument).not.toHaveBeenCalled();
			expect(service.updateDocument).not.toHaveBeenCalled();
			expect(service.deleteDocument).not.toHaveBeenCalled();
		},
	);

	it("still allows mutating subactions when routed to documents", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("save this as a document: launch is Friday", "documents"),
			undefined,
			options({ action: "write", text: "Launch is Friday." }),
		);
		expect(res?.success).toBe(true);
		expect(service.addDocument).toHaveBeenCalledTimes(1);
	});

	it("stays permissive when no routing metadata is present", async () => {
		// Direct invocations (tests, deterministic evaluator calls, legacy
		// paths) carry no routing decision; the operation gate only narrows
		// knowledge-routed turns, it does not invent a restriction elsewhere.
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage("save this: launch is Friday"),
			undefined,
			options({ action: "write", text: "Launch is Friday." }),
		);
		expect(res?.success).toBe(true);
		expect(service.addDocument).toHaveBeenCalledTimes(1);
	});
});

describe("DOCUMENT handler operation gate on app-path merged routing", () => {
	it.each([
		["list", {}, "listDocumentsDetailed"],
		["read", { id: DOC_ID }, "readDocumentRange"],
	] as const)(
		"allows the read-only %s subaction when state is knowledge and message is general (app-path)",
		async (action, extraParams, method) => {
			const service = makeService();
			const runtime = makeRuntime(service);
			const state = makeKnowledgeState();
			const message = makeMessage(
				"what do we know about the launch?",
				"general",
			);
			const res = await documentAction.handler?.(
				runtime,
				message,
				state,
				options({ action, ...extraParams }),
			);
			expect(service[method]).toHaveBeenCalledTimes(1);
			expect(res?.values).not.toMatchObject({
				error: "knowledge_context_read_only",
			});
		},
	);

	it.each([
		["delete", { id: DOC_ID }],
		["write", { text: "Launch is Friday." }],
	] as const)(
		"rejects the mutating %s subaction when state is knowledge and message is general (app-path)",
		async (action, extraParams) => {
			const service = makeService();
			const runtime = makeRuntime(service);
			const state = makeKnowledgeState();
			const message = makeMessage("do the thing", "general");
			const res = await documentAction.handler?.(
				runtime,
				message,
				state,
				options({ action, ...extraParams }),
			);
			expect(res?.success).toBe(false);
			expect(res?.values).toMatchObject({
				error: "knowledge_context_read_only",
			});
			expect(service.addDocument).not.toHaveBeenCalled();
			expect(service.updateDocument).not.toHaveBeenCalled();
			expect(service.deleteDocument).not.toHaveBeenCalled();
		},
	);
});
