/** Verifies that attachment parameters stay separate from execution-only handler capabilities. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types/index.ts";

const capturedMessages = vi.hoisted(() => [] as Memory[]);

vi.mock("./attachmentContext.ts", () => ({
	listConversationAttachments: vi.fn(async () => []),
	readAttachmentRecords: vi.fn(async (_runtime, message: Memory) => {
		capturedMessages.push(message);
		return [];
	}),
	summarizeAttachment: vi.fn(() => ""),
}));

const { readAttachmentAction } = await import("./readAttachmentAction.ts");

describe("ATTACHMENT handler option isolation", () => {
	beforeEach(() => {
		capturedMessages.length = 0;
	});

	it("never copies the room lease or abort signal into transient Memory.content", async () => {
		const executionMarker = "execution-capability-must-not-enter-content";
		const roomHandlerLease = {
			release: vi.fn(async () => {}),
			marker: executionMarker,
		};
		const abortSignal = new AbortController().signal;
		const message = {
			id: "00000000-0000-0000-0000-000000000101" as UUID,
			entityId: "00000000-0000-0000-0000-000000000102" as UUID,
			roomId: "00000000-0000-0000-0000-000000000103" as UUID,
			content: { text: "read the attachment", source: "test" },
		} as Memory;
		const options = {
			abortSignal,
			roomHandlerLease,
			parameters: {
				action: "read",
				attachmentId: "attachment-1",
				addToClipboard: false,
				abortSignal,
				roomHandlerLease,
			},
		} as HandlerOptions & { abortSignal: AbortSignal };

		const result = await readAttachmentAction.handler?.(
			{ reportError: vi.fn() } as unknown as IAgentRuntime,
			message,
			undefined,
			options,
		);

		expect(result?.success).toBe(true);
		expect(capturedMessages).toHaveLength(1);
		expect(capturedMessages[0]?.content).toMatchObject({
			text: "read the attachment",
			source: "test",
			action: "read",
			attachmentId: "attachment-1",
			addToClipboard: false,
		});
		for (const controlField of [
			"abortSignal",
			"parameters",
			"roomHandlerLease",
		]) {
			expect(
				Object.hasOwn(capturedMessages[0]?.content ?? {}, controlField),
			).toBe(false);
		}
		expect(JSON.stringify(capturedMessages[0]?.content)).not.toContain(
			executionMarker,
		);
	});
});
