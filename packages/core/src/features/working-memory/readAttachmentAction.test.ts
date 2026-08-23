/**
 * Unit coverage for the ATTACHMENT action's core surface — operation-kind
 * routing and precedence, validate gating, record selection fallbacks
 * (unavailable id, attachment menu, multi-record selection required),
 * byte-exact UTF-8 paging with revision-gated continuation, task-clipboard
 * outcomes, missing-readable-content messaging, and save_as_document world
 * resolution and boundary failures. Deterministic harness: a hand-rolled
 * runtime stub drives the REAL action with scripted model responses and a
 * temp-dir clipboard; no module mocks and no live model.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";
import { createDocumentNoteFilename } from "../documents/naming.ts";
import {
	completeAttachmentContent,
	readAttachmentAction,
	readAttachmentActionKind,
} from "./readAttachmentAction.ts";

type ModelCall = { modelType: unknown; payload: Record<string, unknown> };

type ReportedError = { scope: string; error: unknown };

interface Harness {
	runtime: IAgentRuntime;
	modelCalls: ModelCall[];
	reportedErrors: ReportedError[];
	addDocumentCalls: Array<Record<string, unknown>>;
	callbacks: Array<Parameters<HandlerCallback>[0]>;
}

function makeAttachment(overrides: Partial<Media> & { id?: string }): Media {
	return {
		id: overrides.id ?? `att-${uuidv4()}`,
		url: "https://example.com/source",
		title: "Source document",
		source: "Test",
		contentType: ContentType.DOCUMENT,
		text: "Stored readable body.",
		...overrides,
	} as Media;
}

function makeHarness(params?: {
	memories?: Memory[];
	room?: Record<string, unknown> | null;
	getRoomError?: Error;
	documentsService?: Record<string, unknown>;
	modelResponse?: string | Error;
}): Harness {
	const modelCalls: ModelCall[] = [];
	const reportedErrors: ReportedError[] = [];
	const addDocumentCalls: Array<Record<string, unknown>> = [];
	const callbacks: Array<Parameters<HandlerCallback>[0]> = [];
	const clipboardDir = mkdtempSync(path.join(tmpdir(), "read-attach-test-"));
	const service =
		params?.documentsService ??
		(params?.documentsService === null
			? null
			: {
					addDocument: async (input: Record<string, unknown>) => {
						addDocumentCalls.push(input);
						return { clientDocumentId: "doc-generated-id", fragmentCount: 2 };
					},
				});
	const runtime = {
		agentId: uuidv4() as UUID,
		getMemories: async () => params?.memories ?? [],
		getRoom: async () => {
			if (params?.getRoomError) throw params.getRoomError;
			return params?.room ?? null;
		},
		getService: (type: string) => (type === "documents" ? service : null),
		getSetting: (key: string) =>
			key === "CLIPBOARD_BASE_PATH" ? clipboardDir : undefined,
		reportError: (scope: string, error: unknown) => {
			reportedErrors.push({ scope, error });
		},
		useModel: async (modelType: unknown, payload: unknown) => {
			if (params?.modelResponse instanceof Error) throw params.modelResponse;
			modelCalls.push({
				modelType,
				payload: payload as Record<string, unknown>,
			});
			return params?.modelResponse ?? "Scripted answer about the attachment.";
		},
	};
	return {
		runtime: runtime as unknown as IAgentRuntime,
		modelCalls,
		reportedErrors,
		addDocumentCalls,
		callbacks,
	};
}

function makeMessage(params: {
	harness: Harness;
	text?: string;
	attachments?: Media[];
	content?: Record<string, unknown>;
	worldId?: UUID;
	createdAt?: number;
}): Memory {
	return {
		id: uuidv4() as UUID,
		agentId: params.harness.runtime.agentId,
		entityId: params.harness.runtime.agentId,
		roomId: uuidv4() as UUID,
		worldId: params.worldId,
		createdAt: params.createdAt ?? Date.now(),
		content: {
			text: params.text ?? "",
			source: "test",
			attachments: params.attachments,
			...params.content,
		},
	} as unknown as Memory;
}

async function runHandler(
	harness: Harness,
	message: Memory,
	options?: Record<string, unknown>,
) {
	const result = await readAttachmentAction.handler(
		harness.runtime,
		message,
		undefined,
		options as never,
		async (response: Parameters<HandlerCallback>[0]) => {
			harness.callbacks.push(response);
		},
	);
	return result;
}

describe("completeAttachmentContent", () => {
	it("returns the identical string reference semantics for plain ASCII", () => {
		expect(completeAttachmentContent("hello world")).toBe("hello world");
	});

	it("never trims, normalizes, or truncates unicode content", () => {
		const value = "café 😀  𝕌𝕟𝕚𝕔𝕠𝕕𝕖\n\ttail  ";
		expect(completeAttachmentContent(value)).toBe(value);
	});

	it("preserves very large content in full", () => {
		const value = `${"x".repeat(100_000)}END`;
		const result = completeAttachmentContent(value);
		expect(result.length).toBe(value.length);
		expect(result).toBe(value);
	});
});

describe("readAttachmentActionKind", () => {
	it("routes the planner action enum to read and save_as_document", () => {
		expect(readAttachmentActionKind({ action: "read" })).toBe("read");
		expect(readAttachmentActionKind({ action: "save_as_document" })).toBe(
			"save_as_document",
		);
	});

	it("recognizes subaction and op aliases when action is absent", () => {
		expect(readAttachmentActionKind({ subaction: "save_as_document" })).toBe(
			"save_as_document",
		);
		expect(readAttachmentActionKind({ op: "read" })).toBe("read");
	});

	it("normalizes case, surrounding whitespace, hyphens, and inner spaces", () => {
		expect(readAttachmentActionKind({ action: " SAVE-AS DOCUMENT " })).toBe(
			"save_as_document",
		);
		expect(readAttachmentActionKind({ action: "\tRead\n" })).toBe("read");
		expect(readAttachmentActionKind({ action: "Save_As_Document" })).toBe(
			"save_as_document",
		);
	});

	it("defaults unsupported, empty, and non-string values to the safe read", () => {
		expect(readAttachmentActionKind({ action: "delete-everything" })).toBe(
			"read",
		);
		expect(readAttachmentActionKind({ action: "" })).toBe("read");
		expect(readAttachmentActionKind({ action: 42 })).toBe("read");
		expect(readAttachmentActionKind({ op: null })).toBe("read");
		expect(readAttachmentActionKind({})).toBe("read");
	});

	it("a recognized action wins over lower-priority aliases", () => {
		expect(
			readAttachmentActionKind({
				action: "read",
				subaction: "save_as_document",
				op: "save_as_document",
			}),
		).toBe("read");
	});

	it("an unrecognized action blocks lower-priority aliases instead of falling through", () => {
		expect(
			readAttachmentActionKind({
				action: "not-a-real-op",
				subaction: "save_as_document",
			}),
		).toBe("read");
	});

	it("subaction outranks op", () => {
		expect(
			readAttachmentActionKind({ subaction: "save_as_document", op: "read" }),
		).toBe("save_as_document");
	});
});

describe("readAttachmentAction.validate", () => {
	it("accepts an explicit attachmentId even with no conversation history", async () => {
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			content: { attachmentId: "some-id" },
		});
		await expect(
			readAttachmentAction.validate(harness.runtime, message),
		).resolves.toBe(true);
	});

	it("accepts an explicit id param as an attachment reference", async () => {
		const harness = makeHarness();
		const message = makeMessage({ harness, content: { id: "row-7" } });
		await expect(
			readAttachmentAction.validate(harness.runtime, message),
		).resolves.toBe(true);
	});

	it("accepts a message carrying its own attachments", async () => {
		const harness = makeHarness();
		const message = makeMessage({ harness, attachments: [makeAttachment({})] });
		await expect(
			readAttachmentAction.validate(harness.runtime, message),
		).resolves.toBe(true);
	});

	it("rejects when no explicit attachment exists and history has none", async () => {
		const harness = makeHarness();
		const message = makeMessage({ harness, text: "anything?" });
		await expect(
			readAttachmentAction.validate(harness.runtime, message),
		).resolves.toBe(false);
	});

	it("propagates conversation lookup rejection instead of fabricating a verdict", async () => {
		const harness = makeHarness();
		(harness.runtime as unknown as Record<string, unknown>).getMemories =
			async () => {
				throw new Error("history store offline");
			};
		const message = makeMessage({ harness, text: "read it" });
		await expect(
			readAttachmentAction.validate(harness.runtime, message),
		).rejects.toThrow("history store offline");
	});
});

describe("readAttachmentAction.handler — record selection fallbacks", () => {
	it("an unavailable explicit id fails verified with ATTACHMENT_UNAVAILABLE_OR_UNAUTHORIZED", async () => {
		const harness = makeHarness();
		const message = makeMessage({ harness, text: "open that file again" });
		const result = await runHandler(harness, message, {
			attachmentId: "ghost-id",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("ATTACHMENT_UNAVAILABLE_OR_UNAUTHORIZED");
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.values).toMatchObject({ awaitingSelection: false });
		expect(result.userFacingText).toBe(
			"That attachment is unavailable or no longer authorized.",
		);
		expect(harness.callbacks).toHaveLength(1);
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("with nothing to read anywhere, the completed reply says the window is empty", async () => {
		const harness = makeHarness();
		const message = makeMessage({ harness, text: "what did I send?" });
		const result = await runHandler(harness, message);
		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({ awaitingSelection: false });
		expect(result.userFacingText).toBe(
			"No attachments are available in the current conversation window.",
		);
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("a non-matching request over multiple history attachments shows the selection menu", async () => {
		const first = makeAttachment({
			id: "hist-1",
			title: "First report",
			text: "alpha body",
		});
		const second = makeAttachment({
			id: "hist-2",
			title: "Second report",
			text: "beta body",
		});
		const older: Memory = {
			id: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			createdAt: Date.now() - 5_000,
			content: { text: "", source: "test", attachments: [first, second] },
		} as unknown as Memory;
		const harness = makeHarness({ memories: [older] });
		const message = makeMessage({ harness, text: "hello there" });
		message.roomId = older.roomId;
		const result = await runHandler(harness, message);
		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"No attachment matched; showed the user the available attachments to pick from",
		);
		expect(result.values).toMatchObject({ awaitingSelection: true });
		expect(result.userFacingText).toContain("Available attachments:");
		expect(result.userFacingText).toContain("hist-1");
		expect(result.userFacingText).toContain("hist-2");
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
		expect(harness.callbacks[0]?.text).toContain("Available attachments:");
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("multiple current attachments without an id require selection with readable byte counts", async () => {
		const alpha = makeAttachment({
			id: "att-alpha",
			title: "Alpha doc",
			text: "A".repeat(10),
		});
		const beta = makeAttachment({
			id: "att-beta",
			title: "Beta notes",
			text: "B".repeat(25),
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "compare these",
			attachments: [alpha, beta],
		});
		const result = await runHandler(harness, message);
		expect(result.success).toBe(true);
		expect(result.values).toMatchObject({ awaitingSelection: true });
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(harness.callbacks[0]?.actions).toEqual([
			"ATTACHMENT_READ_SELECTION_REQUIRED",
		]);
		const data = result.data as Record<string, unknown>;
		expect(data.requiresAttachmentSelection).toBe(true);
		const candidates = data.attachments as Array<Record<string, unknown>>;
		expect(candidates.map((candidate) => candidate.id)).toEqual([
			"att-alpha",
			"att-beta",
		]);
		expect(candidates.map((candidate) => candidate.readableBytes)).toEqual([
			10, 25,
		]);
		const promptData = result.promptData as Record<string, unknown>;
		expect(promptData.requiresAttachmentSelection).toBe(true);
		expect(result.userFacingText).toContain("Select one attachment ID");
		expect(harness.modelCalls).toHaveLength(0);
	});
});

describe("readAttachmentAction.handler — paging and reads", () => {
	function singleRecordHarness(
		modelResponse = "Scripted answer about the attachment.",
	) {
		const attachment = makeAttachment({
			id: "att-page",
			title: "Quarterly Report",
			text: "Hello attachment world.",
		});
		const harness = makeHarness({ modelResponse });
		const message = makeMessage({
			harness,
			text: "what does it say?",
			attachments: [attachment],
		});
		return { harness, message };
	}

	it("a default read answers via the model with complete page and mirrored read views", async () => {
		const { harness, message } = singleRecordHarness();
		const result = await runHandler(harness, message);
		expect(result.success).toBe(true);
		expect(result.text).toBe("Hello attachment world.");
		expect(result.transcriptVisibility).toBe("internal");
		expect(result.userFacingText).toBe("Scripted answer about the attachment.");
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(harness.callbacks).toHaveLength(1);
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_SUCCESS"]);
		expect(harness.callbacks[0]?.text).toBe(
			"Scripted answer about the attachment.",
		);
		const slice = (
			(result.data as Record<string, unknown>).readView as Record<
				string,
				unknown
			>
		).slice as Record<string, unknown>;
		expect(slice.completeness).toBe("complete");
		expect(slice.range).toEqual({
			unit: "byte",
			start: 0,
			end: 23,
			total: 23,
		});
		expect((result.data as Record<string, unknown>).readViews).toHaveLength(1);
		expect(
			(result.promptData as Record<string, unknown>).readView,
		).toBeDefined();
		expect((result.data as Record<string, unknown>).attachmentIds).toEqual([
			"att-page",
		]);
		const call = harness.modelCalls[0];
		expect(call.modelType).toBe(ModelType.TEXT_SMALL);
		expect(call.payload.maxTokens).toBe(1024);
		expect(String(call.payload.prompt)).toContain(
			"Attachment content:\nHello attachment world.",
		);
		const clipboard = (result.data as Record<string, unknown>)
			.clipboard as Record<string, unknown>;
		expect(clipboard).toMatchObject({ requested: false, stored: false });
		expect(
			(result.data as Record<string, unknown>).suppressActionResultClipboard,
		).toBe(false);
	});

	it("byte limits shrink to code-point boundaries and pages reassemble losslessly", async () => {
		const attachment = makeAttachment({
			id: "att-utf8",
			title: "Unicode doc",
			text: "aé😀b",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "page through it",
			attachments: [attachment],
		});
		let revision = "";
		const collected: string[] = [];
		let offset = 0;
		for (let page = 0; page < 4; page += 1) {
			const result = await runHandler(harness, message, {
				offset,
				limit: 4,
				...(revision ? { expectedRevision: revision } : {}),
			});
			expect(result.success).toBe(true);
			collected.push(result.text);
			const readView = (result.data as Record<string, unknown>)
				.readView as Record<string, unknown>;
			const slice = readView.slice as Record<string, unknown>;
			revision = slice.revision as string;
			if (slice.completeness === "complete") break;
			offset = (slice.range as Record<string, number>).end;
		}
		expect(collected.join("")).toBe("aé😀b");
	}, 20_000);

	it("the second page reports partial-recoverable with a resumable range", async () => {
		const attachment = makeAttachment({
			id: "att-partial",
			title: "Long doc",
			text: "abcdefghij",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "keep reading",
			attachments: [attachment],
		});
		const first = await runHandler(harness, message, { limit: 4 });
		const firstSlice = (
			(first.data as Record<string, unknown>).readView as Record<
				string,
				unknown
			>
		).slice as Record<string, unknown>;
		expect(firstSlice.completeness).toBe("partial-recoverable");
		expect((firstSlice.range as Record<string, number>).end).toBe(4);
		const revision = firstSlice.revision as string;
		const second = await runHandler(harness, message, {
			offset: 4,
			limit: 4,
			expectedRevision: revision,
		});
		expect(second.text).toBe("efgh");
		const secondSlice = (
			(second.data as Record<string, unknown>).readView as Record<
				string,
				unknown
			>
		).slice as Record<string, unknown>;
		expect((secondSlice.range as Record<string, number>).start).toBe(4);
	});

	it("continuation without expectedRevision is rejected explicitly", async () => {
		const { harness, message } = singleRecordHarness();
		const result = await runHandler(harness, message, { offset: 5 });
		expect(result.success).toBe(false);
		expect(result.error).toBe("ATTACHMENT_READ_EXPECTED_REVISION_REQUIRED");
		const data = result.data as Record<string, unknown>;
		expect(data.error).toBe("expected_revision_required");
		expect(harness.callbacks).toHaveLength(0);
	});

	it("a stale expectedRevision fails with the current view attached", async () => {
		const { harness, message } = singleRecordHarness();
		const result = await runHandler(harness, message, {
			offset: 5,
			expectedRevision: "attachment:not-the-real-one",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("ATTACHMENT_READ_STALE_REVISION");
		const data = result.data as Record<string, unknown>;
		expect(data.error).toBe("stale_revision");
		expect(data.readView).toBeDefined();
		expect(harness.callbacks).toHaveLength(0);
	});

	it.each([
		[{ limit: 0 }, "must be a safe integer"],
		[{ limit: -3 }, "must be a safe integer"],
		[{ limit: 1.5 }, "must be a safe integer"],
		[{ limit: 65_537 }, "exceeds the maximum page size"],
		[{ offset: 99 }, "exceeds the source"],
	])(
		"invalid paging params %o fail structurally through the boundary",
		async (options, messageFragment) => {
			const { harness, message } = singleRecordHarness();
			const result = await runHandler(harness, message, options);
			expect(result.success).toBe(false);
			expect(String(result.error)).toContain(messageFragment);
			expect(harness.reportedErrors).toHaveLength(1);
			expect(harness.reportedErrors[0]?.scope).toBe(
				"ReadAttachmentAction.handler",
			);
			expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
			expect(harness.callbacks[0]?.text).toBe(
				"I couldn't read that attachment right now.",
			);
		},
	);

	it("an offset splitting a UTF-8 code point is rejected", async () => {
		const attachment = makeAttachment({
			id: "att-split",
			title: "Unicode doc",
			text: "aé😀b",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "page it",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message, { offset: 2 });
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("splits a UTF-8 code point");
	});

	it("nested parameters override top-level duplicates", async () => {
		const { harness, message } = singleRecordHarness();
		const result = await runHandler(harness, message, {
			offset: 999_999,
			parameters: { offset: 0 },
		});
		expect(result.success).toBe(true);
		expect(result.text).toBe("Hello attachment world.");
	});

	it("an explicit record request ships the planner dump with no model call", async () => {
		const { harness, message } = singleRecordHarness();
		message.content.text = "show me the attachment metadata please";
		const result = await runHandler(harness, message);
		expect(result.userFacingText).toContain("ID: att-page");
		expect(result.userFacingText).toContain("Hello attachment world.");
		expect(harness.modelCalls).toHaveLength(0);
		expect(harness.callbacks[0]?.text).toBe(result.userFacingText);
	});

	it("an empty model response degrades to the acknowledgement, never raw content", async () => {
		const { harness, message } = singleRecordHarness("");
		const result = await runHandler(harness, message);
		expect(result.userFacingText).toBe(
			'Read "Quarterly Report" but couldn\'t put an answer together — ask me something specific about it.',
		);
		expect(result.userFacingText).not.toContain("Hello attachment world.");
	});

	it("a bare link share caps the answer budget at 256 tokens with the short-take instruction", async () => {
		const attachment = makeAttachment({
			id: "att-link",
			title: "Some page",
			text: "Short page body.",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "https://example.com/interesting-post",
			attachments: [attachment],
		});
		await runHandler(harness, message);
		expect(harness.modelCalls).toHaveLength(1);
		expect(harness.modelCalls[0]?.payload.maxTokens).toBe(256);
		expect(String(harness.modelCalls[0]?.payload.prompt)).toContain(
			"shared a link without asking a question",
		);
	});

	it("a direct question budgets from content size without the bare-link instruction", async () => {
		const attachment = makeAttachment({
			id: "att-long",
			title: "Wide doc",
			text: "x".repeat(8000),
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "summarize the key numbers for me",
			attachments: [attachment],
		});
		await runHandler(harness, message);
		expect(harness.modelCalls).toHaveLength(1);
		expect(harness.modelCalls[0]?.payload.maxTokens).toBe(2000);
		expect(String(harness.modelCalls[0]?.payload.prompt)).not.toContain(
			"shared a link without asking a question",
		);
	});
});

describe("readAttachmentAction.handler — clipboard outcomes", () => {
	it("without a flag the clipboard stays untouched and the result is not suppressed", async () => {
		const attachment = makeAttachment({
			id: "att-clip",
			title: "Clip doc",
			text: "body",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "read it",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		const data = result.data as Record<string, unknown>;
		expect(data.clipboard).toMatchObject({ requested: false, stored: false });
		expect(data.suppressActionResultClipboard).toBe(false);
	});

	it("addToClipboard stores the item, projects it into data, and suppresses the action clipboard", async () => {
		const attachment = makeAttachment({
			id: "att-clip-add",
			title: "Clip doc",
			text: "body to stash",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "show me the attachment metadata",
			attachments: [attachment],
			content: { addToClipboard: true },
		});
		const result = await runHandler(harness, message);
		const data = result.data as Record<string, unknown>;
		const clipboard = data.clipboard as Record<string, unknown>;
		expect(clipboard.requested).toBe(true);
		expect(clipboard.stored).toBe(true);
		expect(clipboard.itemCount).toBeGreaterThan(0);
		const item = clipboard.item as Record<string, unknown>;
		expect(item.title).toBe("Clip doc");
		expect(data.suppressActionResultClipboard).toBe(true);
		expect(result.userFacingText).toContain("Added clipboard item ");
	});

	it("re-running with the same source updates the existing clipboard item", async () => {
		const attachment = makeAttachment({
			id: "att-clip-replace",
			title: "Replace doc",
			text: "same body",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "read and keep this",
			attachments: [attachment],
			content: { addToClipboard: true },
		});
		const first = await runHandler(harness, message);
		expect((first.data as Record<string, unknown>).clipboard).toMatchObject({
			requested: true,
			stored: true,
		});
		message.content.text = "show me the attachment metadata";
		const second = await runHandler(harness, message);
		const clipboard = (second.data as Record<string, unknown>)
			.clipboard as Record<string, unknown>;
		expect(clipboard.stored).toBe(true);
		expect(clipboard.replaced).toBe(true);
		expect(second.userFacingText).toContain("Updated clipboard item ");
	});

	it("a requested clipboard add with no readable content is skipped with a reason", async () => {
		const attachment = makeAttachment({
			id: "att-clip-empty",
			title: "Empty doc",
			text: "",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "save whatever this is",
			attachments: [attachment],
			content: { addToClipboard: true },
		});
		const result = await runHandler(harness, message);
		const data = result.data as Record<string, unknown>;
		const clipboard = data.clipboard as Record<string, unknown>;
		expect(clipboard.requested).toBe(true);
		expect(clipboard.stored).toBe(false);
		expect(String(clipboard.reason)).toContain(
			"No stored content was available",
		);
		expect(data.suppressActionResultClipboard).toBe(true);
	});
});

describe("readAttachmentAction.handler — missing readable content", () => {
	it("a single unreadable document admits there is no text yet, with no model call", async () => {
		const attachment = makeAttachment({
			id: "att-empty",
			title: "Empty",
			text: "",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "read this",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		expect(result.success).toBe(true);
		expect(result.userFacingText).toBe(
			"I don't have readable text for that attachment yet.",
		);
		expect(result.text).toBe("");
		expect(harness.modelCalls).toHaveLength(0);
		expect(harness.callbacks[0]?.text).toBe(result.userFacingText);
	});

	it("plural unreadable documents use the plural wording", async () => {
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "read both",
			attachments: [
				makeAttachment({ id: "e1", text: "" }),
				makeAttachment({ id: "e2", text: "" }),
			],
		});
		const result = await runHandler(harness, message, {
			action: "save_as_document",
		});
		expect(result.success).toBe(false);
		expect(result.userFacingText).toBe(
			"I don't have readable text for those attachments yet.",
		);
	});

	it("an undescribed image reports the description failure, not the generic text", async () => {
		const attachment = makeAttachment({
			id: "att-img",
			title: "Picture",
			contentType: ContentType.IMAGE,
			text: "",
			url: "",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "what is in this?",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		expect(result.userFacingText).toBe(
			"I couldn't generate a readable description for that image.",
		);
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("an anchored transcription-unavailable note claims disabled speech-to-text honestly", async () => {
		const attachment = makeAttachment({
			id: "att-audio",
			title: "Voice memo",
			contentType: ContentType.AUDIO,
			text: "",
			url: "",
			notProcessed: "Transcription unavailable: provider gated off",
		} as Partial<Media>);
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "transcribe this",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		expect(result.userFacingText).toBe(
			"I can't transcribe that attachment — speech-to-text isn't enabled on this deployment.",
		);
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("media without a transcript or unavailability note stays retryably pending", async () => {
		const attachment = makeAttachment({
			id: "att-video",
			title: "Clip",
			contentType: ContentType.VIDEO,
			text: "",
			url: "",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "what does it say?",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		expect(result.userFacingText).toBe(
			"I don't have a transcript for that attachment yet.",
		);
	});
});

describe("readAttachmentAction.handler — save_as_document", () => {
	function saveHarness(params?: ConstructorParameters<typeof makeHarness>[0]) {
		const attachment = makeAttachment({
			id: "att-save",
			title: "Savable Report",
			text: "Line one of the document.\nLine two follows.",
		});
		const harness = makeHarness(params);
		const worldId = uuidv4() as UUID;
		const message = makeMessage({
			harness,
			text: "save this for me",
			attachments: [attachment],
			worldId,
		});
		return { harness, message, worldId };
	}

	it("saving unreadable content fails verified without touching the document service", async () => {
		const attachment = makeAttachment({
			id: "att-save-empty",
			title: "Empty",
			text: "",
		});
		const harness = makeHarness();
		let serviceLookups = 0;
		(harness.runtime as unknown as Record<string, unknown>).getService = () => {
			serviceLookups += 1;
			return null;
		};
		const message = makeMessage({
			harness,
			text: "save it",
			attachments: [attachment],
			worldId: uuidv4() as UUID,
		});
		const result = await runHandler(harness, message, {
			action: "save_as_document",
		});
		expect(result.success).toBe(false);
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.userFacingText).toBe(
			"I don't have readable text for that attachment yet.",
		);
		expect(harness.callbacks[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_FAILED",
		]);
		expect(serviceLookups).toBe(0);
		expect(harness.addDocumentCalls).toHaveLength(0);
	});

	it("readable content without a document service fails with DOCUMENTS_SERVICE_UNAVAILABLE", async () => {
		const { harness, message } = saveHarness({ documentsService: null });
		const result = await runHandler(harness, message, {
			action: "save_as_document",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBe("DOCUMENTS_SERVICE_UNAVAILABLE");
		expect(result.userFacingText).toBe(
			"I can't save documents right now — document storage isn't available.",
		);
		expect(harness.callbacks[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_FAILED",
		]);
	});

	it("a successful save persists complete content with defaults and confirms turn-complete", async () => {
		const { harness, message, worldId } = saveHarness();
		const result = await runHandler(harness, message, {
			action: "save_as_document",
		});
		expect(result.success).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.verifiedUserFacing).toBe(true);
		const data = result.data as Record<string, unknown>;
		expect(data.documentId).toBe("doc-generated-id");
		expect(data.fragmentCount).toBe(2);
		expect(data.attachmentIds).toEqual(["att-save"]);
		const call = harness.addDocumentCalls[0] as Record<string, unknown>;
		expect(call.worldId).toBe(worldId);
		expect(call.content).toBe("Line one of the document.\nLine two follows.");
		expect(call.scope).toBe("owner-private");
		expect(call.originalFilename).toBe(
			createDocumentNoteFilename("Savable Report"),
		);
		const metadata = call.metadata as Record<string, unknown>;
		expect(metadata.fileSize).toBe(
			Buffer.byteLength("Line one of the document.\nLine two follows.", "utf8"),
		);
		expect(harness.callbacks[0]?.text).toBe(
			'Saved "Savable Report" as a document.',
		);
		expect(harness.callbacks[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_SUCCESS",
		]);
		expect(harness.modelCalls).toHaveLength(0);
	});

	it("an explicit title and valid scope are honored; an invalid scope falls back to owner-private", async () => {
		const { harness, message, worldId } = saveHarness();
		message.worldId = worldId;
		const custom = await runHandler(harness, message, {
			action: "save_as_document",
			title: "My Custom Title",
			scope: "global",
		});
		let call = harness.addDocumentCalls[0] as Record<string, unknown>;
		expect(call.originalFilename).toBe(
			createDocumentNoteFilename("My Custom Title"),
		);
		expect(call.scope).toBe("global");
		expect(custom.success).toBe(true);

		const invalid = await runHandler(harness, message, {
			action: "save_as_document",
			title: "Second Title",
			scope: "shout-it-from-rooftops",
		});
		call = harness.addDocumentCalls[1] as Record<string, unknown>;
		expect(call.scope).toBe("owner-private");
		expect(invalid.success).toBe(true);
	});

	it("a multi-attachment save stores every attachment id and the combined content", async () => {
		const first = makeAttachment({
			id: "m1",
			title: "One",
			text: "first body",
		});
		const second = makeAttachment({
			id: "m2",
			title: "Two",
			text: "second body",
		});
		const harness = makeHarness();
		const message = makeMessage({
			harness,
			text: "save both",
			attachments: [first, second],
			worldId: uuidv4() as UUID,
		});
		const result = await runHandler(harness, message, {
			action: "save_as_document",
			title: "Combined bundle",
		});
		expect(result.success).toBe(true);
		const call = harness.addDocumentCalls[0] as Record<string, unknown>;
		const metadata = call.metadata as Record<string, unknown>;
		expect(metadata.attachmentIds).toEqual(["m1", "m2"]);
		expect(String(call.content)).toContain("first body");
		expect(String(call.content)).toContain("second body");
	});

	it("worldId resolves through the message room, then the agent, and refuses a missing room", async () => {
		const roomWorldId = uuidv4() as UUID;
		const viaRoom = saveHarness({
			room: { id: "room-row", worldId: roomWorldId },
		});
		delete (viaRoom.message as Record<string, unknown>).worldId;
		const roomResult = await runHandler(viaRoom.harness, viaRoom.message, {
			action: "save_as_document",
		});
		expect(roomResult.success).toBe(true);
		expect(
			(viaRoom.harness.addDocumentCalls[0] as Record<string, unknown>).worldId,
		).toBe(roomWorldId);

		const viaAgent = saveHarness({ room: {} });
		delete (viaAgent.message as Record<string, unknown>).worldId;
		const agentResult = await runHandler(viaAgent.harness, viaAgent.message, {
			action: "save_as_document",
		});
		expect(agentResult.success).toBe(true);
		expect(
			(viaAgent.harness.addDocumentCalls[0] as Record<string, unknown>).worldId,
		).toBe(viaAgent.harness.runtime.agentId);

		const noRoom = saveHarness({ room: null });
		delete (noRoom.message as Record<string, unknown>).worldId;
		const failed = await runHandler(noRoom.harness, noRoom.message, {
			action: "save_as_document",
		});
		expect(failed.success).toBe(false);
		expect(String(failed.error)).toContain("room was not found");
		expect(noRoom.harness.reportedErrors).toHaveLength(1);
	});

	it("a failing room lookup surfaces the structured world-resolution failure", async () => {
		const broken = saveHarness({
			getRoomError: new Error("room index corrupted"),
		});
		delete (broken.message as Record<string, unknown>).worldId;
		const result = await runHandler(broken.harness, broken.message, {
			action: "save_as_document",
		});
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("world resolution failed");
		expect(broken.harness.reportedErrors).toHaveLength(1);
	});
});

describe("readAttachmentAction.handler — boundary failures", () => {
	it("a rejecting history store becomes one report, a generic callback, and a failed result", async () => {
		const harness = makeHarness();
		(harness.runtime as unknown as Record<string, unknown>).getMemories =
			async () => {
				throw new Error("history store offline");
			};
		const message = makeMessage({
			harness,
			text: "read it",
			attachments: [makeAttachment({ id: "att-x", text: "body" })],
		});
		const result = await runHandler(harness, message);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("history store offline");
		expect(harness.reportedErrors).toHaveLength(1);
		expect(harness.reportedErrors[0]?.scope).toBe(
			"ReadAttachmentAction.handler",
		);
		expect(harness.callbacks[0]?.text).toBe(
			"I couldn't read that attachment right now.",
		);
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
	});

	it("a rejecting model call is reported once and degrades to a structured failure", async () => {
		const attachment = makeAttachment({ id: "att-model-fail", text: "body" });
		const harness = makeHarness({ modelResponse: new Error("model exploded") });
		const message = makeMessage({
			harness,
			text: "answer from this",
			attachments: [attachment],
		});
		const result = await runHandler(harness, message);
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("model exploded");
		expect(harness.reportedErrors).toHaveLength(1);
		expect(harness.callbacks[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
	});
});

describe("module exports", () => {
	it("exports the same action object as default and named bindings", () => {
		expect(readAttachmentAction.name).toBe("ATTACHMENT");
		expect(readAttachmentAction.roleGate).toEqual({ minRole: "ADMIN" });
	});
});
