/**
 * Exercises contextual routing through the real response-handler patch runner
 * and TCP catalog boundary. Model decisions are deterministic inputs; these
 * tests do not claim live-model or mounted-renderer acceptance.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type ResponseHandlerEvaluatorContext,
	ResponseHandlerFieldRegistry,
	runResponseHandlerEvaluators,
	runWithStreamingContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { navigationDispatchBlock } from "../actions/navigation-execution.js";
import type { ViewSummary } from "../actions/views-client.js";
import {
	parseContextualNavigationIntent,
	viewContextPlanningEvaluator,
	viewContinuationField,
} from "./view-context-planning.js";

let server: Server;
let catalogStatus: number;
let requestedPaths: string[];
let originalPort: string | undefined;
let prompts: string[];
let extraViews: ViewSummary[];
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
	extraViews = [];
	originalPort = process.env.ELIZA_API_PORT;
	server = createServer((req, res) => {
		requestedPaths.push(req.url ?? "");
		res.writeHead(catalogStatus, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ views: [...views, ...extraViews] }));
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
	onModel?: () => void,
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			actions: [{ name: "VIEWS" }],
			reportError: () => undefined,
			useModel: async (_type: string, request: { prompt: string }) => {
				onModel?.();
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
	return runWithStreamingContext({ messageId: ctx.message.id }, async () => {
		const result = await runResponseHandlerEvaluators({
			...ctx,
			evaluators: [viewContextPlanningEvaluator],
		});
		return {
			...result,
			navigationBlock: navigationDispatchBlock(ctx.message, true),
		};
	});
}

describe("same-turn contextual navigation", () => {
	async function runWithField(
		ctx: ResponseHandlerEvaluatorContext,
		value: unknown,
		change?: () => void,
	) {
		return runWithStreamingContext({ messageId: ctx.message.id }, async () => {
			const registry = new ResponseHandlerFieldRegistry();
			registry.register(viewContinuationField);
			await registry.dispatch({
				rawParsed: { visualContinuation: value },
				runtime: ctx.runtime,
				message: ctx.message,
				state: ctx.state,
				senderRole: "USER",
				turnSignal: new AbortController().signal,
			});
			change?.();
			const result = await runResponseHandlerEvaluators({
				...ctx,
				evaluators: [viewContextPlanningEvaluator],
			});
			return {
				...result,
				navigationBlock: navigationDispatchBlock(ctx.message, true),
			};
		});
	}
	it.each([
		{ disposition: "none", viewId: "" },
		{ disposition: "forbidden", viewId: "" },
		{ disposition: "forbidden", viewId: "calendar" },
	])(
		"reuses the Stage-1 $disposition decision with viewId=$viewId without another model or catalog request",
		async ({ disposition, viewId }) => {
			const ctx = context(
				"Keep the current screen and answer our hypothetical",
				{
					disposition: "requested",
					viewId: "observatory",
					reason: "must not run",
				},
			);
			const result = await runWithField(ctx, {
				disposition,
				viewId,
				reason: "no navigation",
			});
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts).toHaveLength(0);
			expect(requestedPaths).toEqual([]);
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		},
	);
	it("validates a Stage-1 requested destination against the live role-filtered catalog without repeating inference", async () => {
		const ctx = context("Show the observatory and draft the event", {
			disposition: "none",
			reason: "must not run",
		});
		const result = await runWithField(ctx, {
			disposition: "requested",
			viewId: "observatory",
			reason: "explicit",
		});
		expect(result.errors).toEqual([]);
		expect(result.navigationBlock).toBeUndefined();
		expect(prompts).toHaveLength(0);
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
	});
	it.each(["home", "Home", "chat"])(
		"reuses a model-selected %s target through the canonical catalog alias without another call",
		async (viewId) => {
			extraViews = [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: true,
				},
			];
			const text = "Go Home without changing any notes or calendar events";
			const ctx = context(text, {
				disposition: "none",
				reason: "must not run",
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId,
				reason: "explicit navigation",
			});
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
			expect(prompts).toHaveLength(0);
			expect(requestedPaths).toEqual(["/api/views"]);
			expect(ctx.message.content.text).toBe(text);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"CALENDAR",
				"VIEWS",
			]);
			expect(ctx.messageHandler.plan.contextSlices?.join("\n")).toContain(
				'"viewId":"chat"',
			);
		},
	);
	it.each<{ catalog: ViewSummary[] }>([
		{ catalog: [] },
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: false,
				},
			],
		},
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: true,
					roleGate: { minRole: "OWNER" },
				},
			],
		},
		{
			catalog: [
				{
					id: "chat",
					label: "Messages",
					pluginName: "builtin",
					available: true,
					developerOnly: true,
				},
			],
		},
	])(
		"keeps inference and denial when an alias target is not authorized: %j",
		async ({ catalog }) => {
			extraViews = catalog;
			const ctx = context("Go Home", {
				disposition: "none",
				reason: "unavailable",
			});
			const result = await runWithField(ctx, {
				disposition: "requested",
				viewId: "home",
				reason: "requested",
			});
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(result.navigationBlock).toBe("forbidden");
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
		},
	);
	it.each([
		undefined,
		{ disposition: "unresolved", viewId: "", reason: "uncertain" },
		{ disposition: "requested", viewId: "admin", reason: "restricted" },
		{ disposition: "requested", viewId: "offline", reason: "unavailable" },
		{ disposition: "none", viewId: "observatory", reason: "conflicting" },
	])(
		"retains the classifier for invalid, unresolved or unauthorized field decisions: %j",
		async (value) => {
			const ctx = context("Help me with this view", {
				disposition: "none",
				reason: "unavailable",
			});
			const result = await runWithField(ctx, value);
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(prompts[0]).not.toContain("Restricted account details");
			expect(result.navigationBlock).toBe("forbidden");
		},
	);
	it.each(["text", "actor", "room", "id", "runtime", "role"])(
		"rejects a Stage-1 decision after its %s binding changes",
		async (binding) => {
			const ctx = context("Show the observatory", {
				disposition: "forbidden",
				reason: "fresh decision",
			});
			const result = await runWithField(
				ctx,
				{ disposition: "requested", viewId: "observatory", reason: "old" },
				() => {
					if (binding === "text") ctx.message.content.text = "Stay here";
					if (binding === "actor")
						ctx.message.entityId = "actor-2" as typeof ctx.message.entityId;
					if (binding === "room")
						ctx.message.roomId = "room-2" as typeof ctx.message.roomId;
					if (binding === "id")
						ctx.message.id = "turn-2" as typeof ctx.message.id;
					if (binding === "runtime") ctx.runtime = { ...ctx.runtime };
					if (binding === "role") ctx.userRoles = ["OWNER"];
				},
			);
			expect(result.errors).toEqual([]);
			expect(prompts).toHaveLength(1);
			expect(result.navigationBlock).toBe("forbidden");
		},
	);

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
		const handoff = ctx.messageHandler.plan.contextSlices?.join("\n") ?? "";
		expect(handoff).toContain("Selected authorized destination:");
		expect(handoff).toContain("VIEWS action=list or action=search");
		expect(handoff).not.toContain("Authorized live catalog:");
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(prompts[0]).not.toContain("Restricted account details");
		expect(prompts[0]).not.toContain('"id":"offline"');
	});
	it.each([
		"Open only the Observatory. Do not open other views or create, edit, or delete any records.",
		"Put the Observatory and Notes side by side horizontally. Only these two views; do not change any notes or other data.",
	])(
		"carries a scoped requested destination into the planner: %s",
		async (text) => {
			const ctx = context(
				text,
				{
					disposition: "requested",
					viewId: "observatory",
					reason: "requested destination within the permitted scope",
				},
				() => {
					expect(navigationDispatchBlock(ctx.message, true)).toBe("forbidden");
				},
			);
			const result = await run(ctx);
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBeUndefined();
			expect(prompts[0]).toContain(JSON.stringify(text));
			expect(ctx.message.content.text).toBe(text);
			expect(ctx.messageHandler.plan.candidateActions).toEqual([
				"CALENDAR",
				"VIEWS",
			]);
			expect(ctx.messageHandler.plan.deterministicToolCall).toBeUndefined();
			expect(requestedPaths).toEqual(["/api/views"]);
		},
	);
	it.each([
		"Describe an Observatory and Notes layout, but stay on the current screen and do not navigate.",
		"Do not open the Observatory. Explain it here instead.",
	])(
		"keeps a forbidden model decision fail closed at dispatch: %s",
		async (text) => {
			const ctx = context(text, {
				disposition: "forbidden",
				reason: "requested navigation is prohibited",
			});
			const result = await run(ctx);
			expect(result.errors).toEqual([]);
			expect(result.navigationBlock).toBe("forbidden");
			expect(prompts[0]).toContain(JSON.stringify(text));
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
			expect(requestedPaths).toEqual(["/api/views"]);
		},
	);
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
			expect(result.navigationBlock).toBe("forbidden");
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
