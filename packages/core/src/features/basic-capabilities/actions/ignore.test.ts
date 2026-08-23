/**
 * Deterministic unit tests for the IGNORE action's routing validation and
 * response-delivery behavior. The real action runs without a model or database;
 * only the transport callback is observed.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import { ignoreAction } from "./ignore.ts";

const runtime = {} as IAgentRuntime;

function createMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		agentId: "00000000-0000-0000-0000-000000000002",
		entityId: "00000000-0000-0000-0000-000000000003",
		roomId: "00000000-0000-0000-0000-000000000004",
		content: { text: "goodbye" },
	} as Memory;
}

describe("IGNORE action", () => {
	it("exposes the canonical action metadata", () => {
		expect(ignoreAction).toMatchObject({
			name: "IGNORE",
			contexts: ["general"],
			roleGate: { minRole: "USER" },
			parameters: [],
		});
		expect(ignoreAction.similes).toEqual([
			"STOP_TALKING",
			"STOP_CHATTING",
			"STOP_CONVERSATION",
		]);
	});

	it("rejects validation when the turn has no routing context", async () => {
		await expect(
			ignoreAction.validate?.(runtime, createMessage()),
		).resolves.toBe(false);
	});

	it("accepts validation when an explicit turn context activates general routing", async () => {
		const state = {
			values: {
				__contextRouting: { primaryContext: "calendar" },
			},
		} as unknown as State;

		await expect(
			ignoreAction.validate?.(runtime, createMessage(), state),
		).resolves.toBe(true);
	});

	it("delivers the first pre-composed response content", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const firstContent = { text: "", actions: ["IGNORE"], source: "discord" };

		const result = await ignoreAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			undefined,
			callback,
			[
				{ content: firstContent } as Memory,
				{ content: { text: "later response" } } as Memory,
			],
		);

		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(firstContent);
		expect(result).toEqual({
			text: "",
			values: { success: true, ignored: true },
			data: { actionName: "IGNORE" },
			success: true,
		});
	});

	it.each([
		["no response queue", undefined],
		["an empty response queue", []],
		[
			"content only after the first response",
			[{} as Memory, { content: { text: "later response" } } as Memory],
		],
	])("does not call back for %s", async (_label, responses) => {
		const callback: HandlerCallback = vi.fn(async () => []);

		const result = await ignoreAction.handler?.(
			runtime,
			createMessage(),
			undefined,
			undefined,
			callback,
			responses,
		);

		expect(callback).not.toHaveBeenCalled();
		expect(result?.values).toEqual({ success: true, ignored: true });
	});
});
