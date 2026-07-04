/**
 * Regression tests for plugin-lifecycle access stamping. (#12089): an action's
 * effective role gate must resolve plugin-registered contexts through the
 * PER-RUNTIME context registry, so a context registered at runtime via
 * `runtime.contexts.register(...)` with `roleGate.minRole = OWNER` participates
 * in the gate — deriving from a module-level snapshot of only the first-party
 * defaults would collapse the effective gate to USER, a permission bypass.
 * (#13203): provider registration materializes `contexts` for gate-only
 * declarations from the gate's anyOf surface (not the `["general"]` default,
 * which inverts the declared routing) and one-time-warns on the silent general
 * fallback. Deterministic: a hand-built lifecycle runtime driven through the
 * planned-tool-call gate, no live model or database.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	_resetProviderContextWarningsForTests,
	installRuntimePluginLifecycle,
} from "./plugin-lifecycle";
import { ContextRegistry } from "./runtime/context-registry";
import {
	_resetActionRolePolicyCacheForTests,
	executePlannedToolCall,
} from "./runtime/execute-planned-tool-call";
import type { Action, IAgentRuntime, Memory, Provider, UUID } from "./types";

const noop = () => undefined;

function makeLifecycleRuntime(contexts: ContextRegistry): IAgentRuntime & {
	actions: Action[];
	providers: Provider[];
	logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} {
	const runtime = {
		agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
		actions: [] as Action[],
		providers: [] as Provider[],
		contexts,
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		registerAction(action: Action) {
			runtime.actions.push(action);
		},
		registerPlugin: async () => undefined,
		registerProvider(provider: Provider) {
			runtime.providers.push(provider);
		},
		registerEvaluator: noop,
		registerShortcut: noop,
		registerModel: noop,
		registerEvent: noop,
		registerService: async () => undefined,
		registerDatabaseAdapter: noop,
	};
	return runtime as unknown as IAgentRuntime & {
		actions: Action[];
		providers: Provider[];
		logger: { debug: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
	};
}

function provider(overrides: Partial<Provider> & { name: string }): Provider {
	return {
		description: "test provider",
		get: async () => ({ text: "" }),
		...overrides,
	} as Provider;
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

describe("provider context materialization at registration (#13203)", () => {
	afterEach(() => {
		_resetProviderContextWarningsForTests();
	});

	function registeredProvider(
		runtime: ReturnType<typeof makeLifecycleRuntime>,
		name: string,
	): Provider | undefined {
		return runtime.providers.find((p) => p.name === name);
	}

	it("materializes a gate-only provider from its gate's anyOf surface, not [general]", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(
			provider({
				name: "WALLET_GATED_SIGNAL",
				contextGate: { anyOf: ["wallet"] },
			}),
		);

		expect(
			registeredProvider(runtime, "WALLET_GATED_SIGNAL")?.contexts,
		).toEqual(["wallet"]);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("materializes an allOf-only gate from its allOf terms", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(
			provider({
				name: "WALLET_AND_CODE_SIGNAL",
				contextGate: { allOf: ["wallet", "code"] },
			}),
		);

		expect(
			registeredProvider(runtime, "WALLET_AND_CODE_SIGNAL")?.contexts,
		).toEqual(["wallet", "code"]);
	});

	it("keeps a declared-contexts provider untouched (hot-path parity)", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(
			provider({ name: "DECLARED_SIGNAL", contexts: ["documents"] }),
		);

		expect(registeredProvider(runtime, "DECLARED_SIGNAL")?.contexts).toEqual([
			"documents",
		]);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("resolves an undeclared cataloged provider through the catalog without a warning", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(provider({ name: "AVAILABLE_AGENTS" }));

		expect(registeredProvider(runtime, "AVAILABLE_AGENTS")?.contexts).toEqual([
			"code",
			"automation",
		]);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("defaults an undeclared uncataloged provider to [general] with a one-time warning", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(provider({ name: "NOISY_PLUGIN_SIGNAL" }));
		expect(
			registeredProvider(runtime, "NOISY_PLUGIN_SIGNAL")?.contexts,
		).toEqual(["general"]);
		expect(runtime.logger.warn).toHaveBeenCalledTimes(1);
		const [context, message] = runtime.logger.warn.mock.calls[0] as [
			Record<string, unknown>,
			string,
		];
		expect(context.provider).toBe("NOISY_PLUGIN_SIGNAL");
		expect(message).toContain("[PluginLifecycle]");

		// Re-registering the same provider name must not warn again.
		runtime.registerProvider(provider({ name: "NOISY_PLUGIN_SIGNAL" }));
		expect(runtime.logger.warn).toHaveBeenCalledTimes(1);
	});

	it("does not warn for dynamic or always-on undeclared providers", () => {
		const runtime = makeLifecycleRuntime(new ContextRegistry());
		installRuntimePluginLifecycle(runtime);

		runtime.registerProvider(
			provider({ name: "DYNAMIC_UNDECLARED", dynamic: true }),
		);
		runtime.registerProvider(
			provider({ name: "ALWAYS_ON_UNDECLARED", alwaysInResponseState: true }),
		);

		expect(registeredProvider(runtime, "DYNAMIC_UNDECLARED")?.contexts).toEqual(
			["general"],
		);
		expect(
			registeredProvider(runtime, "ALWAYS_ON_UNDECLARED")?.contexts,
		).toEqual(["general"]);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});
});
