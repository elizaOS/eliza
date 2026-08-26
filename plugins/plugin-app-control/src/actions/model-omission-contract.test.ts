/**
 * Exercises the production BACKGROUND and MODEL_SWITCH schemas through the
 * real tool executor so provider omission spellings reach their intended
 * handlers without weakening ordinary enum validation.
 */

import {
	type Action,
	executePlannedToolCall,
	type IAgentRuntime,
	type Memory,
	type Task,
	type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundAction } from "./background.ts";
import { createModelSwitchAction } from "./model-switch.ts";

function message(text: string): Memory {
	return {
		id: "message-id" as UUID,
		entityId: "owner-id" as UUID,
		roomId: "room-id" as UUID,
		content: { text },
	} as Memory;
}

function runtimeFor(action: Action): IAgentRuntime {
	const tasks: Task[] = [];
	return {
		actions: [action],
		agentId: "agent-id" as UUID,
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => undefined),
		getTasks: vi.fn(async () => tasks),
		createTask: vi.fn(async (task: Task) => {
			tasks.push({ ...task, id: "task-id" as UUID });
			return "task-id" as UUID;
		}),
		deleteTask: vi.fn(async () => undefined),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

const ownerContext = {
	activeContexts: ["general"],
	userRoles: ["OWNER"],
} as const;

describe("production model omission contracts", () => {
	it("omits BACKGROUND's empty preset before the production schema validates", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = { ...createBackgroundAction(), handler };
		const result = await executePlannedToolCall(
			runtimeFor(action),
			{ message: message("make the background teal"), ...ownerContext },
			{
				name: "BACKGROUND",
				params: { op: "set", color: "teal", preset: "" },
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { op: "set", color: "teal" },
			}),
			undefined,
			undefined,
		);
	});

	it.each(["", "null", "undefined"])(
		"routes MODEL_SWITCH target sentinel %j into its clarification handler",
		async (sentinel) => {
			const switchModel = vi.fn(async () => ({ ok: true as const }));
			const productionAction = createModelSwitchAction({ switchModel });
			const handler = vi.fn(productionAction.handler);
			const action = { ...productionAction, handler };
			const runtime = runtimeFor(action);

			const result = await executePlannedToolCall(
				runtime,
				{ message: message("switch to the faster model"), ...ownerContext },
				{ name: "MODEL_SWITCH", params: { target: sentinel } },
			);

			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({ awaitingTarget: true });
			expect(handler).toHaveBeenCalledWith(
				expect.any(Object),
				expect.any(Object),
				undefined,
				expect.objectContaining({ parameters: {} }),
				undefined,
				undefined,
			);
			expect(runtime.createTask).toHaveBeenCalledTimes(1);
			expect(switchModel).not.toHaveBeenCalled();
		},
	);
});
