import { describe, expect, it, vi } from "vitest";
import { ContextRegistry } from "../runtime/context-registry";
import {
	formatAvailableContextsForPrompt,
	runV5MessageRuntimeStage1,
} from "../services/message";
import type { ContextDefinition } from "../types/contexts";
import type { Memory } from "../types/memory";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

function useModelCalls(runtime: IAgentRuntime): unknown[][] {
	return (runtime.useModel as unknown as { mock: { calls: unknown[][] } }).mock
		.calls;
}

function makeMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: "Hello.",
			source: "test",
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return {
		values: {
			availableContexts: "general, calendar",
		},
		data: {},
		text: "Recent conversation summary",
	};
}

function makeRuntimeWithContexts(
	contexts: readonly ContextDefinition[],
	stage1Response: unknown,
): IAgentRuntime {
	const registry = new ContextRegistry(contexts);
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: { name: "Test Agent", system: "You are concise." },
		actions: [],
		providers: [],
		contexts: registry,
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => stage1Response),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

const FIXTURE_CONTEXTS: readonly ContextDefinition[] = [
	{
		id: "general",
		label: "General",
		description: "Normal conversation.",
	},
	{
		id: "calendar",
		label: "Calendar",
		description: "Manage calendar events.",
		roleGate: { minRole: "ADMIN" },
	},
	{
		id: "wallet",
		label: "Wallet",
		description: "Crypto wallet ops.",
		roleGate: { minRole: "OWNER" },
	},
	{
		id: "memory",
		label: "Memory",
		description: "Long-term agent memory.",
		roleGate: { minRole: "USER" },
	},
];

describe("formatAvailableContextsForPrompt", () => {
	it("renders id and description per line", () => {
		const block = formatAvailableContextsForPrompt(FIXTURE_CONTEXTS);
		expect(block).toContain("- general: Normal conversation.");
		expect(block).toContain("- calendar: Manage calendar events.");
		expect(block).toContain("- memory: Long-term agent memory.");
	});

	it("falls back to a placeholder when no contexts are registered", () => {
		expect(formatAvailableContextsForPrompt([])).toBe(
			"(no contexts registered)",
		);
	});
});

describe("Stage 1 prompt — available contexts catalog", () => {
	it("includes USER-accessible contexts and excludes OWNER-only contexts for a USER sender", async () => {
		const runtime = makeRuntimeWithContexts(
			FIXTURE_CONTEXTS,
			JSON.stringify({
				action: "RESPOND",
				simple: true,
				contexts: [],
				thought: "Direct answer.",
				reply: "Hello.",
			}),
		);

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as
			| { messages?: Array<{ role?: string; content?: string }> }
			| undefined;
		const systemContent = params?.messages?.[0]?.content ?? "";

		expect(systemContent).toContain("available_contexts:");
		// `general` (no gate) and `memory` (USER) are visible to USER role.
		expect(systemContent).toContain("- general:");
		expect(systemContent).toContain("- memory:");
		// `wallet` (OWNER-only) and `calendar` (ADMIN-only) must NOT appear.
		expect(systemContent).not.toMatch(/^- wallet:/m);
		expect(systemContent).not.toMatch(/^- calendar:/m);
	});

	it("falls back to the placeholder line when no registry is attached", async () => {
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000003" as UUID,
			character: { name: "Test Agent", system: "You are concise." },
			actions: [],
			providers: [],
			contexts: undefined,
			composeState: vi.fn(async () => makeState()),
			runActionsByMode: vi.fn(async () => undefined),
			emitEvent: vi.fn(async () => undefined),
			useModel: vi.fn(async () =>
				JSON.stringify({
					action: "RESPOND",
					simple: true,
					contexts: [],
					thought: "Direct answer.",
					reply: "Hello.",
				}),
			),
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				trace: vi.fn(),
			},
		} as unknown as IAgentRuntime;

		await runV5MessageRuntimeStage1({
			runtime,
			message: makeMessage(),
			state: makeState(),
			responseId: "00000000-0000-0000-0000-000000000005" as UUID,
		});

		const firstCall = useModelCalls(runtime)[0];
		const params = firstCall?.[1] as
			| { messages?: Array<{ role?: string; content?: string }> }
			| undefined;
		const systemContent = params?.messages?.[0]?.content ?? "";
		expect(systemContent).toContain("available_contexts:");
		expect(systemContent).toContain("(no contexts registered)");
	});
});
