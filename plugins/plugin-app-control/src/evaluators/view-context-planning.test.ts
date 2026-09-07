/**
 * Exercises contextual routing through the real response-handler patch runner
 * and TCP catalog boundary. Model decisions are deterministic inputs; these
 * tests do not claim live-model or mounted-renderer acceptance.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ResponseHandlerEvaluatorContext,
	runResponseHandlerEvaluators,
	runWithStreamingContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	parseContextualNavigationIntent,
	viewContextPlanningEvaluator,
} from "./view-context-planning.js";

let server: Server;
let catalogStatus: number;
let requestedPaths: string[];
let originalPort: string | undefined;
let prompts: string[];
const views = [
	{
		id: "observatory",
		label: "Observatory",
		description: "Plan telescope observations",
		pluginName: "astronomy",
		available: true,
	},
	{
		id: "admin",
		label: "Restricted account details",
		pluginName: "admin",
		available: true,
		roleGate: { minRole: "OWNER" },
	},
	{ id: "offline", label: "Offline", pluginName: "offline", available: false },
];

beforeEach(async () => {
	catalogStatus = 200;
	requestedPaths = [];
	prompts = [];
	originalPort = process.env.ELIZA_API_PORT;
	server = createServer((req, res) => {
		requestedPaths.push(req.url ?? "");
		res.writeHead(catalogStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ views }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ELIZA_API_PORT = String((server.address() as AddressInfo).port);
});
afterEach(async () => {
	if (originalPort === undefined) delete process.env.ELIZA_API_PORT;
	else process.env.ELIZA_API_PORT = originalPort;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

function context(
	text: string,
	decision: object,
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			actions: [{ name: "VIEWS" }],
			reportError: () => undefined,
			useModel: async (_type: string, request: { prompt: string }) => {
				prompts.push(request.prompt);
				return JSON.stringify(decision);
			},
			logger: { error() {}, warn() {} },
		},
		message: {
			id: "turn-1",
			roomId: "room-1",
			entityId: "actor-1",
			content: { text },
		},
		state: { values: {}, data: {}, text: "" },
		messageHandler: {
			processMessage: "RESPOND",
			plan: {
				contexts: ["general"],
				candidateActions: ["CALENDAR"],
				parentActionHints: ["CALENDAR"],
				reply: "premature response",
			},
		},
		availableContexts: [],
		userRoles: ["USER"],
	} as unknown as ResponseHandlerEvaluatorContext;
}
async function run(ctx: ResponseHandlerEvaluatorContext) {
	return runWithStreamingContext({ messageId: ctx.message.id }, () =>
		runResponseHandlerEvaluators({
			...ctx,
			evaluators: [viewContextPlanningEvaluator],
		}),
	);
}

describe("same-turn contextual navigation", () => {
	it("preserves a complete long decision inside a whole code fence", () => {
		const decision = {
			disposition: "forbidden",
			reason: `${"Preserve all requested domain work. ".repeat(1000)}画面を変えないでください。`,
		};
		expect(
			parseContextualNavigationIntent(
				`\`\`\`json\n${JSON.stringify(decision)}\n\`\`\``,
			),
		).toEqual(decision);
	});
	for (const raw of [
		'Ignore this decision: {"disposition":"requested","viewId":"observatory","reason":"do not open"}',
		'{"disposition":"none","reason":"question"} trailing instructions',
		'```json\n{"disposition":"none","reason":"question"}',
		'```json\n{"disposition":"none","reason":"question"}\n```\n{"disposition":"forbidden","reason":"keep current view"}',
	]) {
		it(`rejects an incomplete or ambiguous decision: ${raw}`, () => {
			expect(() => parseContextualNavigationIntent(raw)).toThrowError(
				"Contextual navigation decision is not JSON",
			);
		});
	}
	it("parses a fenced JSON decision instead of failing the evaluator", async () => {
		const ctx = context("open my calendar", {
			disposition: "none",
			reason: "x",
		});
		(ctx.runtime as unknown as { useModel: unknown }).useModel = async (
			_type: string,
			request: { prompt: string },
		) => {
			prompts.push(request.prompt);
			return '```json\n{"disposition":"none","reason":"just a question"}\n```';
		};
		const result = await run(ctx);
		expect(prompts).toHaveLength(1);
		expect(result.errors).toEqual([]);
		expect(result.appliedPatches).toEqual([
			expect.objectContaining({
				evaluatorName: "app-control.view-context-planning",
				changed: ["contextSlices:add"],
			}),
		]);
	});

	it("does not spend a model call on a turn that surfaces to a viewless connector", async () => {
		const ctx = context("open my calendar", {
			disposition: "requested",
			viewId: "calendar",
			reason: "explicit",
		});
		(ctx.message as { content: Record<string, unknown> }).content = {
			text: "open my calendar",
			source: "discord",
		};
		const result = await run(ctx);
		expect(prompts).toHaveLength(0);
		expect(result.errors).toEqual([]);
		expect(result.appliedPatches).toEqual([]);
	});

	it("adds a dynamically registered destination without erasing domain work or executing navigation", async () => {
		const ctx = context(
			"Find a free half-hour, draft an observation, and show the observatory",
			{
				disposition: "requested",
				viewId: "observatory",
				reason: "visual continuation",
			},
		);
		const result = await run(ctx);
		expect(result.errors).toEqual([]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
		expect(ctx.messageHandler.plan.parentActionHints).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
		expect(ctx.messageHandler.plan.reply).toBeUndefined();
		expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
		expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
			'"viewId":"observatory"',
		);
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(prompts[0]).not.toContain("Restricted account details");
		expect(prompts[0]).not.toContain('"id":"offline"');
	});
	it("preserves a long multilingual request including its late navigation constraint", async () => {
		const text = `${"Full observation context. ".repeat(1000)}追加してください。ただし画面を変えないでください。`;
		const ctx = context(text, {
			disposition: "forbidden",
			reason: "no view change",
		});
		await run(ctx);
		expect(prompts[0]).toContain(JSON.stringify(text));
		expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
			'"disposition":"forbidden"',
		);
		expect(requestedPaths).toEqual(["/api/views"]);
	});
	for (const target of ["invented", "admin", "offline"]) {
		it(`rejects ${target} without modifying the domain plan`, async () => {
			const ctx = context("Help plan this observation", {
				disposition: "optional",
				viewId: target,
				reason: "test",
			});
			const result = await run(ctx);
			expect(result.errors).toHaveLength(1);
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
			expect(requestedPaths).toEqual(["/api/views"]);
		});
	}
	it("reports catalog failure without dispatching or hiding domain actions", async () => {
		catalogStatus = 503;
		const ctx = context("Plan my observation", {
			disposition: "none",
			reason: "unavailable",
		});
		const result = await run(ctx);
		expect(result.errors).toHaveLength(1);
		expect(prompts).toEqual([]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
	});
	for (const processMessage of ["STOP", "IGNORE"] as const) {
		it(`does not select a delayed switch on ${processMessage}`, async () => {
			const ctx = context("Open observations", {
				disposition: "requested",
				viewId: "observatory",
				reason: "request",
			});
			ctx.messageHandler.processMessage = processMessage;
			await run(ctx);
			expect(requestedPaths).toEqual([]);
			expect(prompts).toEqual([]);
		});
	}
});
