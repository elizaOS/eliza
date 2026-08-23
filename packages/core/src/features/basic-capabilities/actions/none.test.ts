/**
 * Deterministic unit tests for the NONE action's routing validation and no-op
 * result. The real action runs without model, database, or transport mocks.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { noneAction } from "./none.ts";

const runtime = {} as IAgentRuntime;

function createMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		agentId: "00000000-0000-0000-0000-000000000002",
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: "00000000-0000-0000-0000-000000000004",
		content: { text: "continue" },
	} as Memory;
}

describe("NONE action", () => {
	it("exposes the canonical action metadata", () => {
		expect(noneAction).toMatchObject({
			name: "NONE",
			contexts: ["general"],
			roleGate: { minRole: "USER" },
			parameters: [],
		});
		expect(noneAction.description).toBeTruthy();
		expect(noneAction.examples).toBeInstanceOf(Array);
	});

	it("rejects validation when the turn has no routing context", async () => {
		await expect(noneAction.validate?.(runtime, createMessage())).resolves.toBe(
			false,
		);
	});

	it("accepts validation when an explicit turn context activates general routing", async () => {
		const state = {
			values: {
				__contextRouting: { primaryContext: "general" },
			},
		} as unknown as State;

		await expect(
			noneAction.validate?.(runtime, createMessage(), state),
		).resolves.toBe(true);
	});

	it("returns the successful no-op result without side effects", async () => {
		const result = await noneAction.handler?.(runtime, createMessage());

		expect(result).toEqual({
			text: "",
			values: {
				success: true,
				actionType: "NONE",
			},
			data: {
				actionName: "NONE",
				description: "Response without additional action",
			},
			success: true,
		});
	});
});
