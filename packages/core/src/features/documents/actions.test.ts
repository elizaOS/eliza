/**
 * Covers the DOCUMENT umbrella action handler in actions.ts through its real
 * public surface: `documentAction.handler`, `documentAction.validate`,
 * `registerDocumentsSearchCategory`, and `documentActions`. The runtime and
 * DocumentService are deterministic stubs at the module's real boundaries; the
 * resolver, role checks, scope logic, revision gates, and result shaping all
 * run for real. Knowledge-routing gate coverage lives in
 * action-context-gate.test.ts and is intentionally not duplicated here.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaError } from "../../errors";
import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
	UUID,
} from "../../types";
import { documentAction, documentActions } from "./actions.ts";
import {
	type DocumentListResult,
	DocumentService,
	type SearchMode,
} from "./service.ts";
import type { StoredDocument } from "./types.ts";

vi.mock("./url-ingest.ts", () => ({
	fetchDocumentFromUrl: vi.fn(async () => ({
		contentType: "html",
		mimeType: "text/html",
		filename: "page.html",
		content: "<h1>Hello</h1>",
	})),
	isYouTubeUrl: vi.fn(() => false),
}));

import { fetchDocumentFromUrl, isYouTubeUrl } from "./url-ingest.ts";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const OWNER_ID = "00000000-0000-0000-0000-00000000ea12" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-00000000face" as UUID;
const DOC_ID = "11111111-2222-3333-4444-555555555555" as UUID;
const OTHER_DOC_ID = "11111111-2222-3333-4444-555555555556" as UUID;
const ENTITY_ID = "22222222-3333-4444-5555-666666666666" as UUID;

function makeMessage(
	text: string,
	opts: {
		entityId?: UUID;
		withWorldId?: boolean;
	} = {},
): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: opts.entityId ?? USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		worldId: opts.withWorldId ? WORLD_ID : undefined,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
}

function makeStoredDocument(
	overrides: Partial<StoredDocument> = {},
): StoredDocument {
	return {
		id: DOC_ID,
		content: { text: "fragment body" },
		metadata: {},
		similarity: 0.9,
		...overrides,
	};
}

function makePage(overrides: Record<string, unknown> = {}) {
	return {
		text: "line one\nline two",
		start: 0,
		end: 2,
		total: 2,
		documentRevision: 3,
		revisionAttemptId: "attempt-1",
		sourceFingerprint: "fp-1",
		...overrides,
	};
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

function listDocMemory(id: string, metadata?: Record<string, unknown>): Memory {
	return { id, metadata } as unknown as Memory;
}

function makeService() {
	return {
		listDocumentsDetailed: vi.fn(async () => listResult()),
		searchDocuments: vi.fn(async (): Promise<StoredDocument[]> => []),
		getDocumentById: vi.fn(async () => null),
		readDocumentRange: vi.fn(async () => null),
		addDocument: vi.fn(async () => ({
			clientDocumentId: DOC_ID,
			fragmentCount: 1,
		})),
		updateDocument: vi.fn(async () => ({
			documentId: DOC_ID,
			fragmentCount: 3,
		})),
		deleteDocument: vi.fn(async () => undefined),
	};
}

type WorldRoles = {
	roles?: Record<string, string>;
	roleSources?: Record<string, string>;
};

function makeRuntime(
	service: ReturnType<typeof makeService>,
	world: WorldRoles = { roles: { [USER_ID]: "USER" } },
): IAgentRuntime {
	const categories = new Map<string, SearchCategoryRegistration>();
	return {
		agentId: AGENT_ID,
		logger: { warn: vi.fn(), error: vi.fn() },
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
		registeredCategories: categories,
		getSetting: vi.fn(() => undefined),
		useModel: vi.fn(async () => {
			throw new Error("useModel must not be called on planner-trust paths");
		}),
		reportError: vi.fn(),
		getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
		getWorld: vi.fn(async () => ({
			id: WORLD_ID,
			agentId: AGENT_ID,
			metadata: world,
		})),
		getRoomsForParticipants: vi.fn(async () => [ROOM_ID]),
	} as unknown as IAgentRuntime;
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

async function run(
	runtime: IAgentRuntime,
	message: Memory,
	parameters: Record<string, unknown>,
	callback?: HandlerCallback,
	state?: undefined,
): Promise<ActionResult> {
	return (await documentAction.handler?.(
		runtime,
		message,
		state,
		options(parameters),
		callback,
	)) as ActionResult;
}

beforeEach(() => {
	vi.mocked(fetchDocumentFromUrl).mockClear();
	vi.mocked(isYouTubeUrl).mockClear();
});

describe("DOCUMENT validate and registration", () => {
	it("returns true and registers the documents search category when the service exists", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await expect(
			documentAction.validate?.(runtime, makeMessage("hi")),
		).resolves.toBe(true);
		expect(runtime.getService).toHaveBeenCalledWith(
			DocumentService.serviceType,
		);
		expect(runtime.registerSearchCategory).toHaveBeenCalledTimes(1);
	});

	it("registers the documents category only once across repeated calls", async () => {
		const runtime = makeRuntime(makeService());
		const { registerDocumentsSearchCategory } = await import("./actions.ts");
		registerDocumentsSearchCategory(runtime);
		registerDocumentsSearchCategory(runtime);
		expect(runtime.registerSearchCategory).toHaveBeenCalledTimes(1);
		const registration = (
			runtime as unknown as {
				registeredCategories: Map<string, SearchCategoryRegistration>;
			}
		).registeredCategories.get("documents");
		expect(registration?.contexts).toEqual(["documents"]);
		expect(registration?.serviceType).toBe(DocumentService.serviceType);
	});

	it("returns false when the documents service is absent", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		vi.mocked(runtime.getService).mockReturnValue(null);
		await expect(
			documentAction.validate?.(runtime, makeMessage("hi")),
		).resolves.toBe(false);
	});

	it("exposes exactly one action", () => {
		expect(documentActions).toEqual([documentAction]);
		expect(documentAction.name).toBe("DOCUMENT");
	});
});

describe("DOCUMENT handler infrastructure failures", () => {
	it("reports service_unavailable without routing when no service is registered", async () => {
		const runtime = makeRuntime(makeService());
		vi.mocked(runtime.getService).mockReturnValue(null);
		const res = await run(runtime, makeMessage("list docs"), {
			action: "list",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "service_unavailable" });
		expect(res.data).toMatchObject({
			actionName: "DOCUMENT",
			subaction: "search",
		});
	});

	it("asks a clarifying question when extraction cannot resolve a subaction", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		vi.mocked(runtime.useModel).mockResolvedValue(
			JSON.stringify({
				action: null,
				params: {},
				missing: ["action"],
				confidence: 0,
			}),
		);
		const res = await run(runtime, makeMessage("do something"), {});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({
			error: "missing_sub_action",
			missing: ["action"],
		});
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(service.searchDocuments).not.toHaveBeenCalled();
	});
});

describe("DOCUMENT search subaction", () => {
	it("projects fragments with references, transcript fields, and retrieval scope", async () => {
		const service = makeService();
		service.searchDocuments.mockResolvedValue([
			makeStoredDocument({
				id: DOC_ID,
				content: { text: "first fragment" },
				metadata: {
					documentId: DOC_ID,
					transcriptId: "t-1",
					startMs: 1000,
					endMs: 2000,
				},
				similarity: 0.92,
			}),
			makeStoredDocument({
				id: OTHER_DOC_ID,
				content: { text: "second fragment" },
				similarity: 0.51,
			}),
		]);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("search the docs"), {
			action: "search",
			query: "launch notes",
		});
		expect(res.success).toBe(true);
		expect(res.text).toContain(
			'Found 2 document fragment(s) for "launch notes"',
		);
		expect(res.text).toContain("1. first fragment");
		expect(res.text).toContain("2. second fragment");
		expect(res.text).toContain(
			"Searched a bounded ranked retrieval window of 2 fragment(s); completeness beyond that window is unknown.",
		);
		const results = (res.values as { results: Array<Record<string, unknown>> })
			.results;
		expect(results[0].reference).toBeDefined();
		expect(results[0].transcriptId).toBe("t-1");
		expect(results[0].startMs).toBe(1000);
		expect(results[0].endMs).toBe(2000);
		expect(results[1].coordinateUnavailable).toBe(true);
		expect(results[1].reference).toBeUndefined();
		expect((res.values as { query: string }).query).toBe("launch notes");
		expect((res.values as { scope: Record<string, unknown> }).scope).toEqual(
			expect.objectContaining({
				retrieved: 2,
				matchedInWindow: 2,
				shown: 2,
				hasMoreInWindow: false,
				filtersApplied: [],
			}),
		);
	});

	it("passes the query as message text plus mode to searchDocuments", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await run(runtime, makeMessage("find it"), {
			action: "search",
			query: "quarterly numbers",
			searchMode: "keyword",
		});
		expect(service.searchDocuments).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.objectContaining({ text: "quarterly numbers" }),
			}),
			undefined,
			"keyword" satisfies SearchMode,
		);
	});

	it("applies tag and time filters client-side and reports them", async () => {
		const service = makeService();
		service.searchDocuments.mockResolvedValue([
			makeStoredDocument({
				id: DOC_ID,
				metadata: { tags: ["alpha"], addedAt: 631180800000 },
			}),
			makeStoredDocument({
				id: OTHER_DOC_ID,
				metadata: { tags: ["beta"], addedAt: 1577836800000 },
			}),
		]);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("find it"), {
			action: "search",
			query: "q",
			tags: ["alpha"],
			timeRangeStart: "1980-01-01T00:00:00.000Z",
			timeRangeEnd: "2000-01-01T00:00:00.000Z",
		});
		const scope = (res.values as { scope: Record<string, unknown> }).scope;
		expect(scope).toEqual(
			expect.objectContaining({
				retrieved: 2,
				matchedInWindow: 1,
				shown: 1,
				hasMoreInWindow: false,
				filtersApplied: ["timeRangeStart", "timeRangeEnd", "tags"],
			}),
		);
		expect((res.values as { results: unknown[] }).results).toHaveLength(1);
	});

	it("honors a bounded limit and reports more matches in the window", async () => {
		const service = makeService();
		service.searchDocuments.mockResolvedValue([
			makeStoredDocument({ id: DOC_ID }),
			makeStoredDocument({ id: OTHER_DOC_ID }),
			makeStoredDocument({ id: ENTITY_ID }),
		]);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("find it"), {
			action: "search",
			query: "q",
			limit: 2,
		});
		const scope = (res.values as { scope: Record<string, unknown> }).scope;
		expect(scope).toEqual(
			expect.objectContaining({
				shown: 2,
				limit: 2,
				hasMoreInWindow: true,
			}),
		);
		expect(
			res.text.endsWith(
				" More filtered matches exist within the retrieved window beyond the 2 shown.",
			),
		).toBe(true);
	});
});

describe("DOCUMENT read subaction", () => {
	it("rejects reads with no resolvable document id", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("read the thing"), {
			action: "read",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "invalid_id" });
		expect(service.readDocumentRange).not.toHaveBeenCalled();
	});

	it("extracts a bare uuid from the user's message text", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await run(runtime, makeMessage(`please open ${DOC_ID} for me`), {
			action: "read",
		});
		expect(service.readDocumentRange).toHaveBeenCalledWith(
			DOC_ID,
			{ unit: "line", offset: 0, limit: 100 },
			expect.anything(),
		);
	});

	it("prefers an explicit unit=fragment request", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await run(runtime, makeMessage("read"), {
			action: "read",
			documentId: DOC_ID,
			unit: "fragment",
		});
		expect(service.readDocumentRange).toHaveBeenCalledWith(
			DOC_ID,
			{ unit: "fragment", offset: 0, limit: 100 },
			expect.anything(),
		);
	});

	it("refuses missing pages as not_found", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("read"), {
			action: "read",
			id: DOC_ID,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "not_found" });
		expect(res.text).toContain("doesn't exist");
	});

	it("translates an offset past the source into DOCUMENT_READ_INVALID_RANGE", async () => {
		const service = makeService();
		service.readDocumentRange.mockResolvedValue(makePage({ total: 10 }));
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("read"), {
			action: "read",
			id: DOC_ID,
			offset: 50,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "DOCUMENT_READ_INVALID_RANGE" });
	});

	it.each([
		["offset", -1],
		["limit", 0],
	])(
		"rejects invalid %s before touching the service",
		async (_field, value) => {
			const service = makeService();
			const runtime = makeRuntime(service);
			const res = await run(runtime, makeMessage("read"), {
				action: "read",
				id: DOC_ID,
				offset: value === -1 ? -1 : undefined,
				limit: value === 0 ? 0 : undefined,
			});
			expect(res.success).toBe(false);
			expect(res.values).toMatchObject({
				error: "DOCUMENT_READ_INVALID_RANGE",
			});
			expect(service.readDocumentRange).not.toHaveBeenCalled();
		},
	);

	it("requires a revision to continue reading past the first page", async () => {
		const service = makeService();
		service.readDocumentRange.mockResolvedValue(
			makePage({ start: 10, end: 20, total: 40 }),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("continue reading"), {
			action: "read",
			id: DOC_ID,
			offset: 10,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({
			error: "expected_revision_required",
			documentId: DOC_ID,
		});
		expect(res.promptData).toMatchObject({
			actionName: "DOCUMENT",
			subaction: "read",
			error: "expected_revision_required",
		});
	});

	it("detects stale revisions explicitly instead of shifting offsets", async () => {
		const service = makeService();
		service.readDocumentRange.mockResolvedValue(
			makePage({ start: 10, end: 20, total: 40 }),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("continue reading"), {
			action: "read",
			id: DOC_ID,
			offset: 10,
			expectedRevision: "rev:not-the-current-one",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "stale_revision" });
		expect((res.data as { currentRevision: string }).currentRevision).toMatch(
			/^rev:[0-9a-f]{64}$/,
		);
	});

	it("continues reading when the caller presents the current revision", async () => {
		const service = makeService();
		service.readDocumentRange
			.mockResolvedValueOnce(makePage())
			.mockResolvedValueOnce(
				makePage({
					text: "line three\nline four",
					start: 2,
					end: 4,
					total: 4,
				}),
			);
		const runtime = makeRuntime(service);
		const first = await run(runtime, makeMessage("read the doc"), {
			action: "read",
			id: DOC_ID,
		});
		expect(first.success).toBe(true);
		expect(first.text).toBe("line one\nline two");
		const revision = (
			first.values as { readView: { slice: { revision: string } } }
		).readView.slice.revision;
		expect(revision).toMatch(/^rev:[0-9a-f]{64}$/);

		const second = await run(runtime, makeMessage("keep going"), {
			action: "read",
			id: DOC_ID,
			offset: 2,
			expectedRevision: revision,
		});
		expect(second.success).toBe(true);
		expect(second.text).toBe("line three\nline four");
		const slice = (
			second.values as {
				readView: {
					slice: {
						completeness: string;
						range: Record<string, unknown>;
						sliceSha256: string;
						revision: string;
					};
				};
			}
		).readView.slice;
		expect(slice.completeness).toBe("complete");
		expect(slice.range).toEqual({ unit: "line", start: 2, end: 4, total: 4 });
		expect(slice.revision).toBe(revision);
		expect(slice.sliceSha256).toBe(
			createHash("sha256").update("line three\nline four").digest("hex"),
		);
	});

	it("marks partial pages as partial-recoverable", async () => {
		const service = makeService();
		service.readDocumentRange.mockResolvedValue(makePage({ total: 40 }));
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("read the doc"), {
			action: "read",
			id: DOC_ID,
		});
		const slice = (
			res.values as { readView: { slice: { completeness: string } } }
		).readView.slice;
		expect(slice.completeness).toBe("partial-recoverable");
	});
});

describe("DOCUMENT write subaction", () => {
	it("never stores anything when a write lacks text and extraction fails", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		vi.mocked(runtime.useModel).mockResolvedValue(
			JSON.stringify({
				action: null,
				params: {},
				missing: ["action"],
				confidence: 0,
			}),
		);
		const res = await run(runtime, makeMessage("save a doc"), {
			action: "write",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({
			error: "missing_sub_action",
			missing: ["action"],
		});
		expect(service.addDocument).not.toHaveBeenCalled();
	});

	it("denies agent-private writes to non-owner users", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("save this"), {
			action: "write",
			text: "secret thoughts",
			scope: "agent-private",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "forbidden" });
		expect(service.addDocument).not.toHaveBeenCalled();
	});

	it("denies global writes to plain users", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("save this globally"), {
			action: "write",
			text: "announcement",
			scope: "global",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "forbidden" });
	});

	it("stores a user-private document by default for external senders", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		let emitted: { text: string; actions?: string[] } | undefined;
		const res = await run(
			runtime,
			makeMessage("# Launch notes\nbody line", { withWorldId: true }),
			{ action: "write", text: "# Launch notes\nbody line", tags: ["ops"] },
			async (content) => {
				emitted = content as { text: string; actions?: string[] };
			},
		);
		expect(res.success).toBe(true);
		expect(res.text).toBe('Saved "Launch notes" to your documents.');
		expect(emitted?.text).toBe('Saved "Launch notes" to your documents.');
		expect(emitted?.actions).toEqual(["DOCUMENT"]);
		expect(res.userFacingText).toBe(res.text);
		expect(res.verifiedUserFacing).toBe(true);
		expect(res.turnComplete).toBe(true);
		expect(res.values).toMatchObject({
			title: "Launch notes",
			scope: "user-private",
		});
		expect(service.addDocument).toHaveBeenCalledTimes(1);
		const addArgs = service.addDocument.mock.calls[0][0] as {
			scope: string;
			scopedToEntityId: UUID;
			entityId: UUID;
			worldId: UUID;
			content: string;
			metadata: Record<string, unknown>;
		};
		expect(addArgs.scope).toBe("user-private");
		expect(addArgs.scopedToEntityId).toBe(USER_ID);
		expect(addArgs.entityId).toBe(USER_ID);
		expect(addArgs.worldId).toBe(WORLD_ID);
		expect(addArgs.content).toBe("# Launch notes\nbody line");
		expect(addArgs.metadata.originalFilename).toBe("launch-notes.txt");
		expect(addArgs.metadata.fileSize).toBe(
			Buffer.byteLength("# Launch notes\nbody line", "utf8"),
		);
		expect(addArgs.metadata.tags).toEqual(["ops"]);
	});

	it("lets the agent self write into its own agent-private scope using the room's world", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(
			runtime,
			makeMessage("note to self", { entityId: AGENT_ID }),
			{ action: "write", text: "note to self" },
		);
		expect(res.success).toBe(true);
		expect(res.values).toMatchObject({ scope: "agent-private" });
		const addArgs = service.addDocument.mock.calls[0][0] as {
			worldId: UUID;
			scopedToEntityId: UUID;
		};
		expect(addArgs.worldId).toBe(WORLD_ID);
		expect(addArgs.scopedToEntityId).toBe(AGENT_ID);
	});

	it("allows owners to publish global documents", async () => {
		const service = makeService();
		const runtime = makeRuntime(service, {
			roles: { [OWNER_ID]: "OWNER" },
			roleSources: { [OWNER_ID]: "manual" },
		});
		const res = await run(
			runtime,
			makeMessage("publish this", { entityId: OWNER_ID, withWorldId: true }),
			{ action: "write", text: "announcement body", scope: "global" },
		);
		expect(res.success).toBe(true);
		expect(res.values).toMatchObject({ scope: "global" });
		const addArgs = service.addDocument.mock.calls[0][0] as {
			scope: string;
			scopedToEntityId: UUID | undefined;
		};
		expect(addArgs.scope).toBe("global");
		expect(addArgs.scopedToEntityId).toBeUndefined();
	});

	it("fails with DOCUMENT_ROOM_LOOKUP_FAILED when the world cannot be resolved", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		vi.mocked(runtime.getRoom).mockRejectedValue(new Error("db down"));
		const res = await run(
			runtime,
			makeMessage("note to self", { entityId: AGENT_ID }),
			{ action: "write", text: "note to self" },
		);
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "DOCUMENT_ROOM_LOOKUP_FAILED" });
	});

	it("fails with DOCUMENT_WORLD_MISSING when the room has no world", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		vi.mocked(runtime.getRoom).mockResolvedValue({ id: ROOM_ID } as never);
		const res = await run(
			runtime,
			makeMessage("note to self", { entityId: AGENT_ID }),
			{ action: "write", text: "note to self" },
		);
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "DOCUMENT_WORLD_MISSING" });
	});
});

describe("DOCUMENT edit subaction", () => {
	it("asks which document to edit when no id resolves", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("edit it"), {
			action: "edit",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "invalid_id" });
	});

	it("asks for replacement text when only whitespace is supplied", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("edit it"), {
			action: "edit",
			id: DOC_ID,
			text: "   ",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "missing_text" });
		expect(service.updateDocument).not.toHaveBeenCalled();
	});

	it("replaces content through updateDocument and confirms once via callback", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		let emitted: { text: string; actions?: string[] } | undefined;
		const res = await run(
			runtime,
			makeMessage("fix the doc"),
			{ action: "edit", id: DOC_ID, content: "  replacement body  " },
			async (content) => {
				emitted = content as { text: string; actions?: string[] };
			},
		);
		expect(res.success).toBe(true);
		expect(res.text).toBe("Updated the document.");
		expect(emitted?.text).toBe("Updated the document.");
		expect(emitted?.actions).toEqual(["DOCUMENT"]);
		expect(res.turnComplete).toBe(true);
		expect(service.updateDocument).toHaveBeenCalledWith({
			documentId: DOC_ID,
			content: "replacement body",
			message: expect.anything(),
		});
		expect(res.values).toMatchObject({
			documentId: DOC_ID,
			fragmentCount: 3,
		});
	});
});

describe("DOCUMENT delete subaction", () => {
	it("refuses deletes with no resolvable id", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("delete something"), {
			action: "delete",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "invalid_id" });
	});

	it("maps DOCUMENT_NOT_FOUND to a structured refusal", async () => {
		const service = makeService();
		service.deleteDocument.mockRejectedValue(
			new ElizaError("no such document", { code: "DOCUMENT_NOT_FOUND" }),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("delete it"), {
			action: "delete",
			id: DOC_ID,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({
			error: "not_found",
			documentId: DOC_ID,
		});
		expect(res.text).toContain("nothing to delete");
	});

	it("maps DOCUMENT_MUTATION_FORBIDDEN to a structured refusal", async () => {
		const service = makeService();
		service.deleteDocument.mockRejectedValue(
			new ElizaError("off limits", { code: "DOCUMENT_MUTATION_FORBIDDEN" }),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("delete it"), {
			action: "delete",
			id: DOC_ID,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({
			error: "forbidden",
			documentId: DOC_ID,
		});
	});

	it("still propagates adapter faults as operation failures, not refusals", async () => {
		const service = makeService();
		service.deleteDocument.mockRejectedValue(new Error("adapter exploded"));
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("delete it"), {
			action: "delete",
			id: DOC_ID,
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "adapter exploded" });
		expect(res.text).toContain("delete operation failed: adapter exploded");
	});

	it("deletes by id and reports completion through one callback", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		let calls = 0;
		const res = await run(
			runtime,
			makeMessage("delete it"),
			{ action: "delete", id: DOC_ID },
			async () => {
				calls += 1;
			},
		);
		expect(res.success).toBe(true);
		expect(res.turnComplete).toBe(true);
		expect(calls).toBe(1);
		expect(service.deleteDocument).toHaveBeenCalledWith(
			DOC_ID,
			expect.anything(),
		);
		expect(res.values).toMatchObject({ documentId: DOC_ID });
	});
});

describe("DOCUMENT list subaction", () => {
	it("clamps limit into 1..100 and floors the offset before listing", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await run(runtime, makeMessage("list docs"), {
			action: "list",
			limit: 5000,
			offset: 3.7,
		});
		expect(service.listDocumentsDetailed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 100, offset: 3 }),
		);
	});

	it("falls back to the default page of 25 for unusable limits", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		await run(runtime, makeMessage("list docs"), {
			action: "list",
			limit: 0,
		});
		expect(service.listDocumentsDetailed).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ limit: 25, offset: undefined }),
		);
	});

	it("renders an empty store", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("what docs exist?"), {
			action: "list",
		});
		expect(res.success).toBe(true);
		expect(res.text).toBe("No documents are available.");
		expect(res.values).toMatchObject({ status: "empty_store" });
	});

	it("renders filter misses distinctly from empty stores", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValue(
			listResult({ status: "filter_miss" }),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("list docs"), {
			action: "list",
			scope: "owner-private",
		});
		expect(res.text).toBe("No documents matched the requested filters.");
		expect(res.values).toMatchObject({ status: "filter_miss" });
	});

	it("falls back to listing available documents on a query miss", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValue(
			listResult({
				status: "query_miss",
				query: "zzz",
				totalVisible: 2,
				availableOffset: 7,
				availableDocuments: [
					listDocMemory(DOC_ID, { title: "Alpha" }),
					listDocMemory(OTHER_DOC_ID),
				],
			}),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("find zzz docs"), {
			action: "list",
			query: "zzz",
		});
		expect(res.text).toContain('No documents matched "zzz"');
		expect(res.text).toContain("from offset 7 instead:");
		expect(res.text).toContain(`1. Alpha (${DOC_ID})`);
		expect(res.text).toContain(`2. Document 2 (${OTHER_DOC_ID})`);
	});

	it("explains pagination exhaustion past the matched set", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValue(
			listResult({
				status: "page_exhausted",
				offset: 40,
				totalMatched: 3,
			}),
		);
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("list docs"), {
			action: "list",
			offset: 40,
		});
		expect(res.text).toBe("Offset 40 is past the 3 available documents.");
	});

	it("lists visible documents with title then filename fallbacks", async () => {
		const service = makeService();
		service.listDocumentsDetailed.mockResolvedValue(
			listResult({
				status: "ok",
				documents: [
					listDocMemory(DOC_ID, { title: "Runbook" }),
					listDocMemory(OTHER_DOC_ID, { filename: "fallback-name.md" }),
				],
				totalVisible: 2,
				hasMore: true,
			}),
		);
		const runtime = makeRuntime(service);
		let emitted: { text: string; actions?: string[] } | undefined;
		const res = await run(
			runtime,
			makeMessage("list docs"),
			{ action: "list" },
			async (content) => {
				emitted = content as { text: string; actions?: string[] };
			},
		);
		expect(res.text).toBe(
			`Available documents:\n1. Runbook (${DOC_ID})\n2. fallback-name.md (${OTHER_DOC_ID})`,
		);
		expect(emitted?.text).toBe(res.text);
		expect(emitted?.actions).toEqual(["DOCUMENT"]);
		expect(res.turnComplete).toBe(true);
		expect(res.values).toMatchObject({
			status: "ok",
			totalVisible: 2,
			hasMore: true,
		});
	});
});

describe("DOCUMENT import_file subaction", () => {
	it("asks for a source when neither a path nor content is present", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("import something"), {
			action: "import_file",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "missing_source" });
	});

	it("denies local host file access to non-owner users", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("import that file"), {
			action: "import_file",
			filePath: "/etc/hosts",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "forbidden" });
		expect(service.addDocument).not.toHaveBeenCalled();
	});

	it("reports missing host files as not_found for the agent runtime itself", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const missingPath = path.join(
			tmpdir(),
			"eliza-doc-actions-must-not-exist.md",
		);
		const res = await run(
			runtime,
			makeMessage("import it", { entityId: AGENT_ID }),
			{ action: "import_file", filePath: missingPath },
		);
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "not_found" });
		expect((res.values as { filePath: string }).filePath).toBe(missingPath);
	});

	it("imports supplied text content as a derived-title note", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const content = "# Incident review\nwhat happened";
		const res = await run(
			runtime,
			makeMessage("import this note", {
				entityId: AGENT_ID,
				withWorldId: true,
			}),
			{ action: "import_file", content },
		);
		expect(res.success).toBe(true);
		expect(res.text).toBe('Imported "Incident review" into your documents.');
		expect(res.values).toMatchObject({
			title: "Incident review",
			scope: "agent-private",
		});
		const addArgs = service.addDocument.mock.calls[0][0] as {
			content: string;
			metadata: Record<string, unknown>;
		};
		expect(addArgs.content).toBe(content);
		expect(addArgs.metadata.source).toBe("file");
		expect(addArgs.metadata.textBacked).toBe(true);
	});
});

describe("DOCUMENT import_url subaction", () => {
	it("asks for a URL when none can be resolved", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(runtime, makeMessage("save that link"), {
			action: "import_url",
		});
		expect(res.success).toBe(false);
		expect(res.values).toMatchObject({ error: "missing_url" });
		expect(fetchDocumentFromUrl).not.toHaveBeenCalled();
	});

	it("imports a fetched page with url provenance metadata", async () => {
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(
			runtime,
			makeMessage("file this away", { withWorldId: true }),
			{ action: "import_url", url: "https://example.com/notes" },
		);
		expect(fetchDocumentFromUrl).toHaveBeenCalledWith(
			"https://example.com/notes",
			{ includeImageDescriptions: false },
		);
		expect(isYouTubeUrl).toHaveBeenCalledWith("https://example.com/notes");
		expect(res.success).toBe(true);
		expect(res.text).toBe(
			"Imported the page from https://example.com/notes into your documents.",
		);
		const addArgs = service.addDocument.mock.calls[0][0] as {
			content: string;
			contentType: string;
			metadata: Record<string, unknown>;
		};
		expect(addArgs.contentType).toBe("text/html");
		expect(addArgs.metadata.source).toBe("url");
		expect(addArgs.metadata.url).toBe("https://example.com/notes");
		expect(addArgs.metadata.textBacked).toBe(true);
		expect(res.values).toMatchObject({
			filename: "page.html",
			documentId: DOC_ID,
		});
	});

	it("labels YouTube transcripts as transcripts with transcript metadata", async () => {
		vi.mocked(isYouTubeUrl).mockReturnValue(true);
		vi.mocked(fetchDocumentFromUrl).mockResolvedValueOnce({
			contentType: "transcript",
			mimeType: "text/vtt",
			filename: "talk.vtt",
			content: "WEBVTT",
		} as Awaited<ReturnType<typeof fetchDocumentFromUrl>>);
		const service = makeService();
		const runtime = makeRuntime(service);
		const res = await run(
			runtime,
			makeMessage("grab that talk", { withWorldId: true }),
			{
				action: "import_url",
				url: "https://www.youtube.com/watch?v=abc123",
			},
		);
		expect(res.success).toBe(true);
		expect(res.text).toBe(
			"Imported the transcript from https://www.youtube.com/watch?v=abc123 into your documents.",
		);
		const addArgs = service.addDocument.mock.calls[0][0] as {
			metadata: Record<string, unknown>;
		};
		expect(addArgs.metadata.source).toBe("youtube");
		expect(addArgs.metadata.isYouTubeTranscript).toBe(true);
	});
});
