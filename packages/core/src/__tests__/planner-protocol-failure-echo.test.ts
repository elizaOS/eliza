/**
 * Exact-head weak-model trajectory for the protocol-failure echo path
 * (live tj-f730d907139bb2): a weak model violates the evaluator protocol and
 * then repeats a tool's planner-facing `result.text` verbatim as its reply.
 * Drives the REAL planner loop through `runV5MessageRuntimeStage1` with a
 * queued canned-response model — deterministic replay of the live failure —
 * and asserts the raw tool text can never reach the final message: recovery
 * must synthesize from typed data (`userFacingText`) or end the turn without
 * promoting `result.text`. Real action handlers and real trajectory recording
 * to a temp dir; no live model.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../runtime/builtin-field-evaluators";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import { runV5MessageRuntimeStage1 } from "../services/message";
import type { Action, ActionResult } from "../types/components";
import type { Memory } from "../types/memory";
import { ModelType } from "../types/model";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const MSG_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

/** Planner-facing tool output (no `userFacingText`): the leak material. */
const RAW_TOOL_TEXT = [
	"I found 3 orchestrator tasks matching window today; statuses active, complete.",
	"- fix login flow [active] (2026-08-01)",
	"- deploy homepage [complete] (2026-08-02)",
	"- refactor billing [active] (2026-08-03)",
].join("\n");

/** Exact head of the raw text — the truncated-echo shape a weak model emits. */
const RAW_TOOL_TEXT_HEAD =
	"I found 3 orchestrator tasks matching window today; statuses active, complete.";

/** Envelope with an unlicensed field — a deterministic protocol failure. */
const PROTOCOL_FAILURE_EVALUATOR_BODY = JSON.stringify({
	success: true,
	decision: "FINISH",
	thought: "Relay the task history.",
	messageToUser: RAW_TOOL_TEXT_HEAD,
	unlicensed_extra_field: true,
});

function makeMessage(): Memory {
	return {
		id: MSG_ID,
		entityId: SENDER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "what ran today?", source: "test" },
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: { availableContexts: "general, automation" },
		data: {},
		text: "Recent conversation summary",
	};
}

function stage1RespondBody() {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					thought: "User asks about task history; route to planning.",
					contexts: ["general"],
					intents: [],
					candidateActionNames: ["TASK_HISTORY"],
					replyText: "",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
	};
}

function taskHistoryAction(result: Partial<ActionResult>): Action {
	return {
		name: "TASK_HISTORY",
		description: "List orchestrator task history.",
		similes: [],
		examples: [],
		parameters: [],
		validate: async () => true,
		handler: async () => ({
			success: true,
			text: RAW_TOOL_TEXT,
			data: { actionName: "TASK_HISTORY", count: 3 },
			...result,
		}),
	} as Action;
}

interface CannedResponse {
	expectModelType?: string;
	body: unknown;
}

function makeRuntime(opts: {
	actions: Action[];
	responses: CannedResponse[];
}): IAgentRuntime {
	const queue = [...opts.responses];
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: AGENT_ID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "I help with practical tasks.",
		},
		actions: opts.actions,
		providers: [],
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		runActionsByMode: vi.fn(async () => undefined),
		getSetting: vi.fn(() => undefined),
		useModel: vi.fn(async (modelType: unknown) => {
			if (queue.length === 0) {
				throw new Error(
					`Unexpected useModel call (modelType=${String(modelType)}); queue empty`,
				);
			}
			const next = queue.shift();
			if (next?.expectModelType && String(modelType) !== next.expectModelType) {
				throw new Error(
					`Expected ${next.expectModelType} but received ${String(modelType)}`,
				);
			}
			return next?.body;
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as IAgentRuntime;
}

function modelCallTypes(runtime: IAgentRuntime): string[] {
	return (runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls.map(
		(call) => String(call[0]),
	);
}

let tempDir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "v5-protocol-echo-"));
	originalEnv = { ...process.env };
	process.env.ELIZA_TRAJECTORY_DIR = tempDir;
	process.env.ELIZA_TRAJECTORY_RECORDING = "1";
});

afterEach(() => {
	process.env = originalEnv;
	rmSync(tempDir, { recursive: true, force: true });
});

function readRecordedTrajectories(agentId: string): unknown[] {
	const dir = join(tempDir, agentId);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// error-policy:J3 a missing dir is the explicit "nothing recorded" case.
		return [];
	}
	return entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => JSON.parse(readFileSync(join(dir, entry), "utf8")));
}

describe("protocol-failure recovery never promotes raw result.text", () => {
	it("exact-head weak-model echo: the raw tool text cannot reach the final message", async () => {
		// Replay of tj-f730d907139bb2 through the real loop:
		//   1. planner runs TASK_HISTORY (planner-facing text only),
		//   2. the evaluator violates its protocol (unlicensed envelope field),
		//   3. the replanned weak model repeats the tool text's exact head as
		//      its REPLY,
		//   4. the forced no-tools synthesis pass repeats the full tool text,
		//   5. the last-resort TEXT_LARGE rescue synthesis echoes it again.
		// Every model-channel candidate is a verbatim echo, so the turn must
		// fall through to the safe ack — never the raw text.
		const runtime = makeRuntime({
			actions: [taskHistoryAction({})],
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: stage1RespondBody(),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [{ id: "call-1", name: "TASK_HISTORY", args: {} }],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: PROTOCOL_FAILURE_EVALUATOR_BODY,
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [
							{
								id: "reply-1",
								name: "REPLY",
								args: { text: RAW_TOOL_TEXT_HEAD },
							},
						],
					},
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: { text: RAW_TOOL_TEXT },
				},
				{
					expectModelType: ModelType.TEXT_LARGE,
					body: RAW_TOOL_TEXT,
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind !== "planned_reply") return;
		const delivered = result.result.responseContent?.text ?? "";
		// The structural assertion: no fragment of the planner-facing text —
		// not the exact head, not the list lines — ships to the user.
		expect(delivered).not.toContain("I found 3 orchestrator tasks");
		expect(delivered).not.toContain("fix login flow");
		expect(delivered).not.toContain(RAW_TOOL_TEXT_HEAD);
		// The turn still delivers (addressed turns must not go silent): the
		// grounded ack, not tool internals.
		expect(delivered.length).toBeGreaterThan(0);

		// The weak model got its replan, the forced synthesis pass, AND the
		// last-resort rescue synthesis — and every echo was refused. 6 calls:
		// stage1, planner, evaluator (protocol failure), replanned REPLY echo,
		// forced synthesis echo, TEXT_LARGE rescue echo.
		expect(modelCallTypes(runtime)).toEqual([
			String(ModelType.RESPONSE_HANDLER),
			String(ModelType.ACTION_PLANNER),
			String(ModelType.RESPONSE_HANDLER),
			String(ModelType.ACTION_PLANNER),
			String(ModelType.ACTION_PLANNER),
			String(ModelType.TEXT_LARGE),
		]);

		// The recorded trajectory carries the protocol failure — this test IS
		// the exact-head weak-model trajectory, replayable from disk.
		const recorded = readRecordedTrajectories(AGENT_ID);
		expect(recorded.length).toBeGreaterThan(0);
		expect(JSON.stringify(recorded)).toContain("protocolFailure");
	});

	it("synthesizes from typed data: protocol failure relays the tool's userFacingText", async () => {
		// Same protocol failure, but the tool exposed typed user-facing data.
		// Recovery must ship exactly that — no replan, no echo window.
		const userFacing =
			"You have 3 task threads from today: login flow and billing are active; the homepage deploy is complete.";
		const runtime = makeRuntime({
			actions: [taskHistoryAction({ userFacingText: userFacing })],
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: stage1RespondBody(),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [{ id: "call-1", name: "TASK_HISTORY", args: {} }],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: PROTOCOL_FAILURE_EVALUATOR_BODY,
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind !== "planned_reply") return;
		expect(result.result.responseContent?.text).toBe(userFacing);
		// Deterministic relay: exactly three model calls, no replan.
		expect(modelCallTypes(runtime)).toHaveLength(3);
	});

	it("evaluator prose echo: recovered raw-text prose is refused and the turn re-synthesizes", async () => {
		// The weak model can also echo by dumping the tool text as its whole
		// evaluator response. The prose-recovery path promotes that text to
		// messageToUser — the echo gate must refuse it there too, and the
		// forced synthesis pass (here: a genuine paraphrase) ships instead.
		const paraphrase =
			"Three orchestrator tasks ran today — login flow and billing are still active, the homepage deploy finished.";
		const runtime = makeRuntime({
			actions: [taskHistoryAction({})],
			responses: [
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: stage1RespondBody(),
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: {
						text: "",
						toolCalls: [{ id: "call-1", name: "TASK_HISTORY", args: {} }],
					},
				},
				{
					expectModelType: ModelType.RESPONSE_HANDLER,
					body: RAW_TOOL_TEXT,
				},
				{
					expectModelType: ModelType.ACTION_PLANNER,
					body: { text: paraphrase },
				},
			],
		});

		const result = await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: RESPONSE_ID,
		});

		expect(result.kind).toBe("planned_reply");
		if (result.kind !== "planned_reply") return;
		expect(result.result.responseContent?.text).toBe(paraphrase);
		expect(result.result.responseContent?.text).not.toContain("fix login flow");
	});
});
