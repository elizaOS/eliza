/**
 * Tests the DOCUMENT action's pin/unpin subactions — structured routing to
 * DocumentService.setDocumentPinned, invalid-id refusal, typed-error
 * translation (forbidden/not_found → structured refusals, transport faults
 * still propagate), and the single-delivery user-facing confirmation.
 * Deterministic: runtime, DocumentService, and callback are vi.fn stubs.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaError } from "../../../errors";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../types";
import { documentAction } from "../actions";
import { DocumentService } from "../service";

const AGENT_ID = "00000000-0000-0000-0000-00000000a9e7" as UUID;
const USER_ID = "00000000-0000-0000-0000-00000000c0de" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-00000000d00d" as UUID;
const DOC_ID = "11111111-2222-3333-4444-555555555555" as UUID;

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000aa" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "pin the launch notes" },
		createdAt: Date.now(),
	} as Memory;
}

function makeService() {
	return {
		setDocumentPinned: vi.fn(async () => undefined),
	} as unknown as DocumentService;
}

function makeRuntime(service: DocumentService) {
	const categories = new Map<string, unknown>();
	const runtime = {
		agentId: AGENT_ID,
		getService: vi.fn(<T>(type: string): T | null =>
			type === DocumentService.serviceType ? (service as unknown as T) : null,
		),
		registerSearchCategory: vi.fn((reg: { category: string }) => {
			categories.set(reg.category, reg);
		}),
		getSearchCategory: vi.fn((category: string) => categories.get(category)),
		getSetting: vi.fn(() => undefined),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
	return { runtime };
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

function callback() {
	return vi.fn(async () => []);
}

describe("documentAction.handler pin/unpin routing", () => {
	it("routes pin to setDocumentPinned(true) and confirms once", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		const cb = callback();
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "pin", documentId: DOC_ID }),
			cb,
		);
		expect(service.setDocumentPinned).toHaveBeenCalledWith(
			DOC_ID,
			true,
			expect.anything(),
		);
		expect(res?.success).toBe(true);
		expect(res?.data).toMatchObject({ subaction: "pin" });
		expect(res?.values).toMatchObject({
			documentId: DOC_ID,
			pinned: true,
		});
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("routes unpin to setDocumentPinned(false)", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		const cb = callback();
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "unpin", documentId: DOC_ID }),
			cb,
		);
		expect(service.setDocumentPinned).toHaveBeenCalledWith(
			DOC_ID,
			false,
			expect.anything(),
		);
		expect(res?.success).toBe(true);
		expect(res?.data).toMatchObject({ subaction: "unpin" });
		expect(res?.values).toMatchObject({ documentId: DOC_ID, pinned: false });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("refuses without calling the service when no id is supplied", async () => {
		const service = makeService();
		const { runtime } = makeRuntime(service);
		const cb = callback();
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "pin" }),
			cb,
		);
		expect(service.setDocumentPinned).not.toHaveBeenCalled();
		expect(res?.success).toBe(false);
		expect(res?.data).toMatchObject({ subaction: "pin" });
		expect(res?.values).toMatchObject({ error: "invalid_id" });
	});

	it("translates DOCUMENT_MUTATION_FORBIDDEN into a structured refusal", async () => {
		const service = makeService();
		service.setDocumentPinned = vi.fn(async () => {
			throw new ElizaError("Requester cannot mutate this document", {
				code: "DOCUMENT_MUTATION_FORBIDDEN",
			});
		});
		const { runtime } = makeRuntime(service);
		const cb = callback();
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "pin", documentId: DOC_ID }),
			cb,
		);
		expect(res?.success).toBe(false);
		expect(res?.data).toMatchObject({ subaction: "pin" });
		expect(res?.values).toMatchObject({
			error: "forbidden",
			documentId: DOC_ID,
		});
		expect(cb).not.toHaveBeenCalled();
	});

	it("translates DOCUMENT_NOT_FOUND into a structured refusal", async () => {
		const service = makeService();
		service.setDocumentPinned = vi.fn(async () => {
			throw new ElizaError(`Document ${DOC_ID} not found`, {
				code: "DOCUMENT_NOT_FOUND",
			});
		});
		const { runtime } = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "unpin", documentId: DOC_ID }),
		);
		expect(res?.success).toBe(false);
		expect(res?.data).toMatchObject({ subaction: "unpin" });
		expect(res?.values).toMatchObject({
			error: "not_found",
			documentId: DOC_ID,
		});
	});

	it("surfaces unexpected typed error codes through the action boundary", async () => {
		const service = makeService();
		service.setDocumentPinned = vi.fn(async () => {
			throw new ElizaError("Adapter exploded", {
				code: "DOCUMENT_MUTATION_CONFLICT",
			});
		});
		const { runtime } = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "pin", documentId: DOC_ID }),
		);
		// The polymorphic DOCUMENT action's J1 boundary: the handler catch-all
		// translates the escaping typed error into an explicit failure result
		// carrying the code — never a fabricated success.
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({ error: "DOCUMENT_MUTATION_CONFLICT" });
	});

	it("refuses cleanly when the adapter lacks pin support", async () => {
		// Legacy adapters without updateDocumentPinned surface an explicit
		// DOCUMENT_PIN_UNSUPPORTED instead of a fabricated result.
		const service = makeService();
		service.setDocumentPinned = vi.fn(async () => {
			throw new ElizaError(
				"The configured database adapter does not support document pins",
				{ code: "DOCUMENT_PIN_UNSUPPORTED" },
			);
		});
		const { runtime } = makeRuntime(service);
		const res = await documentAction.handler?.(
			runtime,
			makeMessage(),
			undefined,
			options({ action: "pin", documentId: DOC_ID }),
		);
		expect(res?.success).toBe(false);
		expect(res?.values).toMatchObject({ error: "DOCUMENT_PIN_UNSUPPORTED" });
	});
});
