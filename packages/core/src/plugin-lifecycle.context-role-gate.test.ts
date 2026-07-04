/**
 * Regression test (#12089): an action's effective role gate must resolve
 * plugin-registered contexts through the PER-RUNTIME context registry, so a
 * context registered at runtime via `runtime.contexts.register(...)` with
 * `roleGate.minRole = OWNER` participates in the gate. Deriving from a
 * module-level snapshot of only the first-party defaults would leave the plugin
 * context invisible and collapse the effective gate to USER — a permission
 * bypass. Deterministic: a hand-built lifecycle runtime driven through the
 * planned-tool-call gate, no live model or database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRuntimePluginLifecycle } from "./plugin-lifecycle";
import { ContextRegistry } from "./runtime/context-registry";
import {
	_resetActionRolePolicyCacheForTests,
	executePlannedToolCall,
} from "./runtime/execute-planned-tool-call";
import type { Action, IAgentRuntime, Memory, UUID } from "./types";

const noop = () => undefined;

function makeLifecycleRuntime(
	contexts: ContextRegistry,
): IAgentRuntime & { actions: Action[] } {
	const runtime = {
		agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
		actions: [] as Action[],
		contexts,
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		registerAction(action: Action) {
			runtime.actions.push(action);
		},
		registerPlugin: async () => undefined,
		registerProvider: noop,
		registerEvaluator: noop,
		registerShortcut: noop,
		registerModel: noop,
		registerEvent: noop,
		registerService: async () => undefined,
		registerDatabaseAdapter: noop,
	};
	return runtime as unknown as IAgentRuntime & { actions: Action[] };
}

function msg(): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b1" as UUID,
		entityId: "00000000-0000-0000-0000-0000000000c1" as UUID,
		roomId: "00000000-0000-0000-0000-0000000000d1" as UUID,
		content: { text: "run it" },
	} as unknown as Memory;
}

describe("action roleGate resolves plugin-registered contexts (#12089)", () => {
	afterEach(() => {
		_resetActionRolePolicyCacheForTests();
	});

	it("derives an OWNER effective roleGate from a plugin-registered context", () => {
		const contexts = new ContextRegistry();
		contexts.register({ id: "plugin_billing", roleGate: { minRole: "OWNER" } });
		const runtime = makeLifecycleRuntime(contexts);
		installRuntimePluginLifecycle(runtime);

		runtime.registerAction({
			name: "REFUND",
			description: "issue a refund",
			contexts: ["plugin_billing"],
			validate: async () => true,
			handler: async () => ({ success: true }),
		});

		const stamped = runtime.actions.find((a) => a.name === "REFUND");
		expect(stamped?.roleGate).toEqual({ minRole: "OWNER" });
	});

	it("blocks a USER but admits an OWNER at the planned-tool-call gate", async () => {
		const contexts = new ContextRegistry();
		contexts.register({ id: "plugin_billing", roleGate: { minRole: "OWNER" } });
		const runtime = makeLifecycleRuntime(contexts);
		installRuntimePluginLifecycle(runtime);

		const handler = vi.fn(async () => ({ success: true }));
		runtime.registerAction({
			name: "REFUND",
			description: "issue a refund",
			contexts: ["plugin_billing"],
			validate: async () => true,
			handler,
		});

		const blocked = await executePlannedToolCall(
			runtime,
			{
				message: msg(),
				activeContexts: ["plugin_billing"],
				userRoles: ["USER"],
			},
			{ name: "REFUND", params: {} },
		);
		expect(blocked.success).toBe(false);
		expect(handler).not.toHaveBeenCalled();

		const allowed = await executePlannedToolCall(
			runtime,
			{
				message: msg(),
				activeContexts: ["plugin_billing"],
				userRoles: ["OWNER"],
			},
			{ name: "REFUND", params: {} },
		);
		expect(allowed.success).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
