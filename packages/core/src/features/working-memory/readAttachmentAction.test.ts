/**
 * Behavioural coverage for the ATTACHMENT action's availability, paging, and
 * save-failure contracts that the sibling suites do not own: what the user is
 * told when no attachment matches, how a multi-page read continues under the
 * revision observed from the first page, which structured failures
 * save_as_document returns, and the validate() gate. Deterministic harness —
 * a hand-rolled runtime stub captures model calls and deliveries; no module
 * mocks and no live model.
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
import { ContentType } from "../../types/index.ts";
import type { DocumentService } from "../documents/service.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

type AddDocumentOptions = Parameters<DocumentService["addDocument"]>[0];

const FIRST_HALF = "first-half-".repeat(5);
const SECOND_HALF = "second-half-".repeat(4);
const STORED_PAGE = `${FIRST_HALF}${SECOND_HALF}`;

type ModelCall = { prompt: string };

type Delivery = {
	text?: string;
	actions?: string[];
	source?: string;
};

function makeHistoryMessage(params: {
	agentId: UUID;
	roomId: UUID;
	createdAt: number;
	attachments: Media[];
}): Memory {
	return {
		id: uuidv4() as UUID,
		agentId: params.agentId,
		entityId: uuidv4() as UUID,
		roomId: params.roomId,
		createdAt: params.createdAt,
		content: {
			text: "",
			source: "discord",
			attachments: params.attachments,
		},
	};
}

function makeRuntime(params: {
	agentId: UUID;
	memories?: Memory[];
	memoriesError?: string;
	modelResponse?: string;
	documentsService?: {
		addDocument: (options: AddDocumentOptions) => Promise<{
			clientDocumentId: UUID;
			fragmentCount: number;
		}>;
	} | null;
}) {
	const calls: ModelCall[] = [];
	const deliveries: Delivery[] = [];
	const reportedErrors: Array<{ scope: string; error: unknown }> = [];
	let memoryRequests = 0;
	const addDocumentCalls: AddDocumentOptions[] = [];
	if (params.documentsService) {
		const service = params.documentsService;
		service.addDocument = async (options: AddDocumentOptions) => {
			addDocumentCalls.push(options);
			return {
				clientDocumentId: uuidv4() as UUID,
				fragmentCount: 1,
			};
		};
	}
	const clipboardDir = mkdtempSync(path.join(tmpdir(), "attachment-behav-"));
	const runtime = {
		agentId: params.agentId,
		getConversationLength: () => 8,
		getMemories: async () => {
			memoryRequests += 1;
			if (params.memoriesError) throw new Error(params.memoriesError);
			return params.memories ?? [];
		},
		getRoom: async () => null,
		getWorld: async () => null,
		getService: (serviceId?: string) =>
			params.documentsService && serviceId === "documents"
				? params.documentsService
				: null,
		getSetting: (key: string) =>
			key === "CLIPBOARD_BASE_PATH" ? clipboardDir : undefined,
		reportError: (scope: string, error: unknown) => {
			reportedErrors.push({ scope, error });
		},
		useModel: async (_modelType: unknown, options: unknown) => {
			const { prompt } = options as { prompt: string };
			calls.push({ prompt });
			return params.modelResponse ?? "";
		},
	};
	return {
		runtime: runtime as unknown as IAgentRuntime,
		calls,
		deliveries,
		reportedErrors,
		addDocumentCalls: () => addDocumentCalls,
		memoryRequests: () => memoryRequests,
		callback: ((content: Delivery) => {
			deliveries.push(content);
			return [];
		}) as HandlerCallback,
	};
}

function makeMessage(params: {
	agentId: UUID;
	entityId?: UUID;
	text: string;
	attachments?: Media[];
	attachmentId?: string;
	worldId?: UUID;
}): Memory {
	return {
		id: uuidv4() as UUID,
		agentId: params.agentId,
		entityId: params.entityId ?? (uuidv4() as UUID),
		roomId: uuidv4() as UUID,
		worldId: params.worldId,
		createdAt: Date.now(),
		content: {
			text: params.text,
			source: "discord",
			...(params.attachmentId ? { attachmentId: params.attachmentId } : {}),
			...(params.attachments ? { attachments: params.attachments } : {}),
		},
	};
}

async function runAction(params: {
	runtime: IAgentRuntime;
	message: Memory;
	action: "read" | "save_as_document";
	handlerParams?: Record<string, unknown>;
	callback?: HandlerCallback;
}) {
	return await readAttachmentAction.handler?.(
		params.runtime,
		params.message,
		undefined,
		{ parameters: { action: params.action, ...params.handlerParams } },
		params.callback,
	);
}

describe("ATTACHMENT read availability fallbacks", () => {
	it("reports a structured unavailable failure for an attachment id that matches nothing", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			text: "read the removed attachment",
			attachmentId: "gone-attachment",
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toBe("ATTACHMENT_UNAVAILABLE_OR_UNAUTHORIZED");
		expect(result?.turnComplete).toBe(true);
		expect(result?.verifiedUserFacing).toBe(true);
		expect(result?.userFacingText).toBe(
			"That attachment is unavailable or no longer authorized.",
		);
		expect(result?.values).toMatchObject({ awaitingSelection: false });
		expect((result?.data as { error?: string })?.error).toBe(
			"unavailable_or_unauthorized",
		);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]?.text).toBe(
			"That attachment is unavailable or no longer authorized.",
		);
		expect(harness.deliveries[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
	});

	it("tells the user there are no attachments when the conversation window has none", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			text: "read whatever was attached",
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			callback: harness.callback,
		});

		expect(result?.success).toBe(true);
		expect(result?.userFacingText).toBe(
			"No attachments are available in the current conversation window.",
		);
		expect(result?.values).toMatchObject({ awaitingSelection: false });
		expect(result?.turnComplete).toBe(true);
		expect(harness.deliveries[0]?.text).toBe(
			"No attachments are available in the current conversation window.",
		);
	});

	it("offers the attachment menu when history has several but none can be auto-selected", async () => {
		const agentId = uuidv4() as UUID;
		const roomId = uuidv4() as UUID;
		const now = Date.now();
		const memories = [
			makeHistoryMessage({
				agentId,
				roomId,
				createdAt: now - 2000,
				attachments: [
					{
						id: "history-doc-a",
						title: "weekly notes",
						url: "https://example.com/weekly",
						contentType: ContentType.DOCUMENT,
						text: "Weekly summary body",
					},
				],
			}),
			makeHistoryMessage({
				agentId,
				roomId,
				createdAt: now - 1000,
				attachments: [
					{
						id: "history-doc-b",
						title: "retro deck",
						url: "https://example.com/retro",
						contentType: ContentType.DOCUMENT,
						text: "Retro deck body",
					},
				],
			}),
		];
		const harness = makeRuntime({ agentId, memories });
		const message = makeMessage({
			agentId,
			text: "Which documents did we exchange?",
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			callback: harness.callback,
		});

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({ awaitingSelection: true });
		expect(result?.turnComplete).toBe(true);
		expect(result?.text).toBe(
			"No attachment matched; showed the user the available attachments to pick from",
		);
		for (const fragment of [
			"Available attachments:",
			"ID: history-doc-a",
			"ID: history-doc-b",
		]) {
			expect(result?.userFacingText).toContain(fragment);
		}
		expect(harness.deliveries[0]?.text).toBe(result?.userFacingText);
	});
});

describe("ATTACHMENT read paging continuation contract", () => {
	function pagedHarness(agentId: UUID) {
		const attachment: Media = {
			id: "page-src",
			title: "paged notes",
			url: "https://example.com/page",
			contentType: ContentType.DOCUMENT,
			text: STORED_PAGE,
		};
		const harness = makeRuntime({
			agentId,
			modelResponse: "Answered from the requested page.",
		});
		const message = makeMessage({
			agentId,
			text: "keep reading the attached notes",
			attachments: [attachment],
		});
		return { attachment, harness, message };
	}

	it("demands a revision before serving any page past the start", async () => {
		const agentId = uuidv4() as UUID;
		const { harness, message } = pagedHarness(agentId);

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			handlerParams: { attachmentId: "page-src", offset: FIRST_HALF.length },
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toBe("ATTACHMENT_READ_EXPECTED_REVISION_REQUIRED");
		expect(result?.data).toMatchObject({
			actionName: "ATTACHMENT",
			error: "expected_revision_required",
		});
		expect(result?.promptData).toMatchObject({
			error: "expected_revision_required",
		});
		expect(harness.calls).toHaveLength(0);
		expect(harness.deliveries).toHaveLength(0);
	});

	it("continues from an observed revision and reconstructs the complete content losslessly", async () => {
		const agentId = uuidv4() as UUID;
		const { harness, message } = pagedHarness(agentId);

		const firstPage = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			handlerParams: {
				attachmentId: "page-src",
				limit: FIRST_HALF.length,
			},
			callback: harness.callback,
		});
		expect(firstPage?.success).toBe(true);
		const firstView = (
			firstPage?.data as {
				readView: {
					slice: {
						range: { start: number; end: number; total: number };
						completeness: string;
						revision: string;
					};
				};
			}
		)?.readView;
		expect(firstView?.slice.range).toEqual({
			unit: "byte",
			start: 0,
			end: FIRST_HALF.length,
			total: Buffer.byteLength(STORED_PAGE),
		});
		expect(firstView?.slice.completeness).toBe("partial-recoverable");

		const secondPage = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			handlerParams: {
				attachmentId: "page-src",
				offset: FIRST_HALF.length,
				expectedRevision: firstView?.slice.revision,
			},
			callback: harness.callback,
		});
		expect(secondPage?.success).toBe(true);
		expect(`${firstPage?.text ?? ""}${secondPage?.text ?? ""}`).toBe(
			STORED_PAGE,
		);
		const secondView = (
			secondPage?.data as {
				readView: {
					slice: {
						range: { start: number; end: number; total: number };
						completeness: string;
						revision: string;
					};
				};
			}
		)?.readView;
		expect(secondView?.slice.range).toEqual({
			unit: "byte",
			start: FIRST_HALF.length,
			end: Buffer.byteLength(STORED_PAGE),
			total: Buffer.byteLength(STORED_PAGE),
		});
		expect(secondView?.slice.completeness).toBe("complete");
		expect(secondView?.slice.revision).toBe(firstView?.slice.revision);
		// The answer model sees exactly the requested page, never the whole doc.
		expect(harness.calls.length).toBeGreaterThan(0);
		expect(harness.calls[harness.calls.length - 1]?.prompt).toContain(
			"second-half-",
		);
		expect(harness.calls[harness.calls.length - 1]?.prompt).not.toContain(
			"first-half-",
		);
	});
});

describe("ATTACHMENT save_as_document failures and payload", () => {
	it("reports the honest image message without calling any model for an undescribed image", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			entityId: agentId,
			text: "save that image as a document",
			attachments: [
				{
					id: "undescribed-image",
					title: "photo",
					contentType: ContentType.IMAGE,
				},
			],
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "save_as_document",
			handlerParams: { attachmentId: "undescribed-image" },
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.userFacingText).toBe(
			"I couldn't generate a readable description for that image.",
		);
		expect(result?.data).toMatchObject({
			actionName: "ATTACHMENT",
			action: "save_as_document",
		});
		expect(harness.deliveries[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_FAILED",
		]);
		expect(harness.calls).toHaveLength(0);
	});

	it("keeps the generic missing-text reply for a text-less document", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			entityId: agentId,
			text: "save it",
			attachments: [
				{
					id: "empty-document",
					title: "scan",
					contentType: ContentType.DOCUMENT,
				},
			],
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "save_as_document",
			handlerParams: { attachmentId: "empty-document" },
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.userFacingText).toBe(
			"I don't have readable text for that attachment yet.",
		);
	});

	it("fails with DOCUMENTS_SERVICE_UNAVAILABLE when document storage is absent", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId, documentsService: null });
		const message = makeMessage({
			agentId,
			entityId: agentId,
			text: "save this as a document",
			attachments: [
				{
					id: "storable-doc",
					title: "notes",
					contentType: ContentType.DOCUMENT,
					text: "Body worth keeping.",
				},
			],
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "save_as_document",
			handlerParams: { attachmentId: "storable-doc" },
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toBe("DOCUMENTS_SERVICE_UNAVAILABLE");
		expect(result?.userFacingText).toBe(
			"I can't save documents right now — document storage isn't available.",
		);
		expect(harness.deliveries[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_FAILED",
		]);
	});

	it("stores an explicit title with a validated scope and records attachment provenance", async () => {
		const agentId = uuidv4() as UUID;
		const worldId = uuidv4() as UUID;
		const documentsService = {
			addDocument: async () => ({
				clientDocumentId: uuidv4() as UUID,
				fragmentCount: 3,
			}),
		};
		const harness = makeRuntime({ agentId, documentsService });
		const message = makeMessage({
			agentId,
			entityId: agentId,
			text: "file these notes away",
			worldId,
			attachments: [
				{
					id: "saved-doc",
					title: "Saved notes",
					contentType: ContentType.DOCUMENT,
					text: "The complete saved body.",
				},
			],
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "save_as_document",
			handlerParams: { title: "Quarterly Notes", scope: "user-private" },
			callback: harness.callback,
		});

		expect(result?.success).toBe(true);
		expect(result?.turnComplete).toBe(true);
		const calls = harness.addDocumentCalls();
		expect(calls).toHaveLength(1);
		const stored = calls[0];
		expect(stored?.worldId).toBe(worldId);
		expect(stored?.metadata?.title).toBe("Quarterly Notes");
		expect(stored?.scope).toBe("user-private");
		expect(stored?.addedFrom).toBe("chat");
		expect(stored?.contentType).toBe("text/plain");
		expect(stored?.content).toBe("The complete saved body.");
		expect(stored?.metadata?.attachmentIds).toEqual(["saved-doc"]);
		expect(harness.deliveries[0]?.text).toBe(
			'Saved "Quarterly Notes" as a document.',
		);
		expect(harness.deliveries[0]?.actions).toEqual([
			"ATTACHMENT_SAVE_AS_DOCUMENT_SUCCESS",
		]);
	});

	it("falls back to the derived title and owner-private scope when the planner omits them", async () => {
		const agentId = uuidv4() as UUID;
		const worldId = uuidv4() as UUID;
		const documentsService = {
			addDocument: async () => ({
				clientDocumentId: uuidv4() as UUID,
				fragmentCount: 1,
			}),
		};
		const harness = makeRuntime({ agentId, documentsService });
		const message = makeMessage({
			agentId,
			entityId: agentId,
			text: "save it",
			worldId,
			attachments: [
				{
					id: "derived-doc",
					title: "Derived title",
					contentType: ContentType.DOCUMENT,
					text: "Body.",
				},
			],
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "save_as_document",
			handlerParams: {},
		});

		expect(result?.success).toBe(true);
		const stored = harness.addDocumentCalls()[0];
		expect(stored?.metadata?.title).toBe("Derived title");
		expect(stored?.scope).toBe("owner-private");
	});
});

describe("ATTACHMENT boundary behaviour", () => {
	it("translates a storage outage into the structured failure boundary", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({
			agentId,
			memoriesError: "messages store unavailable",
		});
		const message = makeMessage({
			agentId,
			text: "read anything recent",
		});

		const result = await runAction({
			runtime: harness.runtime,
			message,
			action: "read",
			callback: harness.callback,
		});

		expect(result?.success).toBe(false);
		expect(result?.text).toBe("Failed to read attachment");
		expect(result?.error).toBe("messages store unavailable");
		expect(result?.data).toMatchObject({ actionName: "ATTACHMENT" });
		expect(harness.reportedErrors).toHaveLength(1);
		expect(harness.reportedErrors[0]?.scope).toBe(
			"ReadAttachmentAction.handler",
		);
		expect(harness.reportedErrors[0]?.error).toBeInstanceOf(Error);
		expect(harness.deliveries[0]?.text).toBe(
			"I couldn't read that attachment right now.",
		);
		expect(harness.deliveries[0]?.actions).toEqual(["ATTACHMENT_READ_FAILED"]);
	});

	it("validate accepts an explicit attachment id even when history is empty", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			text: "what is in this file?",
			attachmentId: "named-attachment",
		});

		await expect(
			readAttachmentAction.validate?.(harness.runtime, message),
		).resolves.toBe(true);
	});

	it("validate rejects a conversation with nothing attachable anywhere", async () => {
		const agentId = uuidv4() as UUID;
		const harness = makeRuntime({ agentId });
		const message = makeMessage({
			agentId,
			text: "plain chatter",
		});

		await expect(
			readAttachmentAction.validate?.(harness.runtime, message),
		).resolves.toBe(false);
	});

	it("validate accepts an untargeted read when history still carries an attachment", async () => {
		const agentId = uuidv4() as UUID;
		const roomId = uuidv4() as UUID;
		const harness = makeRuntime({
			agentId,
			memories: [
				makeHistoryMessage({
					agentId,
					roomId,
					createdAt: Date.now(),
					attachments: [
						{
							id: "history-doc-c",
							title: "older upload",
							url: "https://example.com/older",
							contentType: ContentType.DOCUMENT,
							text: "Older body",
						},
					],
				}),
			],
		});
		const message = makeMessage({
			agentId,
			text: "catch me up on what I sent",
		});

		await expect(
			readAttachmentAction.validate?.(harness.runtime, message),
		).resolves.toBe(true);
	});
});
