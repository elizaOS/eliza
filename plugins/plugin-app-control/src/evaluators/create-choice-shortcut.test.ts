/**
 * Tests deterministic routing for pending create [CHOICE] replies.
 */

import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	APP_CREATE_INTENT_TAG,
	type IntentTaskMetadata,
} from "../actions/app-create.js";
import { VIEWS_CREATE_INTENT_TAG } from "../actions/views-create.js";
import { createChoiceShortcutEvaluator } from "./create-choice-shortcut.js";

function message(text: string, roomId = "room-1") {
	return { id: "m1", roomId, content: { text } };
}

function context(
	text: string,
	tasks: Array<{
		id: string;
		tags: string[];
		metadata: Record<string, unknown>;
	}>,
	actions = [{ name: "APP" }, { name: "VIEWS" }],
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			agentId: "agent-1",
			actions,
			getTasks: vi.fn(async ({ tags }: { tags?: string[] }) =>
				tasks.filter((task) => tags?.every((tag) => task.tags.includes(tag))),
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

describe("createChoiceShortcutEvaluator", () => {
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
