import { describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import { type ActionResult, type Memory, ModelType } from "../types";
import { resolvePlannedReplyEgress } from "./message";

const message: Memory = {
	id: "00000000-0000-4000-8000-000000000001",
	roomId: "00000000-0000-4000-8000-000000000002",
	entityId: "00000000-0000-4000-8000-000000000003",
	content: { text: "Make a note about the picnic." },
};

describe("model-backed final reply recovery", () => {
	it("preserves a valid model reply without another inference call", async () => {
		const runtime = createMockRuntime({ useModel: vi.fn() });
		const reply = "What would you like the note to say?";
		await expect(
			resolvePlannedReplyEgress({ runtime, message, reply, actionResults: [] }),
		).resolves.toBe(reply);
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("repairs an unproven claim using the request and complete results without replaying actions", async () => {
		const handler = vi.fn();
		const response = "The note service did not confirm a saved note.";
		const useModel = vi.fn(async () => JSON.stringify({ response }));
		const runtime = createMockRuntime({
			useModel,
			actions: [
				{
					name: "NOTES",
					description: "Notes",
					validate: async () => true,
					handler,
				},
			],
		});
		const actionResults: ActionResult[] = [
			{
				success: false,
				error: "write not confirmed",
				data: {
					actionName: "NOTES",
					details: `${"context ".repeat(1500)}tail-proof`,
				},
			},
		];
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "I've created the note.",
				actionResults,
			}),
		).resolves.toBe(response);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("Make a note about the picnic."),
			}),
		);
		expect(useModel).toHaveBeenCalledWith(
			ModelType.TEXT_SMALL,
			expect.objectContaining({
				prompt: expect.stringContaining("tail-proof"),
			}),
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("renders a missing reply from completed results while retaining exact receipt grounding", async () => {
		const response = "I've created the picnic note.";
		const runtime = createMockRuntime({
			useModel: vi.fn(async () => JSON.stringify({ response })),
		});
		const actionResults: ActionResult[] = [
			{
				success: true,
				userFacingText: response,
				verifiedUserFacing: true,
				data: { actionName: "NOTES" },
				userFacingEffectReceiptIds: ["note-proof"],
				effectReceipts: [
					{
						receiptId: "note-proof",
						operation: "notes.create",
						outcome: "applied",
						resource: { kind: "note", id: "picnic" },
						artifacts: [],
						idempotency: { key: "picnic-request", replayed: false },
						observedAt: "2026-09-04T12:00:00.000Z",
						commit: {
							kind: "durable",
							id: "note-write",
							committedAt: "2026-09-04T12:00:00.000Z",
						},
					},
				],
			},
		];
		await expect(
			resolvePlannedReplyEgress({ runtime, message, reply: "", actionResults }),
		).resolves.toBe(response);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"another ungrounded claim",
			JSON.stringify({ response: "I've created the note." }),
		],
		["empty response", JSON.stringify({ response: "" })],
		["invalid response", "not JSON"],
	])(
		"fails explicitly instead of emitting canned dialogue after %s",
		async (_label, output) => {
			const runtime = createMockRuntime({
				useModel: vi.fn(async () => output),
			});
			await expect(
				resolvePlannedReplyEgress({
					runtime,
					message,
					reply: "",
					actionResults: [],
				}),
			).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
			expect(runtime.useModel).toHaveBeenCalledTimes(1);
		},
	);

	it("reports a model outage and never substitutes a preset assistant reply", async () => {
		const reportError = vi.fn();
		const runtime = createMockRuntime({
			reportError,
			logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			useModel: vi.fn(async () => {
				throw new Error("provider unavailable");
			}),
		});
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message,
				reply: "",
				actionResults: [],
			}),
		).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
		expect(reportError).toHaveBeenCalled();
	});
});
