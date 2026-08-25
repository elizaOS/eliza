/**
 * TRUST record-interaction action tests for validation, input precedence, persistence, and failure translation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TrustEvidenceType } from "../types/trust.ts";
import { recordTrustInteractionHandler } from "./recordTrustInteraction.ts";

const message = {
	id: "message-id",
	entityId: "source-id",
	roomId: "room-id",
	content: { text: "" },
};

function createRuntime(recordInteraction = vi.fn(async () => undefined)) {
	return {
		agentId: "agent-id",
		getService: vi.fn(() => ({ trustEngine: { recordInteraction } })),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TRUST record interaction", () => {
	it("reports when the trust engine service is unavailable", async () => {
		const runtime = {
			agentId: "agent-id",
			getService: vi.fn(() => null),
		};

		const result = await recordTrustInteractionHandler(
			runtime as never,
			message as never,
			undefined,
			undefined,
		);

		expect(result).toEqual({
			success: false,
			text: "Trust engine service is not available.",
			error: "Trust engine service not available",
			data: { actionName: "TRUST", subaction: "record_interaction" },
		});
	});

	it.each([
		["empty content", "", undefined],
		["invalid JSON", "not json", undefined],
		["non-object parameters", "", { parameters: [] }],
	])(
		"rejects a missing interaction type from %s",
		async (_name, text, options) => {
			const recordInteraction = vi.fn(async () => undefined);
			const runtime = createRuntime(recordInteraction);

			const result = await recordTrustInteractionHandler(
				runtime as never,
				{ ...message, content: { text } } as never,
				undefined,
				options,
			);

			expect(result).toMatchObject({
				success: false,
				error: "Invalid or missing interaction type",
				data: { actionName: "TRUST", subaction: "record_interaction" },
			});
			expect(recordInteraction).not.toHaveBeenCalled();
		},
	);

	it("rejects an unknown interaction type", async () => {
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = createRuntime(recordInteraction);

		const result = await recordTrustInteractionHandler(
			runtime as never,
			message as never,
			undefined,
			{ parameters: { type: "invented_evidence" } },
		);

		expect(result).toMatchObject({
			success: false,
			error: "Invalid evidence type provided",
		});
		expect(result.text).toContain(TrustEvidenceType.PROMISE_KEPT);
		expect(result.text).toContain(TrustEvidenceType.CONTEXT_SWITCH);
		expect(recordInteraction).not.toHaveBeenCalled();
	});

	it("applies the documented impact default of 10 when impact is omitted", async () => {
		// TRUST documents impact as "Default 10." (trust.ts), but the handler cast
		// the optional value and forwarded it unchanged, so a request carrying a
		// valid type and no impact persisted `undefined` into a
		// TrustInteraction.impact that the contract and the column both type as a
		// number -- and still reported success. Reported by @attentionhead.
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = createRuntime(recordInteraction);
		vi.spyOn(Date, "now").mockReturnValue(1_234);

		const result = await recordTrustInteractionHandler(
			runtime as never,
			{
				...message,
				content: { text: '{"type":"helpful_action"}' },
			} as never,
			undefined,
			undefined,
		);

		const recorded = recordInteraction.mock.calls[0][0] as {
			impact: number;
		};
		expect(recorded.impact).toBe(10);
		expect(typeof recorded.impact).toBe("number");
		expect(result.success).toBe(true);
	});

	it("records JSON input with canonical type casing and default target and description", async () => {
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = createRuntime(recordInteraction);
		vi.spyOn(Date, "now").mockReturnValue(1_234);

		const result = await recordTrustInteractionHandler(
			runtime as never,
			{
				...message,
				content: { text: '{"type":"helpful_action","impact":4}' },
			} as never,
			undefined,
			undefined,
		);

		const expectedInteraction = {
			sourceEntityId: "source-id",
			targetEntityId: "agent-id",
			type: TrustEvidenceType.HELPFUL_ACTION,
			timestamp: 1_234,
			impact: 4,
			details: {
				description: "Trust interaction: HELPFUL_ACTION",
				messageId: "message-id",
				roomId: "room-id",
			},
			context: { evaluatorId: "agent-id", roomId: "room-id" },
		};
		expect(recordInteraction).toHaveBeenCalledWith(expectedInteraction);
		expect(result).toEqual({
			success: true,
			text: "Trust interaction recorded: HELPFUL_ACTION with impact +4",
			data: {
				actionName: "TRUST",
				subaction: "record_interaction",
				interaction: expectedInteraction,
				success: true,
			},
		});
	});

	it("lets nested parameters override JSON and prefers entityId over targetEntityId", async () => {
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = createRuntime(recordInteraction);

		const result = await recordTrustInteractionHandler(
			runtime as never,
			{
				...message,
				content: {
					text: '{"type":"PROMISE_BROKEN","entityId":"json-target","impact":-1}',
				},
			} as never,
			undefined,
			{
				parameters: {
					type: "promise_kept",
					entityId: "preferred-target",
					targetEntityId: "fallback-target",
					impact: 0,
					description: "Observed result",
				},
			},
		);

		expect(recordInteraction).toHaveBeenCalledWith(
			expect.objectContaining({
				targetEntityId: "preferred-target",
				type: TrustEvidenceType.PROMISE_KEPT,
				impact: 0,
				details: expect.objectContaining({ description: "Observed result" }),
			}),
		);
		expect(result.text).toBe(
			"Trust interaction recorded: PROMISE_KEPT with impact 0",
		);
	});

	it("uses targetEntityId when entityId is absent", async () => {
		const recordInteraction = vi.fn(async () => undefined);
		const runtime = createRuntime(recordInteraction);

		await recordTrustInteractionHandler(
			runtime as never,
			message as never,
			undefined,
			{
				parameters: {
					type: TrustEvidenceType.HARMFUL_ACTION,
					targetEntityId: "target-id",
					impact: -3,
				},
			},
		);

		expect(recordInteraction).toHaveBeenCalledWith(
			expect.objectContaining({ targetEntityId: "target-id", impact: -3 }),
		);
	});

	it.each([
		[new Error("storage unavailable"), "storage unavailable"],
		["non-error rejection", "Unknown error"],
	])("translates persistence failure %#", async (failure, expectedError) => {
		const recordInteraction = vi.fn(async () => {
			throw failure;
		});
		const runtime = createRuntime(recordInteraction);

		const result = await recordTrustInteractionHandler(
			runtime as never,
			message as never,
			undefined,
			{
				parameters: {
					type: TrustEvidenceType.VERIFIED_IDENTITY,
					impact: 2,
				},
			},
		);

		expect(result).toEqual({
			success: false,
			text: "Failed to record trust interaction. Please try again.",
			error: expectedError,
			data: { actionName: "TRUST", subaction: "record_interaction" },
		});
	});
});
