import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v4 as uuidv4 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScoreCard } from "../optimization/score-card.ts";
import type { ExecutionTrace } from "../optimization/types.ts";
import {
	enrichContinuationSignals,
	trackAgentResponse,
} from "../plugin-neuro/handlers/continuation.ts";
import { handleRunEnded } from "../plugin-neuro/handlers/finalizer.ts";
import { handleReaction } from "../plugin-neuro/handlers/reaction.ts";
import { neuroEvaluator, neuroPlugin } from "../plugin-neuro/index.ts";
import {
	CONTINUATION_WINDOW_MS,
	EMOJI_SENTIMENT,
	NEURO_SOURCE,
	SIGNALS,
} from "../plugin-neuro/signals.ts";
import { EventType } from "../types/events.ts";
import type { Memory } from "../types/memory.ts";
import type { UUID } from "../types/primitives.ts";
import type { IAgentRuntime } from "../types/runtime.ts";

vi.mock("../optimization/auto-optimizer.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../optimization/auto-optimizer.ts")>();
	return {
		...actual,
		maybeRunAutoPromptOptimization: vi.fn().mockResolvedValue(undefined),
	};
});

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
	const card = new ScoreCard();
	card.add({ source: "dpe", kind: "parseSuccess", value: 1.0 });
	return {
		id: `t-${uuidv4()}`,
		traceVersion: 1,
		type: "trace",
		promptKey: "replyAction",
		modelSlot: "TEXT_SMALL",
		modelId: "test-model",
		templateHash: "h1",
		schemaFingerprint: "s1",
		variant: "baseline",
		parseSuccess: true,
		schemaValid: true,
		validationCodesMatched: true,
		retriesUsed: 0,
		tokenEstimate: 50,
		latencyMs: 120,
		scoreCard: card.toJSON(),
		createdAt: Date.now(),
		...overrides,
	};
}

function mem(p: {
	entityId: UUID;
	roomId: UUID;
	content: Memory["content"];
	id?: UUID;
}): Memory {
	return {
		id: p.id ?? (uuidv4() as UUID),
		entityId: p.entityId,
		roomId: p.roomId,
		content: p.content,
	};
}

describe("plugin-neuro signals", () => {
	it("exports stable SIGNALS kinds", () => {
		expect(SIGNALS.USER_CORRECTION).toBe("user_correction");
		expect(SIGNALS.CONVERSATION_CONTINUED).toBe("conversation_continued");
		expect(NEURO_SOURCE).toBe("neuro");
	});

	it("maps known emojis in EMOJI_SENTIMENT", () => {
		expect(EMOJI_SENTIMENT["👍"]).toBe(1.0);
		expect(EMOJI_SENTIMENT["👎"]).toBe(0.0);
		expect(EMOJI_SENTIMENT["🤔"]).toBe(0.5);
	});
});

describe("plugin-neuro wiring", () => {
	it("registers neuro evaluator and event handlers", () => {
		expect(neuroPlugin.name).toBe("plugin-neuro");
		expect(neuroPlugin.evaluators).toHaveLength(1);
		expect(neuroPlugin.evaluators?.[0]?.name).toBe("NEURO_QUALITY");
		const ev = neuroPlugin.events;
		expect(ev?.[EventType.RUN_ENDED]?.length).toBeGreaterThan(0);
		expect(ev?.[EventType.REACTION_RECEIVED]?.length).toBeGreaterThan(0);
	});
});

describe("handleReaction", () => {
	it("no-ops for unknown emoji", async () => {
		const enrichTrace = vi.fn();
		const runtime = { enrichTrace } as unknown as IAgentRuntime;
		const message = mem({
			entityId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text: "not-an-emoji" },
		});
		await handleReaction({ message, runtime } as never, runtime);
		expect(enrichTrace).not.toHaveBeenCalled();
	});

	it("no-ops when reaction memory has no runId", async () => {
		const enrichTrace = vi.fn();
		const runtime = { enrichTrace } as unknown as IAgentRuntime;
		const message = mem({
			entityId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text: "👍" },
		});
		await handleReaction({ message, runtime } as never, runtime);
		expect(enrichTrace).not.toHaveBeenCalled();
	});

	it("enriches positive reaction", async () => {
		const enrichTrace = vi.fn();
		const runtime = { enrichTrace } as unknown as IAgentRuntime;
		const runId = uuidv4();
		const message = mem({
			entityId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text: "👍" },
		});
		(message as unknown as Record<string, unknown>).runId = runId;
		await handleReaction({ message, runtime } as never, runtime);
		expect(enrichTrace).toHaveBeenCalledWith(
			runId,
			expect.objectContaining({
				source: NEURO_SOURCE,
				kind: SIGNALS.REACTION_POSITIVE,
				value: 1.0,
				metadata: expect.objectContaining({ emoji: "👍" }),
			}),
		);
	});

	it("enriches negative and neutral bands", async () => {
		const enrichTrace = vi.fn();
		const runtime = { enrichTrace } as unknown as IAgentRuntime;
		const runId = uuidv4();

		const msgNeg = mem({
			entityId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text: "👎" },
		});
		(msgNeg as unknown as Record<string, unknown>).runId = runId;
		await handleReaction({ message: msgNeg, runtime } as never, runtime);
		expect(enrichTrace).toHaveBeenLastCalledWith(
			runId,
			expect.objectContaining({
				kind: SIGNALS.REACTION_NEGATIVE,
				value: 0.0,
			}),
		);

		enrichTrace.mockClear();
		const msgNeu = mem({
			entityId: uuidv4() as UUID,
			roomId: uuidv4() as UUID,
			content: { text: "🤔" },
		});
		(msgNeu as unknown as Record<string, unknown>).runId = runId;
		await handleReaction({ message: msgNeu, runtime } as never, runtime);
		expect(enrichTrace).toHaveBeenCalledWith(
			runId,
			expect.objectContaining({
				kind: SIGNALS.REACTION_NEUTRAL,
				value: 0.5,
			}),
		);
	});
});

describe("continuation helpers", () => {
	const agentId = uuidv4() as UUID;
	const roomId = uuidv4() as UUID;

	it("does not enrich without a prior trackAgentResponse", () => {
		const enrichTrace = vi.fn();
		const runtime = {
			agentId,
			enrichTrace,
		} as unknown as IAgentRuntime;
		enrichContinuationSignals(runtime, "run-1", roomId, "Thanks, that helped!");
		expect(enrichTrace).not.toHaveBeenCalled();
	});

	it("enriches continuation and non-correction user_correction after prior response", () => {
		const enrichTrace = vi.fn();
		const runtime = {
			agentId,
			enrichTrace,
		} as unknown as IAgentRuntime;
		trackAgentResponse(roomId, "prev-run", 42, agentId);
		enrichContinuationSignals(runtime, "run-2", roomId, "What about step two?");
		expect(enrichTrace).toHaveBeenCalledWith(
			"run-2",
			expect.objectContaining({
				kind: SIGNALS.CONVERSATION_CONTINUED,
				value: 1.0,
			}),
		);
		expect(enrichTrace).toHaveBeenCalledWith(
			"run-2",
			expect.objectContaining({
				kind: SIGNALS.USER_CORRECTION,
				value: 1.0,
			}),
		);
	});

	it("sets user_correction to 0 when correction patterns match", () => {
		const enrichTrace = vi.fn();
		const runtime = {
			agentId,
			enrichTrace,
		} as unknown as IAgentRuntime;
		trackAgentResponse(roomId, "prev-run", 10, agentId);
		enrichContinuationSignals(
			runtime,
			"run-3",
			roomId,
			"That's wrong, I meant the other file",
		);
		expect(enrichTrace).toHaveBeenCalledWith(
			"run-3",
			expect.objectContaining({
				kind: SIGNALS.USER_CORRECTION,
				value: 0.0,
			}),
		);
	});

	it("ignores stale prior responses outside continuation window", () => {
		const enrichTrace = vi.fn();
		const runtime = {
			agentId,
			enrichTrace,
		} as unknown as IAgentRuntime;
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(1_000_000);
		trackAgentResponse(roomId, "prev-run", 5, agentId);
		now.mockReturnValue(1_000_000 + CONTINUATION_WINDOW_MS + 1);
		enrichContinuationSignals(runtime, "run-4", roomId, "Hello?");
		expect(enrichTrace).not.toHaveBeenCalled();
		now.mockRestore();
	});
});

describe("neuroEvaluator", () => {
	const agentId = uuidv4() as UUID;
	const roomId = uuidv4() as UUID;

	it("validate skips agent-originated messages", async () => {
		const ok = await neuroEvaluator.validate?.(
			{ agentId } as unknown as IAgentRuntime,
			mem({
				entityId: agentId,
				roomId,
				content: { text: "from agent" },
			}),
		);
		expect(ok).toBe(false);
	});

	it("validate accepts user messages", async () => {
		const ok = await neuroEvaluator.validate?.(
			{ agentId } as unknown as IAgentRuntime,
			mem({
				entityId: uuidv4() as UUID,
				roomId,
				content: { text: "from user" },
			}),
		);
		expect(ok).toBe(true);
	});

	it("handler returns early without responses or runId", async () => {
		const runtime = {
			agentId,
			getCurrentRunId: () => undefined,
		} as unknown as IAgentRuntime;
		const out = await neuroEvaluator.handler?.(
			runtime,
			mem({
				entityId: uuidv4() as UUID,
				roomId,
				content: { text: "u" },
			}),
			undefined,
			undefined,
			undefined,
			[],
		);
		expect(out).toBeUndefined();
	});

	it("attaches length to last trace and latency to each trace", async () => {
		const runId = uuidv4();
		const t1 = makeTrace({ id: "a", latencyMs: 100 });
		const t2 = makeTrace({ id: "b", latencyMs: 200 });
		const runtime = {
			agentId,
			getCurrentRunId: () => runId,
			getActiveTracesForRun: () => [t1, t2],
			getActiveTrace: vi.fn(),
			enrichTrace: vi.fn(),
		} as unknown as IAgentRuntime;

		const userMsg = mem({
			entityId: uuidv4() as UUID,
			roomId,
			content: { text: "follow-up" },
		});
		const agentMsg = mem({
			entityId: agentId,
			roomId,
			content: { text: "hello world" },
		});

		await neuroEvaluator.handler?.(
			runtime,
			userMsg,
			undefined,
			undefined,
			undefined,
			[agentMsg],
		);

		const lengthOnReply = t2.scoreCard.signals.filter(
			(s) => s.kind === SIGNALS.LENGTH_APPROPRIATENESS,
		);
		expect(lengthOnReply.length).toBe(1);
		expect(lengthOnReply[0]?.metadata?.responseLength).toBe(
			"hello world".length,
		);

		for (const t of [t1, t2]) {
			const lat = t.scoreCard.signals.filter(
				(s) => s.kind === SIGNALS.RESPONSE_LATENCY,
			);
			expect(lat.length).toBe(1);
		}
		expect(runtime.enrichTrace).not.toHaveBeenCalled();
	});

	it("falls back to enrichTrace when no active traces", async () => {
		const runId = uuidv4();
		const enrichTrace = vi.fn();
		const runtime = {
			agentId,
			getCurrentRunId: () => runId,
			getActiveTracesForRun: () => [],
			getActiveTrace: () => undefined,
			enrichTrace,
		} as unknown as IAgentRuntime;

		await neuroEvaluator.handler?.(
			runtime,
			mem({
				entityId: uuidv4() as UUID,
				roomId,
				content: { text: "u" },
			}),
			undefined,
			undefined,
			undefined,
			[
				mem({
					entityId: agentId,
					roomId,
					content: { text: "x" },
				}),
			],
		);

		expect(enrichTrace).toHaveBeenCalledWith(
			runId,
			expect.objectContaining({
				source: NEURO_SOURCE,
				kind: SIGNALS.LENGTH_APPROPRIATENESS,
			}),
		);
	});
});

describe("handleRunEnded", () => {
	let optDir: string;

	beforeEach(async () => {
		optDir = await mkdtemp(join(tmpdir(), "neuro-finalizer-"));
	});

	afterEach(async () => {
		await rm(optDir, { recursive: true, force: true });
	});

	it("skips when runId missing", async () => {
		const debug = vi.fn();
		const runtime = {
			logger: { debug, warn: vi.fn() },
			getActiveTracesForRun: () => [],
			getActiveTrace: () => undefined,
		} as unknown as IAgentRuntime;
		await handleRunEnded({ runId: "", runtime } as never, runtime);
		expect(debug).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "missing_runId" }),
			expect.any(String),
		);
	});

	it("skips when no traces", async () => {
		const debug = vi.fn();
		const runId = uuidv4();
		const runtime = {
			logger: { debug, warn: vi.fn() },
			getActiveTracesForRun: () => [],
			getActiveTrace: () => undefined,
			getSetting: () => optDir,
		} as unknown as IAgentRuntime;
		await handleRunEnded({ runId, runtime } as never, runtime);
		expect(debug).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "no_active_traces" }),
			expect.any(String),
		);
	});

	it("persists enriched trace, emits event, and clears active traces", async () => {
		const runId = uuidv4();
		const trace = makeTrace();
		const deleteActiveTrace = vi.fn();
		const emitEvent = vi.fn();
		const runtime = {
			logger: { debug: vi.fn(), warn: vi.fn() },
			getActiveTracesForRun: () => [trace],
			getActiveTrace: vi.fn(),
			deleteActiveTrace,
			deleteActiveTraceById: vi.fn(),
			emitEvent,
			getSetting: (k: string) => (k === "OPTIMIZATION_DIR" ? optDir : null),
		} as unknown as IAgentRuntime;

		await handleRunEnded({ runId, runtime } as never, runtime);

		const historyPath = join(
			optDir,
			"test-model",
			"TEXT_SMALL",
			"history.jsonl",
		);
		const raw = await readFile(historyPath, "utf-8");
		const lines = raw.trim().split("\n").filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
			type: string;
			seq?: number;
			scoreCard?: { compositeScore: number };
		};
		expect(last.type).toBe("trace");
		expect(typeof last.seq).toBe("number");
		expect(deleteActiveTrace).toHaveBeenCalledWith(runId);
		expect(emitEvent).toHaveBeenCalledWith(
			EventType.OPTIMIZATION_TRACE,
			expect.objectContaining({
				runId,
				promptKey: trace.promptKey,
			}),
		);
	});
});
