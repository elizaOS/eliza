/**
 * Exercises runAutonomyPostResponse end to end against a recording fake
 * runtime: batcher fields normalize into pipeline Content, REPLY/STOP/other
 * modes select the outgoing hooks and delivery path, the response persists to
 * "messages", and a missing EvaluatorService degrades through the real J4
 * fallback while ALWAYS_AFTER still observes didRespond. Deterministic — no
 * model, no DB.
 */

import { describe, expect, it } from "vitest";
import { createUniqueUuid } from "../../entities.ts";
import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../types/index.ts";
import { runAutonomyPostResponse } from "./execution-facade.ts";

const AGENT_ID = "f0000000-0000-4000-8000-000000000001";
const ROOM_ID = "f0000000-0000-4000-8000-000000000002";
const PROMPT_ID = "f0000000-0000-4000-8000-000000000003";

interface RecordingCalls {
	hooks: Array<{ event: string; info: Record<string, unknown> }>;
	memories: Array<{ memory: Memory; table: string }>;
	composeStateProviders: string[][];
	alwaysAfter: Array<Record<string, unknown>>;
	reportedErrors: Array<{ scope: string; error: unknown }>;
	handlerRuns: Array<{ message: Memory; options: unknown }>;
	callbacks: unknown[];
}

function makeRuntime(opts?: { actions?: unknown[] }): {
	runtime: IAgentRuntime;
	calls: RecordingCalls;
} {
	const calls: RecordingCalls = {
		hooks: [],
		memories: [],
		composeStateProviders: [],
		alwaysAfter: [],
		reportedErrors: [],
		handlerRuns: [],
		callbacks: [],
	};
	const runtime = {
		agentId: AGENT_ID,
		logger: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
		actions: opts?.actions ?? [],
		composeState: async (_message: Memory, providers: string[]) => {
			calls.composeStateProviders.push(providers);
			return { values: {}, data: {}, text: "" } as State;
		},
		applyPipelineHooks: async (
			event: string,
			info: Record<string, unknown>,
		) => {
			calls.hooks.push({ event, info });
		},
		createMemory: async (memory: Memory, table: string) => {
			calls.memories.push({ memory, table });
			return memory;
		},
		getServiceLoadPromise: async () => {
			throw new Error("EvaluatorService not loaded in unit harness");
		},
		reportError: (scope: string, error: unknown) => {
			calls.reportedErrors.push({ scope, error });
		},
		runActionsByMode: async (
			mode: string,
			_message: Memory,
			_state: State | undefined,
			options: Record<string, unknown>,
		) => {
			calls.alwaysAfter.push({ mode, ...options });
		},
		getSetting: () => undefined,
		emitEvent: async (...args: unknown[]) => {
			return args;
		},
	} as unknown as IAgentRuntime;
	return { runtime, calls };
}

function autonomyMessage(overrides: Partial<Memory> = {}): Memory {
	return {
		id: PROMPT_ID,
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "autonomy prompt" },
		createdAt: 1_000,
		...overrides,
	} as Memory;
}

function recordingCallback(calls: RecordingCalls): HandlerCallback {
	return (async (content: unknown) => {
		calls.callbacks.push(content);
		return [];
	}) as HandlerCallback;
}

describe("runAutonomyPostResponse", () => {
	it("delivers REPLY through the simple path with normalized content and minted inReplyTo", async () => {
		const { runtime, calls } = makeRuntime();
		const callback = recordingCallback(calls);
		const message = autonomyMessage();

		await runAutonomyPostResponse(
			runtime,
			message,
			{
				thought: "considering",
				text: "hi there",
				actions: ["reply"],
				providers: "ctxA, ctxB",
			},
			callback,
		);

		expect(calls.memories).toHaveLength(1);
		expect(calls.memories[0].table).toBe("messages");
		const saved = calls.memories[0].memory;
		expect(saved.entityId).toBe(AGENT_ID);
		expect(saved.agentId).toBe(AGENT_ID);
		expect(saved.roomId).toBe(ROOM_ID);
		expect(saved.content.actions).toEqual(["reply"]);
		expect(saved.content.providers).toEqual(["ctxA", "ctxB"]);
		expect(saved.content.thought).toBe("considering");
		expect(saved.content.text).toBe("hi there");
		expect(saved.content.inReplyTo).toBe(createUniqueUuid(runtime, PROMPT_ID));

		expect(calls.hooks).toHaveLength(1);
		expect(calls.hooks[0].event).toBe("outgoing_before_deliver");
		expect(calls.hooks[0].info.source).toBe("autonomy_simple");

		expect(calls.callbacks).toHaveLength(1);
		expect((calls.callbacks[0] as { text: string }).text).toBe("hi there");

		expect(calls.composeStateProviders).toEqual([
			["ACTIONS", "RECENT_MESSAGES"],
		]);

		expect(calls.alwaysAfter).toHaveLength(1);
		expect(calls.alwaysAfter[0].mode).toBe("ALWAYS_AFTER");
		expect(calls.alwaysAfter[0].didRespond).toBe(true);

		expect(calls.reportedErrors).toEqual([
			{ scope: "EvaluatorService.postTurn", error: expect.any(Error) },
		]);
	});

	it("routes STOP through the excluded hook without invoking the callback", async () => {
		const { runtime, calls } = makeRuntime();
		const callback = recordingCallback(calls);
		const message = autonomyMessage();

		await runAutonomyPostResponse(
			runtime,
			message,
			{
				text: "stopping now",
				actions: ["stop"],
			},
			callback,
		);

		expect(calls.hooks).toHaveLength(1);
		expect(calls.hooks[0].info.source).toBe("excluded");

		expect(calls.callbacks).toHaveLength(0);

		expect(calls.memories).toHaveLength(1);
		expect(calls.memories[0].memory.content.text).toBe("stopping now");

		expect(calls.alwaysAfter).toHaveLength(1);
		expect(calls.alwaysAfter[0].didRespond).toBe(true);

		const silentStop = makeRuntime();
		await runAutonomyPostResponse(silentStop.runtime, message, {
			text: "",
			actions: ["stop"],
		});
		expect(silentStop.calls.alwaysAfter[0].didRespond).toBe(false);
	});

	it("normalizes comma-string actions and filters non-string providers", async () => {
		const { runtime, calls } = makeRuntime();
		const message = autonomyMessage();

		await runAutonomyPostResponse(runtime, message, {
			actions: " reply , , ",
			providers: [1, "provX", null],
		});

		const saved = calls.memories[0].memory;
		expect(saved.content.actions).toEqual(["reply"]);
		expect(saved.content.providers).toEqual(["provX"]);
	});

	it("defaults empty fields to IGNORE and still runs the post-turn bookkeeping", async () => {
		const { runtime, calls } = makeRuntime();
		const message = autonomyMessage();

		await runAutonomyPostResponse(runtime, message, {});

		const saved = calls.memories[0].memory;
		expect(saved.content.actions).toEqual(["IGNORE"]);
		expect(saved.content.providers).toEqual([]);
		expect(saved.content.text).toBe("");
		expect(saved.content.thought).toBe("");

		expect(calls.hooks).toHaveLength(0);
		expect(calls.callbacks).toHaveLength(0);

		expect(calls.alwaysAfter).toHaveLength(1);
		expect(calls.alwaysAfter[0].didRespond).toBe(false);
	});

	it("executes planned actions through the runtime action list", async () => {
		const handlerRuns: Array<{ message: Memory }> = [];
		const pingAction = {
			name: "ping",
			description: "probe action for the facade harness",
			validate: async () => true,
			handler: async (_runtime: IAgentRuntime, message: Memory) => {
				handlerRuns.push({ message });
				return { success: true, text: "pong", data: {} };
			},
		};
		const { runtime, calls } = makeRuntime({ actions: [pingAction] });
		const message = autonomyMessage();

		await runAutonomyPostResponse(runtime, message, { actions: ["ping"] });

		expect(handlerRuns).toHaveLength(1);
		expect(handlerRuns[0].message).toBe(message);

		expect(calls.memories).toHaveLength(1);
		expect(calls.memories[0].memory.content.actions).toEqual(["ping"]);

		expect(calls.alwaysAfter).toHaveLength(1);
		expect(calls.alwaysAfter[0].didRespond).toBe(true);
	});

	it("omits inReplyTo when the autonomous prompt carries no id", async () => {
		const { runtime, calls } = makeRuntime();
		const message = autonomyMessage({ id: undefined }) as Memory;

		await runAutonomyPostResponse(runtime, message, {
			text: "standalone reply",
			actions: ["reply"],
		});

		const saved = calls.memories[0].memory;
		expect(saved.content.inReplyTo).toBeUndefined();
	});

	it("counts blank text with IGNORE as not responded and unknown actions without text as responded", async () => {
		const blank = makeRuntime();
		await runAutonomyPostResponse(blank.runtime, autonomyMessage(), {
			text: "   ",
			actions: ["IGNORE"],
		});
		expect(blank.calls.alwaysAfter[0].didRespond).toBe(false);

		const acted = makeRuntime();
		await runAutonomyPostResponse(acted.runtime, autonomyMessage(), {
			text: "",
			actions: ["mystery"],
		});
		expect(acted.calls.alwaysAfter[0].didRespond).toBe(true);
	});
});
