/**
 * Tests deterministic routing for persisted app-control choices.
 */

import type {
	IAgentRuntime,
	Memory,
	ResponseHandlerEvaluatorContext,
	Task,
	UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	APP_CREATE_INTENT_TAG,
	type IntentTaskMetadata,
} from "../actions/app-create.js";
import {
	createModelSwitchAction,
	MODEL_SWITCH_TARGET_CHOICE_TAG,
} from "../actions/model-switch.js";
import { VIEWS_CREATE_INTENT_TAG } from "../actions/views-create.js";
import { createChoiceShortcutEvaluator } from "./create-choice-shortcut.js";

function message(text: string, roomId = "room-1") {
	return { id: "m1", roomId, content: { text } };
}

function context(
	text: string,
	tasks: Array<{
		id: string;
		roomId?: string;
		tags: string[];
		metadata: Record<string, unknown>;
	}>,
	actions = [{ name: "APP" }, { name: "MODEL_SWITCH" }, { name: "VIEWS" }],
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			agentId: "agent-1",
			actions,
			getTasks: vi.fn(
				async ({ roomId, tags }: { roomId?: string; tags?: string[] }) =>
					tasks.filter(
						(task) =>
							(!roomId ||
								task.roomId === roomId ||
								task.metadata.roomId === roomId) &&
							(!tags || tags.every((tag) => task.tags.includes(tag))),
					),
			),
		},
		message: message(text),
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "direct reply",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "Cancelled.",
			},
		},
		availableContexts: [{ id: "general" }, { id: "simple" }],
	} as unknown as ResponseHandlerEvaluatorContext;
}

function appIntent(roomId = "room-1") {
	const metadata: IntentTaskMetadata = {
		roomId,
		intent: "Create a notes app",
		choices: [{ key: "cancel", label: "Cancel" }],
		intentCreatedAt: "2026-07-06T00:00:00.000Z",
	};
	return { id: "app-intent-1", tags: [APP_CREATE_INTENT_TAG], metadata };
}

function viewsIntent(roomId = "room-1") {
	return {
		id: "views-intent-1",
		tags: [VIEWS_CREATE_INTENT_TAG],
		metadata: {
			roomId,
			intent: "Create a ledger view",
			choices: [{ key: "cancel", label: "Cancel" }],
			intentCreatedAt: "2026-07-06T00:00:00.000Z",
		},
	};
}

function modelSwitchIntent(roomId = "room-1") {
	return {
		id: "model-switch-intent-1",
		roomId,
		tags: [MODEL_SWITCH_TARGET_CHOICE_TAG, "AWAITING_CHOICE"],
		metadata: {
			choiceActionName: "MODEL_SWITCH",
			options: [
				{ name: "local", description: "Run locally" },
				{ name: "cloud", description: "Run in Eliza Cloud" },
			],
		},
	};
}

describe("createChoiceShortcutEvaluator", () => {
	it("declares only its owned deterministic actions", () => {
		expect(createChoiceShortcutEvaluator.deterministicActions).toEqual([
			"APP",
			"MODEL_SWITCH",
			"VIEWS",
		]);
	});

	it("forces a pending APP create choice reply through APP", async () => {
		const ctx = context("cancel", [appIntent()]);

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		await expect(createChoiceShortcutEvaluator.evaluate(ctx)).resolves.toEqual(
			expect.objectContaining({
				requiresTool: true,
				clearReply: true,
				clearCandidateActions: true,
				addCandidateActions: ["APP"],
				clearParentActionHints: true,
				addParentActionHints: ["APP"],
				addContexts: ["general"],
				deterministicToolCall: {
					name: "APP",
					params: { action: "create", choice: "cancel" },
				},
			}),
		);
	});

	it("forces a pending VIEWS create choice reply through VIEWS", async () => {
		const ctx = context("edit-1", [viewsIntent()]);

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		await expect(createChoiceShortcutEvaluator.evaluate(ctx)).resolves.toEqual(
			expect.objectContaining({
				addCandidateActions: ["VIEWS"],
				addParentActionHints: ["VIEWS"],
				deterministicToolCall: {
					name: "VIEWS",
					params: { action: "create", choice: "edit-1" },
				},
			}),
		);
	});

	it("routes an ambiguous model-switch request before a planner can narrate", async () => {
		const tasks: Task[] = [];
		const switchModel = vi.fn(async () => ({
			ok: true,
			target: "cloud" as const,
		}));
		const action = createModelSwitchAction({ switchModel });
		const runtime = {
			agentId: "agent-1" as UUID,
			actions: [action],
			getTasks: vi.fn(async ({ roomId, tags, agentIds }) =>
				tasks.filter(
					(task) =>
						(!roomId || task.roomId === roomId) &&
						task.agentId !== undefined &&
						agentIds.includes(task.agentId) &&
						(!tags || tags.every((tag) => task.tags?.includes(tag))),
				),
			),
			createTask: vi.fn(async (task: Task) => {
				const id = "model-switch-task" as UUID;
				tasks.push({ ...task, id });
				return id;
			}),
			deleteTask: vi.fn(async () => undefined),
		} as unknown as IAgentRuntime;
		const ctx = context("switch to the faster model", [], [action]);
		ctx.runtime = runtime;

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		const shortcut = await createChoiceShortcutEvaluator.evaluate(ctx);
		expect(shortcut?.deterministicToolCall).toEqual({
			name: "MODEL_SWITCH",
			params: {},
		});

		const result = await action.handler(
			runtime,
			ctx.message,
			ctx.state,
			shortcut?.deterministicToolCall?.params,
		);
		expect(result?.values).toMatchObject({ awaitingTarget: true });
		expect(switchModel).not.toHaveBeenCalled();
		expect(tasks).toHaveLength(1);
	});

	it("routes an explicit model-switch request with the user-authored target", async () => {
		const ctx = context("use the local model", []);

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		expect(
			(await createChoiceShortcutEvaluator.evaluate(ctx))
				?.deterministicToolCall,
		).toEqual({ name: "MODEL_SWITCH", params: { target: "local" } });
	});

	it("does not claim model questions, unrelated settings, or stopped turns", async () => {
		for (const text of [
			"what model are you using?",
			"change notification-sound-volume",
		]) {
			const ctx = context(text, []);
			expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(false);
		}
		const stopped = context("switch to the local model", []);
		stopped.messageHandler.processMessage = "STOP";
		expect(await createChoiceShortcutEvaluator.shouldRun(stopped)).toBe(false);

		const unregistered = context(
			"switch to the local model",
			[],
			[{ name: "APP" }],
		);
		expect(await createChoiceShortcutEvaluator.shouldRun(unregistered)).toBe(
			false,
		);
	});

	it("routes a persisted MODEL_SWITCH clarification through the real two-turn action flow", async () => {
		const tasks: Task[] = [];
		const switchModel = vi.fn(async () => ({
			ok: true,
			target: "cloud" as const,
		}));
		const action = createModelSwitchAction({ switchModel });
		const runtime = {
			agentId: "agent-1" as UUID,
			actions: [action],
			getTasks: vi.fn(async ({ roomId, tags, agentIds }) =>
				tasks.filter(
					(task) =>
						(!roomId || task.roomId === roomId) &&
						task.agentId !== undefined &&
						agentIds.includes(task.agentId) &&
						(!tags || tags.every((tag) => task.tags?.includes(tag))),
				),
			),
			createTask: vi.fn(async (task: Task) => {
				const id = "model-switch-task" as UUID;
				tasks.push({ ...task, id });
				return id;
			}),
			deleteTask: vi.fn(async (id: UUID) => {
				const index = tasks.findIndex((task) => task.id === id);
				if (index >= 0) tasks.splice(index, 1);
			}),
		} as unknown as IAgentRuntime;
		const first = message("switch to the faster model") as Memory;
		await action.handler(runtime, first, undefined, { target: "cloud" });
		expect(tasks).toHaveLength(1);

		const ctx = context("cloud", [], [action]);
		ctx.runtime = runtime;
		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		const patch = await createChoiceShortcutEvaluator.evaluate(ctx);
		expect(patch?.deterministicToolCall).toEqual({
			name: "MODEL_SWITCH",
			params: { target: "cloud" },
		});

		const second = message("cloud") as Memory;
		expect(await action.validate(runtime, second)).toBe(true);
		await action.handler(
			runtime,
			second,
			undefined,
			patch?.deterministicToolCall?.params,
		);
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(switchModel).toHaveBeenCalledWith({ target: "cloud" });
		expect(tasks).toHaveLength(0);
	});

	it("routes a model target only while that room has a pending choice", async () => {
		const ctx = context("local", [modelSwitchIntent()]);
		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(true);
		expect(
			(await createChoiceShortcutEvaluator.evaluate(ctx))
				?.deterministicToolCall,
		).toEqual({ name: "MODEL_SWITCH", params: { target: "local" } });

		const unrelatedRoom = context("local", [modelSwitchIntent()]);
		unrelatedRoom.message.roomId = "room-2" as UUID;
		expect(await createChoiceShortcutEvaluator.shouldRun(unrelatedRoom)).toBe(
			false,
		);
	});

	it("leaves ordinary replies alone when there is no pending choice task", async () => {
		const ctx = context("cancel", []);

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(false);
		await expect(
			createChoiceShortcutEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});

	it("does not guess when both APP and VIEWS have pending choices", async () => {
		const ctx = context("cancel", [appIntent(), viewsIntent()]);

		expect(await createChoiceShortcutEvaluator.shouldRun(ctx)).toBe(false);
		await expect(
			createChoiceShortcutEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});
});
