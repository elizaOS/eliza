import type { Memory, ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { recentAppFollowupEvaluator } from "./recent-app-followup.js";

const APP_RECEIPT =
	"Nubs Color Pebble is ready. [Open Nubs Color Pebble](/api/apps/local/nubs-color-pebble/)";

function context(
	text: string,
	options: { includeReceipt?: boolean; actions?: string[] } = {},
): ResponseHandlerEvaluatorContext {
	const recentMessages: Memory[] =
		options.includeReceipt === false
			? []
			: [
					{
						id: "receipt",
						entityId: "agent",
						createdAt: 2,
						content: { text: APP_RECEIPT },
					} as Memory,
				];
	return {
		runtime: {
			agentId: "agent",
			actions: (options.actions ?? ["APP", "BACKGROUND", "VIEWS"]).map(
				(name) => ({ name }),
			),
		},
		message: {
			id: "current",
			entityId: "user",
			content: { text },
		} as Memory,
		state: {
			data: {
				providers: {
					RECENT_MESSAGES: { data: { recentMessages } },
				},
			},
		},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["general"],
				reply: "On it.",
				simple: false,
				requiresTool: true,
				candidateActions: ["BACKGROUND"],
			},
		},
		availableContexts: [],
	} as unknown as ResponseHandlerEvaluatorContext;
}

describe("recent app follow-up routing", () => {
	it.each([
		"can u mKE THE BACKGROUND BLACK",
		"make it blue",
		"change the button to purple",
	])("routes visual edit %j to the recent app", async (text) => {
		const ctx = context(text);
		expect(await recentAppFollowupEvaluator.shouldRun(ctx)).toBe(true);
		expect(await recentAppFollowupEvaluator.evaluate(ctx)).toMatchObject({
			clearCandidateActions: true,
			addCandidateActions: ["APP"],
			deterministicToolCall: {
				name: "APP",
				params: {
					action: "create",
					editTarget: "nubs-color-pebble",
					intent: text,
				},
			},
		});
	});

	it("resolves a bare open request to the recent app", async () => {
		const ctx = context("open the app");
		expect(await recentAppFollowupEvaluator.evaluate(ctx)).toMatchObject({
			deterministicToolCall: {
				name: "APP",
				params: {
					action: "launch",
					app: "nubs-color-pebble",
				},
			},
		});
	});

	it.each([
		"make the home background black",
		"change Eliza's background to blue",
		"set the wallpaper to purple",
		"go home",
	])("does not hijack explicit shell request %j", async (text) => {
		expect(await recentAppFollowupEvaluator.shouldRun(context(text))).toBe(
			false,
		);
	});

	it("does not infer an app without a verified recent local-app receipt", async () => {
		expect(
			await recentAppFollowupEvaluator.shouldRun(
				context("make it blue", { includeReceipt: false }),
			),
		).toBe(false);
	});

	it("does not route when APP is unavailable", async () => {
		expect(
			await recentAppFollowupEvaluator.shouldRun(
				context("open the app", { actions: ["VIEWS"] }),
			),
		).toBe(false);
	});
});
