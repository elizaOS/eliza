import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { InstalledAppInfo } from "../types.js";
import { createNamedAppLaunchEvaluator } from "./named-app-launch.js";

const APPS: InstalledAppInfo[] = [
	{
		name: "nubs-color-pebble",
		displayName: "Nubs Color Pebble",
		pluginName: "@elizaos/app-nubs-color-pebble",
	},
];

function context(
	text: string,
	actions = ["APP", "VIEWS"],
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			actions: actions.map((name) => ({ name })),
			reportError: vi.fn(),
		},
		message: { content: { text } },
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			plan: {
				contexts: ["general"],
				requiresTool: true,
				candidateActions: ["VIEWS"],
			},
		},
		availableContexts: [],
	} as unknown as ResponseHandlerEvaluatorContext;
}

describe("named installed-app launch routing", () => {
	it.each([
		"open nubs color pebble",
		"launch Nubs Color Pebble app",
		"please show me my nubs-color-pebble app",
	])("routes %j to APP launch", async (text) => {
		const list = vi.fn(async () => APPS);
		const evaluator = createNamedAppLaunchEvaluator(list);
		const ctx = context(text);
		expect(await evaluator.shouldRun(ctx)).toBe(true);
		expect(await evaluator.evaluate(ctx)).toMatchObject({
			clearCandidateActions: true,
			addCandidateActions: ["APP"],
			deterministicToolCall: {
				name: "APP",
				params: {
					action: "launch",
					app: "nubs-color-pebble",
				},
			},
		});
		expect(list).toHaveBeenCalledTimes(1);
	});

	it.each(["go home", "open Browser", "show settings", "open the app"])(
		"leaves non-installed surface %j alone",
		async (text) => {
			const evaluator = createNamedAppLaunchEvaluator(async () => APPS);
			expect(await evaluator.shouldRun(context(text))).toBe(false);
		},
	);

	it("does not route without APP", async () => {
		const list = vi.fn(async () => APPS);
		const evaluator = createNamedAppLaunchEvaluator(list);
		expect(
			await evaluator.shouldRun(context("open nubs color pebble", ["VIEWS"])),
		).toBe(false);
		expect(list).not.toHaveBeenCalled();
	});

	it("fails open to normal planning when inventory is unavailable", async () => {
		const evaluator = createNamedAppLaunchEvaluator(async () => {
			throw new Error("offline");
		});
		const ctx = context("open nubs color pebble");
		expect(await evaluator.shouldRun(ctx)).toBe(false);
		expect(ctx.runtime.reportError).toHaveBeenCalledOnce();
	});
});
