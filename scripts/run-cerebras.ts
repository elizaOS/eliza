#!/usr/bin/env bun
/**
 * `run-cerebras` — drives one v5 native-tool-calling trajectory against the
 * Cerebras `gpt-oss-120b` (or `gpt-oss-20b`) endpoint and writes the recorded
 * trajectory JSON to `./trajectories/<id>.json`.
 *
 * Spec: PLAN.md §19.2 / §19.3.
 *
 * The script is intentionally self-contained: it does NOT import
 * `runtime/trajectory-recorder.ts` (Agent B owns that file and may not have
 * built it yet). Instead, a `LocalRecorder` defined inline implements the
 * §18.1 schema. When Agent B lands, both producers can write the same shape.
 *
 * Cerebras serves an OpenAI-compatible API, so we re-use `plugin-openai`
 * with `OPENAI_BASE_URL` + `CEREBRAS_API_KEY` (the alias path G6a wired in
 * `plugins/plugin-openai/utils/config.ts`).
 *
 * Flags (PLAN.md §19.3):
 *   --message "..."         Provide message inline (default: positional arg).
 *   --scenario <name>       Load from research/native-tool-calling/scenarios/<name>.json.
 *   --no-record             Skip writing JSON.
 *   --no-tty                Plain output for logs.
 *   --stages-only           One line per stage (compact).
 *   --model <name>          Override default `gpt-oss-120b`.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { computeCallCostUsd, formatUsd } from "./lib/cost-table";

// ---------------------------------------------------------------------------
// Trajectory schema (mirrors PLAN.md §18.1)
// ---------------------------------------------------------------------------

interface UsageBreakdown {
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	totalTokens: number;
}

interface ToolCallRecord {
	id?: string;
	name?: string;
	args?: Record<string, unknown>;
}

interface ModelCallRecord {
	modelType: string;
	modelName?: string;
	provider: string;
	prompt: string;
	messages?: unknown[];
	tools?: Array<{ name?: string; description?: string }>;
	toolChoice?: unknown;
	response: string;
	toolCalls?: ToolCallRecord[];
	usage?: UsageBreakdown;
	finishReason?: string;
	costUsd?: number;
}

interface ToolStageRecord {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
}

interface EvaluationRecord {
	success: boolean;
	decision: string;
	thought?: string;
	messageToUser?: string;
	[key: string]: unknown;
}

interface RecordedStage {
	stageId: string;
	kind:
		| "messageHandler"
		| "planner"
		| "tool"
		| "evaluation"
		| "subPlanner"
		| "compaction";
	iteration?: number;
	parentStageId?: string;
	startedAt: number;
	endedAt: number;
	latencyMs: number;
	model?: ModelCallRecord;
	tool?: ToolStageRecord;
	evaluation?: EvaluationRecord;
}

interface TrajectoryMetrics {
	totalLatencyMs: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	plannerIterations: number;
	toolCallsExecuted: number;
	toolCallFailures: number;
	evaluatorFailures: number;
	finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

interface RecordedTrajectory {
	trajectoryId: string;
	agentId: string;
	roomId?: string;
	rootMessage: { id: string; text: string; sender?: string };
	startedAt: number;
	endedAt?: number;
	status: "running" | "finished" | "errored";
	stages: RecordedStage[];
	metrics: TrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// LocalRecorder — captures stage events into an in-memory trajectory and
// flushes the final JSON to disk on `end`.
// ---------------------------------------------------------------------------

class LocalRecorder {
	private trajectory: RecordedTrajectory;
	private printer: (stage: RecordedStage, idx: number) => void;

	constructor(args: {
		agentId: string;
		roomId: string;
		rootMessage: { id: string; text: string; sender?: string };
		printer: (stage: RecordedStage, idx: number) => void;
	}) {
		const id = `tj-${crypto.randomBytes(4).toString("hex")}`;
		this.printer = args.printer;
		this.trajectory = {
			trajectoryId: id,
			agentId: args.agentId,
			roomId: args.roomId,
			rootMessage: args.rootMessage,
			startedAt: Date.now(),
			status: "running",
			stages: [],
			metrics: {
				totalLatencyMs: 0,
				totalPromptTokens: 0,
				totalCompletionTokens: 0,
				totalCacheReadTokens: 0,
				totalCacheCreationTokens: 0,
				totalCostUsd: 0,
				plannerIterations: 0,
				toolCallsExecuted: 0,
				toolCallFailures: 0,
				evaluatorFailures: 0,
			},
		};
	}

	get id(): string {
		return this.trajectory.trajectoryId;
	}

	get snapshot(): RecordedTrajectory {
		return this.trajectory;
	}

	record(stage: RecordedStage): void {
		const idx = this.trajectory.stages.length;
		this.trajectory.stages.push(stage);

		const m = this.trajectory.metrics;
		m.totalLatencyMs += stage.latencyMs;
		if (stage.model?.usage) {
			m.totalPromptTokens += stage.model.usage.promptTokens ?? 0;
			m.totalCompletionTokens += stage.model.usage.completionTokens ?? 0;
			m.totalCacheReadTokens += stage.model.usage.cacheReadInputTokens ?? 0;
			m.totalCacheCreationTokens +=
				stage.model.usage.cacheCreationInputTokens ?? 0;
		}
		if (typeof stage.model?.costUsd === "number") {
			m.totalCostUsd += stage.model.costUsd;
		}
		if (stage.kind === "planner") m.plannerIterations += 1;
		if (stage.kind === "tool") {
			m.toolCallsExecuted += 1;
			if (stage.tool && !stage.tool.success) m.toolCallFailures += 1;
		}
		if (stage.kind === "evaluation" && stage.evaluation?.success === false) {
			m.evaluatorFailures += 1;
		}
		if (stage.evaluation?.decision === "FINISH") {
			m.finalDecision = "FINISH";
		} else if (
			stage.evaluation?.decision &&
			stage.evaluation.decision !== "FINISH"
		) {
			m.finalDecision = "CONTINUE";
		}

		this.printer(stage, idx);
	}

	end(status: "finished" | "errored"): RecordedTrajectory {
		this.trajectory.status = status;
		this.trajectory.endedAt = Date.now();
		if (!this.trajectory.metrics.finalDecision && status === "errored") {
			this.trajectory.metrics.finalDecision = "error";
		}
		return this.trajectory;
	}

	async flush(targetDir: string): Promise<string> {
		await fs.mkdir(targetDir, { recursive: true });
		const filePath = path.join(targetDir, `${this.trajectory.trajectoryId}.json`);
		await fs.writeFile(
			filePath,
			JSON.stringify(this.trajectory, null, 2),
			"utf8",
		);
		return filePath;
	}
}

// ---------------------------------------------------------------------------
// Pretty-printing
// ---------------------------------------------------------------------------

function ttyEnabled(noTty: boolean): boolean {
	if (noTty) return false;
	if (process.env.NO_COLOR) return false;
	return process.stdout.isTTY === true;
}

function colorize(noTty: boolean) {
	const wrap = (code: string, text: string) => {
		if (!ttyEnabled(noTty)) return text;
		return `\x1b[${code}m${text}\x1b[0m`;
	};
	return {
		dim: (t: string) => wrap("2", t),
		bold: (t: string) => wrap("1", t),
		red: (t: string) => wrap("31", t),
		green: (t: string) => wrap("32", t),
		yellow: (t: string) => wrap("33", t),
		cyan: (t: string) => wrap("36", t),
	};
}

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Cerebras client (direct fetch — keeps the script free of plugin spin-up)
// ---------------------------------------------------------------------------

const CEREBRAS_BASE_URL =
	process.env.OPENAI_BASE_URL ?? "https://api.cerebras.ai/v1";

interface CerebrasChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
	name?: string;
}

interface CerebrasToolDef {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

interface CerebrasResponse {
	choices: Array<{
		message: {
			content: string | null;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
	};
}

async function cerebrasChat(args: {
	apiKey: string;
	model: string;
	messages: CerebrasChatMessage[];
	tools?: CerebrasToolDef[];
	toolChoice?: "auto" | "required" | "none";
	responseFormat?: { type: "json_object" };
}): Promise<{
	rawResponseText: string;
	toolCalls: ToolCallRecord[];
	finishReason: string;
	usage: UsageBreakdown;
}> {
	const body: Record<string, unknown> = {
		model: args.model,
		messages: args.messages,
		stream: false,
	};
	if (args.tools && args.tools.length > 0) body.tools = args.tools;
	if (args.toolChoice) body.tool_choice = args.toolChoice;
	if (args.responseFormat) body.response_format = args.responseFormat;

	const res = await fetch(`${CEREBRAS_BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${args.apiKey}`,
		},
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(
			`Cerebras chat completion failed (${res.status}): ${errText.slice(0, 500)}`,
		);
	}

	const json = (await res.json()) as CerebrasResponse;
	const choice = json.choices?.[0];
	if (!choice) throw new Error("Cerebras response had no choices");

	const rawResponseText = choice.message.content ?? "";
	const toolCalls = (choice.message.tool_calls ?? []).map((tc) => {
		let parsedArgs: Record<string, unknown> = {};
		try {
			parsedArgs = JSON.parse(tc.function.arguments);
		} catch {
			parsedArgs = { _raw: tc.function.arguments };
		}
		return {
			id: tc.id,
			name: tc.function.name,
			args: parsedArgs,
		} satisfies ToolCallRecord;
	});

	const cached = json.usage?.prompt_tokens_details?.cached_tokens;
	const usage: UsageBreakdown = {
		promptTokens: json.usage?.prompt_tokens ?? 0,
		completionTokens: json.usage?.completion_tokens ?? 0,
		cacheReadInputTokens: typeof cached === "number" ? cached : undefined,
		totalTokens:
			json.usage?.total_tokens ??
			(json.usage?.prompt_tokens ?? 0) + (json.usage?.completion_tokens ?? 0),
	};

	return {
		rawResponseText,
		toolCalls,
		finishReason: choice.finish_reason,
		usage,
	};
}

// ---------------------------------------------------------------------------
// Mock test actions (kept inline per spec — these exist only for this script)
// ---------------------------------------------------------------------------

interface MockAction {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	handler: (args: Record<string, unknown>) => Promise<{
		success: boolean;
		text?: string;
		data?: Record<string, unknown>;
		error?: string;
	}>;
}

const MOCK_ACTIONS: MockAction[] = [
	{
		name: "WEB_SEARCH",
		description: "Search the public web for the given query and return results.",
		parameters: {
			type: "object",
			properties: { q: { type: "string", description: "Search query" } },
			required: ["q"],
		},
		handler: async (a) => ({
			success: true,
			text: `Mocked search results for "${String(a.q ?? "")}".`,
			data: {
				results: [
					{
						title: "Eliza chatbot — Wikipedia",
						url: "https://en.wikipedia.org/wiki/ELIZA",
						snippet: "ELIZA is an early natural language processing computer program.",
					},
					{
						title: "elizaOS · GitHub",
						url: "https://github.com/elizaOS",
						snippet: "Open-source agentic runtime for AI assistants.",
					},
					{
						title: "Milady — local-first AI assistant",
						url: "https://milady.ai",
						snippet: "Built on elizaOS.",
					},
				],
			},
		}),
	},
	{
		name: "CLIPBOARD_WRITE",
		description: "Save text content to a virtual in-memory clipboard.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				content: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
			},
			required: ["title", "content"],
		},
		handler: async (a) => ({
			success: true,
			text: `Saved "${String(a.title ?? "")}" to clipboard.`,
			data: { savedAt: Date.now() },
		}),
	},
	{
		name: "BROKEN_ACTION",
		description:
			"Test action that always fails. Used to exercise the evaluator's failure path.",
		parameters: {
			type: "object",
			properties: { reason: { type: "string" } },
		},
		handler: async (a) => ({
			success: false,
			error: `Intentional failure: ${String(a.reason ?? "no reason given")}`,
		}),
	},
	{
		name: "REPLY",
		description: "Reply to the user with a final message.",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		handler: async (a) => ({
			success: true,
			text: String(a.text ?? ""),
		}),
	},
	{
		name: "IGNORE",
		description: "Ignore the user's message and produce no response.",
		parameters: { type: "object", properties: {} },
		handler: async () => ({ success: true }),
	},
];

function actionByName(name: string): MockAction | undefined {
	return MOCK_ACTIONS.find((a) => a.name === name);
}

function toolDefsForCerebras(): CerebrasToolDef[] {
	return MOCK_ACTIONS.map((a) => ({
		type: "function",
		function: {
			name: a.name,
			description: a.description,
			parameters: a.parameters,
		},
	}));
}

// ---------------------------------------------------------------------------
// Stage runners — minimal v5-shaped pipeline. We avoid importing the
// in-tree planner-loop because Agent B has not finished wiring native
// tool-call passthrough (G3) yet. Once that lands, this script can be
// updated to call `runV5MessageRuntimeStage1` directly.
// ---------------------------------------------------------------------------

interface RunOptions {
	apiKey: string;
	model: string;
	systemPrompt: string;
	userMessage: string;
	noTty: boolean;
	stagesOnly: boolean;
	record: boolean;
	scenarioName?: string;
}

async function runMessageHandlerStage(args: {
	opts: RunOptions;
	recorder: LocalRecorder;
	stageNumber: number;
}): Promise<{
	action: "RESPOND" | "IGNORE" | "STOP";
	simple: boolean;
	contexts: string[];
	thought: string;
	reply?: string;
}> {
	const startedAt = Date.now();
	const messages: CerebrasChatMessage[] = [
		{
			role: "system",
			content:
				`${args.opts.systemPrompt}\n\nThis is the messageHandler stage. ` +
				`Decide what to do with the user's message. Reply with strict JSON of the form ` +
				`{"action":"RESPOND"|"IGNORE"|"STOP","simple":bool,"contexts":string[],"thought":string,"reply"?:string}. ` +
				`Set simple:true and include "reply" only when no tool calls are needed.`,
		},
		{ role: "user", content: args.opts.userMessage },
	];

	const result = await cerebrasChat({
		apiKey: args.opts.apiKey,
		model: args.opts.model,
		messages,
		responseFormat: { type: "json_object" },
	});

	const endedAt = Date.now();
	const cost = computeCallCostUsd(args.opts.model, result.usage);
	let parsed: ReturnType<typeof tryParseMessageHandler>;
	try {
		parsed = tryParseMessageHandler(result.rawResponseText);
	} catch (err) {
		throw new Error(
			`messageHandler returned invalid JSON: ${(err as Error).message}\nraw: ${result.rawResponseText.slice(0, 200)}`,
		);
	}

	args.recorder.record({
		stageId: `stage-${args.stageNumber}-msghandler`,
		kind: "messageHandler",
		startedAt,
		endedAt,
		latencyMs: endedAt - startedAt,
		model: {
			modelType: "RESPONSE_HANDLER",
			modelName: args.opts.model,
			provider: "cerebras",
			prompt: messages.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
			messages,
			response: result.rawResponseText,
			usage: result.usage,
			finishReason: result.finishReason,
			costUsd: cost,
		},
	});

	return parsed;
}

function tryParseMessageHandler(raw: string): {
	action: "RESPOND" | "IGNORE" | "STOP";
	simple: boolean;
	contexts: string[];
	thought: string;
	reply?: string;
} {
	const obj = JSON.parse(raw) as Record<string, unknown>;
	const action =
		typeof obj.action === "string" && ["RESPOND", "IGNORE", "STOP"].includes(obj.action)
			? (obj.action as "RESPOND" | "IGNORE" | "STOP")
			: "RESPOND";
	const simple = obj.simple === true;
	const contexts = Array.isArray(obj.contexts)
		? obj.contexts.filter((x): x is string => typeof x === "string")
		: [];
	const thought = typeof obj.thought === "string" ? obj.thought : "";
	const reply = typeof obj.reply === "string" ? obj.reply : undefined;
	return { action, simple, contexts, thought, reply };
}

async function runPlannerIteration(args: {
	opts: RunOptions;
	recorder: LocalRecorder;
	iteration: number;
	systemPromptExtras: string;
	conversation: CerebrasChatMessage[];
}): Promise<{
	stageId: string;
	toolCalls: ToolCallRecord[];
	assistantText: string;
}> {
	const startedAt = Date.now();
	const result = await cerebrasChat({
		apiKey: args.opts.apiKey,
		model: args.opts.model,
		messages: args.conversation,
		tools: toolDefsForCerebras(),
		toolChoice: "auto",
	});
	const endedAt = Date.now();
	const cost = computeCallCostUsd(args.opts.model, result.usage);
	const stageId = `stage-${args.recorder.snapshot.stages.length + 1}-planner-iter-${args.iteration}`;

	args.recorder.record({
		stageId,
		kind: "planner",
		iteration: args.iteration,
		startedAt,
		endedAt,
		latencyMs: endedAt - startedAt,
		model: {
			modelType: "ACTION_PLANNER",
			modelName: args.opts.model,
			provider: "cerebras",
			prompt: args.conversation.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
			messages: args.conversation,
			tools: toolDefsForCerebras().map((t) => ({
				name: t.function.name,
				description: t.function.description,
			})),
			toolChoice: "auto",
			response: result.rawResponseText,
			toolCalls: result.toolCalls,
			usage: result.usage,
			finishReason: result.finishReason,
			costUsd: cost,
		},
	});

	void args.systemPromptExtras;
	return {
		stageId,
		toolCalls: result.toolCalls,
		assistantText: result.rawResponseText,
	};
}

async function runToolStage(args: {
	recorder: LocalRecorder;
	toolCall: ToolCallRecord;
}): Promise<{
	success: boolean;
	resultPayload: unknown;
	resultText: string;
}> {
	const startedAt = Date.now();
	const action = actionByName(args.toolCall.name ?? "");
	const argsObj = args.toolCall.args ?? {};

	let success = false;
	let resultPayload: unknown = null;
	let resultText = "";

	if (!action) {
		const err = `Unknown tool: ${args.toolCall.name}`;
		resultPayload = { success: false, error: err };
		resultText = err;
	} else {
		const out = await action.handler(argsObj);
		success = out.success;
		resultPayload = out;
		resultText = out.text ?? out.error ?? JSON.stringify(out);
	}

	const endedAt = Date.now();
	const stageNumber = args.recorder.snapshot.stages.length + 1;
	args.recorder.record({
		stageId: `stage-${stageNumber}-tool-${args.toolCall.name ?? "unknown"}`,
		kind: "tool",
		startedAt,
		endedAt,
		latencyMs: endedAt - startedAt,
		tool: {
			name: args.toolCall.name ?? "unknown",
			args: argsObj,
			result: resultPayload,
			success,
			durationMs: endedAt - startedAt,
		},
	});

	return { success, resultPayload, resultText };
}

async function runEvaluationStage(args: {
	opts: RunOptions;
	recorder: LocalRecorder;
	iteration: number;
	conversation: CerebrasChatMessage[];
}): Promise<EvaluationRecord> {
	const startedAt = Date.now();
	const evaluatorMessages: CerebrasChatMessage[] = [
		...args.conversation,
		{
			role: "system",
			content:
				"You are the evaluator. Examine the most recent action result and reply with strict JSON: " +
				'{"success":bool,"decision":"FINISH"|"CONTINUE","thought":string,"messageToUser"?:string}.',
		},
	];

	const result = await cerebrasChat({
		apiKey: args.opts.apiKey,
		model: args.opts.model,
		messages: evaluatorMessages,
		responseFormat: { type: "json_object" },
	});
	const endedAt = Date.now();
	const cost = computeCallCostUsd(args.opts.model, result.usage);

	let evaluation: EvaluationRecord = {
		success: false,
		decision: "FINISH",
		thought: "Evaluator returned unparseable output; defaulting to FINISH.",
	};
	try {
		const parsed = JSON.parse(result.rawResponseText) as Record<string, unknown>;
		evaluation = {
			success: parsed.success === true,
			decision:
				typeof parsed.decision === "string" && parsed.decision === "CONTINUE"
					? "CONTINUE"
					: "FINISH",
			thought: typeof parsed.thought === "string" ? parsed.thought : undefined,
			messageToUser:
				typeof parsed.messageToUser === "string" ? parsed.messageToUser : undefined,
		};
	} catch {
		// Falls through to default evaluation above.
	}

	const stageNumber = args.recorder.snapshot.stages.length + 1;
	args.recorder.record({
		stageId: `stage-${stageNumber}-eval-iter-${args.iteration}`,
		kind: "evaluation",
		iteration: args.iteration,
		startedAt,
		endedAt,
		latencyMs: endedAt - startedAt,
		model: {
			modelType: "TEXT_LARGE",
			modelName: args.opts.model,
			provider: "cerebras",
			prompt: evaluatorMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
			messages: evaluatorMessages,
			response: result.rawResponseText,
			usage: result.usage,
			finishReason: result.finishReason,
			costUsd: cost,
		},
		evaluation,
	});

	return evaluation;
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

const MAX_PLANNER_ITERATIONS = 4;

async function runTrajectory(opts: RunOptions): Promise<RecordedTrajectory> {
	const colors = colorize(opts.noTty);
	const printer = (stage: RecordedStage, idx: number): void => {
		const stamp = formatTimestamp(stage.startedAt);
		const lat = `${stage.latencyMs}ms`;
		const cost = stage.model?.costUsd
			? ` · ${formatUsd(stage.model.costUsd)}`
			: "";
		const cache =
			stage.model?.usage?.cacheReadInputTokens
				? ` (cache: ${stage.model.usage.cacheReadInputTokens} read)`
				: "";

		const headline = `[${stamp}] Stage ${idx + 1} [${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""}${stage.tool ? `: ${stage.tool.name}` : ""}] ${lat}${cost}${cache}`;
		console.log(colors.bold(headline));

		if (opts.stagesOnly) return;

		if (stage.model) {
			const u = stage.model.usage;
			if (u) {
				console.log(
					`  Prompt: ${u.promptTokens} tokens · Response: ${u.completionTokens} tokens · model ${stage.model.modelName ?? stage.model.modelType}`,
				);
			}
			if (stage.model.toolCalls && stage.model.toolCalls.length > 0) {
				console.log(
					`  → toolCalls: [${stage.model.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.args ?? {})})`).join(", ")}]`,
				);
			}
		}
		if (stage.tool) {
			const status = stage.tool.success
				? colors.green("success: true")
				: colors.red("success: false");
			console.log(`  → ${status}`);
		}
		if (stage.evaluation) {
			const status = stage.evaluation.success
				? colors.green("success: true")
				: colors.red("success: false");
			console.log(
				`  → ${status}, decision: ${colors.cyan(stage.evaluation.decision)}`,
			);
			if (stage.evaluation.thought) {
				console.log(`  → thought: ${stage.evaluation.thought}`);
			}
			if (stage.evaluation.messageToUser) {
				console.log(`  → messageToUser: ${stage.evaluation.messageToUser}`);
			}
		}
	};

	const recorder = new LocalRecorder({
		agentId: "agent-cerebras-runner",
		roomId: "room-cerebras-runner",
		rootMessage: { id: `msg-${Date.now()}`, text: opts.userMessage, sender: "user" },
		printer,
	});

	console.log(
		colors.bold(
			`[${formatTimestamp(Date.now())}] Trajectory ${recorder.id} started`,
		),
	);
	if (opts.scenarioName) {
		console.log(colors.dim(`  scenario: ${opts.scenarioName}`));
	}
	console.log(colors.dim(`  message: ${opts.userMessage}`));

	try {
		// Stage 1: messageHandler
		const handler = await runMessageHandlerStage({
			opts,
			recorder,
			stageNumber: 1,
		});

		if (handler.action === "IGNORE" || handler.action === "STOP") {
			recorder.snapshot.metrics.finalDecision = "FINISH";
			console.log(colors.dim(`  messageHandler returned ${handler.action}.`));
		} else if (handler.simple && handler.reply) {
			recorder.snapshot.metrics.finalDecision = "FINISH";
			console.log(colors.dim(`  direct reply: ${handler.reply}`));
		} else {
			// Planner / tool / evaluator loop
			const conversation: CerebrasChatMessage[] = [
				{
					role: "system",
					content:
						`${opts.systemPrompt}\n\n` +
						`This is the planner stage. Choose tool(s) to call. ` +
						`After each tool, you'll be re-prompted with the result.`,
				},
				{ role: "user", content: opts.userMessage },
			];

			let iteration = 1;
			while (iteration <= MAX_PLANNER_ITERATIONS) {
				const plannerResult = await runPlannerIteration({
					opts,
					recorder,
					iteration,
					systemPromptExtras: "",
					conversation,
				});

				if (plannerResult.toolCalls.length === 0) {
					// No more tool calls — treat assistant text as the final answer.
					if (plannerResult.assistantText) {
						console.log(
							colors.dim(`  final assistant message: ${plannerResult.assistantText}`),
						);
					}
					recorder.snapshot.metrics.finalDecision = "FINISH";
					break;
				}

				// Append the assistant tool-call message to the conversation
				conversation.push({
					role: "assistant",
					content: plannerResult.assistantText,
					tool_calls: plannerResult.toolCalls.map((tc) => ({
						id: tc.id ?? `tc-${crypto.randomBytes(3).toString("hex")}`,
						type: "function" as const,
						function: {
							name: tc.name ?? "unknown",
							arguments: JSON.stringify(tc.args ?? {}),
						},
					})),
				});

				// Execute every returned tool call sequentially
				let anyFailure = false;
				for (const toolCall of plannerResult.toolCalls) {
					const exec = await runToolStage({ recorder, toolCall });
					if (!exec.success) anyFailure = true;
					conversation.push({
						role: "tool",
						content:
							typeof exec.resultPayload === "string"
								? exec.resultPayload
								: JSON.stringify(exec.resultPayload),
						tool_call_id: toolCall.id,
						name: toolCall.name,
					});
				}

				const evaluation = await runEvaluationStage({
					opts,
					recorder,
					iteration,
					conversation,
				});

				if (evaluation.decision === "FINISH" || (!anyFailure && evaluation.success)) {
					recorder.snapshot.metrics.finalDecision = "FINISH";
					if (evaluation.messageToUser) {
						console.log(
							colors.dim(`  final messageToUser: ${evaluation.messageToUser}`),
						);
					}
					break;
				}

				iteration += 1;
			}

			if (iteration > MAX_PLANNER_ITERATIONS) {
				recorder.snapshot.metrics.finalDecision = "max_iterations";
			}
		}

		const final = recorder.end("finished");
		console.log("");
		console.log(
			colors.bold(
				`[${formatTimestamp(Date.now())}] Trajectory finished: ${final.metrics.totalLatencyMs}ms · ${formatUsd(final.metrics.totalCostUsd)} · ${final.stages.length} stages · ${final.metrics.toolCallsExecuted} tool calls (${final.metrics.toolCallsExecuted - final.metrics.toolCallFailures} success)`,
			),
		);
		const cacheRate =
			final.metrics.totalPromptTokens > 0
				? (final.metrics.totalCacheReadTokens / final.metrics.totalPromptTokens) * 100
				: 0;
		console.log(
			colors.dim(`  cache hit rate: ${cacheRate.toFixed(1)}% across stages`),
		);
		return final;
	} catch (err) {
		recorder.end("errored");
		console.error(
			colors.red(`Trajectory ${recorder.id} errored: ${(err as Error).message}`),
		);
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
	positional: string[];
	flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
	const positional: string[] = [];
	const flags = new Map<string, string | true>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq >= 0) {
				flags.set(token.slice(2, eq), token.slice(eq + 1));
			} else {
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith("--")) {
					flags.set(token.slice(2), next);
					i++;
				} else {
					flags.set(token.slice(2), true);
				}
			}
		} else {
			positional.push(token);
		}
	}
	return { positional, flags };
}

// ---------------------------------------------------------------------------
// Scenario loading
// ---------------------------------------------------------------------------

interface ScenarioFile {
	message: string;
	systemPrompt?: string;
	expect?: Record<string, unknown>;
}

async function loadScenario(name: string): Promise<ScenarioFile> {
	const candidate = path.resolve(
		process.cwd(),
		"research/native-tool-calling/scenarios",
		`${name.replace(/\.json$/, "")}.json`,
	);
	const raw = await fs.readFile(candidate, "utf8");
	return JSON.parse(raw) as ScenarioFile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT =
	"You are a concise test agent. Use the provided tools when they are useful. " +
	"Always reply with strictly valid JSON when the message you are answering asks for it.";

async function main(): Promise<void> {
	const apiKey = process.env.CEREBRAS_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		console.error(
			"CEREBRAS_API_KEY is not set. Export it in your shell before running this script.",
		);
		process.exit(1);
	}

	const argv = process.argv.slice(2);
	const { positional, flags } = parseArgs(argv);

	let userMessage = (flags.get("message") as string | undefined) ?? positional[0];
	let systemPrompt = DEFAULT_SYSTEM_PROMPT;
	let scenarioName: string | undefined;

	const scenarioFlag = flags.get("scenario");
	if (typeof scenarioFlag === "string") {
		scenarioName = scenarioFlag;
		try {
			const scenario = await loadScenario(scenarioFlag);
			userMessage = scenario.message;
			if (scenario.systemPrompt) systemPrompt = scenario.systemPrompt;
		} catch (err) {
			console.error(
				`Failed to load scenario "${scenarioFlag}": ${(err as Error).message}`,
			);
			process.exit(1);
		}
	}

	if (!userMessage) {
		console.error(
			'No message provided. Pass a positional arg, --message "...", or --scenario <name>.',
		);
		process.exit(1);
	}

	const opts: RunOptions = {
		apiKey,
		model: (flags.get("model") as string | undefined) ?? "gpt-oss-120b",
		systemPrompt,
		userMessage,
		noTty: flags.get("no-tty") === true || flags.get("no-tty") === "true",
		stagesOnly:
			flags.get("stages-only") === true || flags.get("stages-only") === "true",
		record: !(flags.get("no-record") === true || flags.get("no-record") === "true"),
		scenarioName,
	};

	const trajectory = await runTrajectory(opts);

	if (opts.record) {
		const targetDir =
			process.env.MILADY_TRAJECTORY_DIR ??
			path.resolve(process.cwd(), "trajectories");
		await fs.mkdir(targetDir, { recursive: true });
		const filePath = path.join(targetDir, `${trajectory.trajectoryId}.json`);
		await fs.writeFile(filePath, JSON.stringify(trajectory, null, 2), "utf8");
		console.log(`Saved: ${filePath}`);
		console.log(
			`Inspect: bun run scripts/trajectory.ts print ${trajectory.trajectoryId}`,
		);
	}
}

main().catch((err) => {
	console.error(`run-cerebras failed: ${(err as Error).message}`);
	process.exit(1);
});
