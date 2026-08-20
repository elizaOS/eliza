/**
 * MANAGE_PLUGINS subaction routing (post-`resolveActionArgs` migration).
 *
 * The umbrella action used to pick its subaction by regex-matching the user's
 * natural-language `message.content.text` (the `inferMode` keyword heuristic).
 * That decided agent behavior off free-form English — the i18n smell. Routing
 * now goes through the shared `resolveActionArgs` substrate:
 *
 *   1. Structured planner/programmatic `action` enum (incl. the legacy `mode`
 *      alias + normalization aliases) → dispatch directly, no model call.
 *   2. Otherwise a single `TEXT_LARGE` extraction pass over the registered
 *      subactions, with machine-parsed plugin identifiers / queries seeded into
 *      the resolver params so the required fields resolve.
 *
 * These tests drive the real handler with a stubbed `plugin_manager` service
 * and a deterministic mock `useModel`, asserting both paths route correctly and
 * that the no-match case degrades to a structured clarification.
 */

import { describe, expect, it, vi } from "vitest";
import { hardenIncomingUserMessage } from "../../security/incoming-message-security.ts";
import type { HandlerCallback } from "../../types/components.ts";
import type { Memory } from "../../types/memory.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { createPluginAction } from "./actions/plugin.ts";

interface StubServiceCalls {
	installed: string[];
}

function createStubPluginManager(calls: StubServiceCalls) {
	return {
		getAllPlugins: () => [{ name: "plugin-manager", status: "LOADED" }],
		listInstalledPlugins: async () => [],
		listEjectedPlugins: async () => [],
		searchRegistry: async () => [],
		installPlugin: async (name: string) => {
			calls.installed.push(name);
			return {
				success: true,
				pluginName: name,
				version: "1.0.0",
				installPath: `/plugins/installed/${name}`,
				requiresRestart: true,
			};
		},
	};
}

function createRuntime(opts: {
	calls: StubServiceCalls;
	useModel?: ReturnType<typeof vi.fn>;
}): IAgentRuntime {
	const service = createStubPluginManager(opts.calls);
	return {
		agentId: "agent-id",
		getService: (name: string) => (name === "plugin_manager" ? service : null),
		useModel: opts.useModel ?? vi.fn(),
		logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
	} as unknown as IAgentRuntime;
}

function createMessage(text: string): Memory {
	return {
		id: "message-id",
		agentId: "agent-id",
		entityId: "user-id",
		roomId: "room-id",
		content: { text },
	} as Memory;
}

/**
 * A message as a hardened connector delivers it: content.text wrapped in
 * core's external-content security envelope with the user's sentence as
 * payload and `externalContentWrapped` stamped.
 */
function createHardenedMessage(text: string): Memory {
	const memory = {
		id: "message-id",
		agentId: "agent-id",
		entityId: "user-id",
		roomId: "room-id",
		content: { text, source: "discord" },
	} as Memory;
	hardenIncomingUserMessage(memory);
	return memory;
}

// Owner gate is exercised elsewhere; bypass it so these tests isolate routing.
const action = createPluginAction({
	hasOwnerAccess: async () => true,
	repoRoot: "/repo",
});

describe("MANAGE_PLUGINS subaction routing", () => {
	it("routes a structured planner `action` enum directly without a model call", async () => {
		const calls: StubServiceCalls = { installed: [] };
		const useModel = vi.fn();
		const runtime = createRuntime({ calls, useModel });
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = await action.handler?.(
			runtime,
			createMessage("(structured call)"),
			undefined,
			{ parameters: { action: "list" } },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(useModel).not.toHaveBeenCalled();
		expect(replies.join("\n")).toContain("Loaded plugins");
	});

	it("normalizes the legacy `mode` alias (installed -> list) with no model call", async () => {
		const calls: StubServiceCalls = { installed: [] };
		const useModel = vi.fn();
		const runtime = createRuntime({ calls, useModel });
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = await action.handler?.(
			runtime,
			createMessage("(structured call)"),
			undefined,
			{ parameters: { mode: "installed" } },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(useModel).not.toHaveBeenCalled();
		expect(replies.join("\n")).toContain("Loaded plugins");
	});

	it("routes a natural-language install via the LLM extraction pass, seeding the parsed plugin name", async () => {
		const calls: StubServiceCalls = { installed: [] };
		// The single TEXT_LARGE extraction call chooses `install`; the resolver
		// already received the machine-parsed `name` seeded from the text, so the
		// model only needs to pick the subaction.
		const useModel = vi.fn(async () =>
			JSON.stringify({
				action: "install",
				params: {},
				missing: [],
				confidence: 0.95,
			}),
		);
		const runtime = createRuntime({ calls, useModel });
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = await action.handler?.(
			runtime,
			createMessage("please install @elizaos/plugin-discord for me"),
			undefined,
			undefined,
			callback,
		);

		expect(result?.success, replies.join("\n")).toBe(true);
		expect(useModel).toHaveBeenCalledTimes(1);
		// The machine-parsed identifier reached the install handler.
		expect(calls.installed).toEqual(["@elizaos/plugin-discord"]);
	});

	it("degrades to a structured clarification when the request matches no subaction", async () => {
		const calls: StubServiceCalls = { installed: [] };
		const useModel = vi.fn(async () =>
			JSON.stringify({
				action: null,
				params: {},
				missing: ["action"],
				confidence: 0.1,
			}),
		);
		const runtime = createRuntime({ calls, useModel });
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = (await action.handler?.(
			runtime,
			createMessage("what is the weather today?"),
			undefined,
			undefined,
			callback,
		)) as { success: boolean; data?: { action?: string } };

		expect(result?.success).toBe(false);
		expect(result?.data?.action).toBe("clarify");
		expect(calls.installed).toHaveLength(0);
		// Planner-facing contract: the clarification rides the result; no
		// visible callback fires (the evaluator voices the question).
		expect(replies).toHaveLength(0);
		expect(String(result?.data?.action)).toBe("clarify");
	});
	it.each([
		["a valid numeric string", "0.8", true],
		["a malformed numeric string", "0.8oops", false],
	])("handles  StubServiceCalls = { installed: [] };
		const useModel = vi.fn(async () =>
			JSON.stringify({ action: "list", params: {}, missing: [], confidence }),
		);
		const runtime = createRuntime({ calls, useModel });
		const result = await action.handler?.(
			runtime,
			createMessage("show installed plugins"),
			undefined,
			undefined,
			async () => [],
		);

		expect(result?.success).toBe(succeeds);
		expect(calls.installed).toHaveLength(succeeds ? 1 : 0);
	});

});

describe("MANAGE_PLUGINS search on hardened messages (envelope echo regression)", () => {
	it("seeds the search query from the user's words, not the security envelope", async () => {
		const calls: StubServiceCalls = { installed: [] };
		const runtime = createRuntime({ calls });
		const message = createHardenedMessage("find plugins for solana wallets");
		// Sanity: the fixture really is the wrapped envelope.
		expect(message.content.text).toContain("SECURITY NOTICE");
		expect(message.content.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = await action.handler?.(
			runtime,
			message,
			undefined,
			{ parameters: { action: "search" } },
			callback,
		);

		const visible = `${replies.join("\n")}\n${String(result?.userFacingText ?? "")}`;
		expect(visible).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(visible).not.toContain("SECURITY NOTICE");
		expect(visible).toContain("solana wallets");
		expect(String(result?.text ?? "").length).toBeLessThan(300);
	});

	it("keeps the raw-text query fallback envelope-free when no query pattern matches", async () => {
		const calls: StubServiceCalls = { installed: [] };
		const runtime = createRuntime({ calls });
		// No "find plugins for …" shape → dispatch falls back to the message
		// text itself as the query; it must be the unwrapped user sentence.
		const message = createHardenedMessage("solana wallets please");
		const replies: string[] = [];
		const callback: HandlerCallback = async (content) => {
			if (typeof content.text === "string") replies.push(content.text);
			return [];
		};

		const result = await action.handler?.(
			runtime,
			message,
			undefined,
			{ parameters: { action: "search" } },
			callback,
		);

		const visible = `${replies.join("\n")}\n${String(result?.userFacingText ?? "")}`;
		expect(visible).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
		expect(visible).not.toContain("SECURITY NOTICE");
		expect(visible).toContain('"solana wallets please"');
		expect(String(result?.text ?? "").length).toBeLessThan(300);
	});
});
