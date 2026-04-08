import { describe, expect, it, vi } from "vitest";
import {
	installRuntimePluginLifecycle,
	supportsRuntimePluginLifecycle,
} from "../plugin-lifecycle";
import { AgentRuntime } from "../runtime";
import type { Character, IAgentRuntime, Plugin, Service } from "../types";

type RuntimeServiceClass = NonNullable<Plugin["services"]>[number];

type MockRuntime = IAgentRuntime & {
	models: Map<
		string,
		Array<{
			handler: (
				runtime: unknown,
				params: Record<string, unknown>,
			) => Promise<unknown>;
			provider: string;
			priority?: number;
			registrationOrder?: number;
		}>
	>;
	serviceTypes: Map<string, RuntimeServiceClass[]>;
	servicePromises: Map<string, Promise<Service>>;
	servicePromiseHandlers: Map<
		string,
		{ resolve: (service: Service) => void; reject: (error: Error) => void }
	>;
	startingServices: Map<string, Promise<Service | null>>;
	serviceRegistrationStatus: Map<
		string,
		"pending" | "registering" | "registered" | "failed"
	>;
	sendHandlers: Map<string, unknown>;
	_runServiceStart: (
		key: string,
		serviceType: string,
		serviceClass: RuntimeServiceClass,
	) => Promise<Service | null>;
	registerSendHandler: (source: string, handler: unknown) => void;
	registerDatabaseAdapter: (adapter: unknown) => void;
};

function createMockRuntime(): MockRuntime {
	const runtime = {
		agentId: "agent-1",
		character: {
			name: "Test Agent",
			settings: {},
			bio: [],
			lore: [],
			messageExamples: [],
			postExamples: [],
			topics: [],
			adjectives: [],
			style: {},
		},
		enableAutonomy: false,
		initPromise: Promise.resolve(),
		messageService: null,
		providers: [],
		actions: [],
		evaluators: [],
		plugins: [],
		services: new Map(),
		events: {},
		routes: [],
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		stateCache: new Map(),
		adapter: null,
		models: new Map(),
		serviceTypes: new Map(),
		servicePromises: new Map(),
		servicePromiseHandlers: new Map(),
		startingServices: new Map(),
		serviceRegistrationStatus: new Map(),
		sendHandlers: new Map(),
		registerAction(action: unknown) {
			this.actions.push(action as never);
		},
		registerProvider(provider: unknown) {
			this.providers.push(provider as never);
		},
		registerEvaluator(evaluator: unknown) {
			this.evaluators.push(evaluator as never);
		},
		registerEvent(event: string, handler: unknown) {
			if (!this.events[event]) {
				this.events[event] = [];
			}
			this.events[event]?.push(handler as never);
		},
		registerModel(modelType: string, handler: unknown, provider: string) {
			if (!this.models.has(modelType)) {
				this.models.set(modelType, []);
			}
			this.models.get(modelType)?.push({
				handler: handler as never,
				provider,
				registrationOrder: Date.now(),
			});
		},
		async registerService(serviceClass: RuntimeServiceClass) {
			const serviceType = serviceClass.serviceType;
			if (!this.serviceTypes.has(serviceType)) {
				this.serviceTypes.set(serviceType, []);
			}
			this.serviceTypes.get(serviceType)?.push(serviceClass);
			await this._runServiceStart(serviceType, serviceType, serviceClass);
		},
		async _runServiceStart(
			key: string,
			_serviceType: string,
			serviceClass: RuntimeServiceClass,
		) {
			const instance = await serviceClass.start(
				this as unknown as IAgentRuntime,
			);
			if (!this.services.has(key)) {
				this.services.set(key, []);
			}
			this.services.get(key)?.push(instance);
			serviceClass.registerSendHandlers?.(
				this as unknown as IAgentRuntime,
				instance,
			);
			return instance;
		},
		registerSendHandler(source: string, handler: unknown) {
			this.sendHandlers.set(source, handler);
		},
		registerDatabaseAdapter(adapter: unknown) {
			if (!this.adapter) {
				this.adapter = adapter as never;
			}
		},
		async registerPlugin(plugin: Plugin) {
			if (this.plugins.some((existing) => existing.name === plugin.name)) {
				return;
			}
			this.plugins.push(plugin);
			if (plugin.init) {
				await plugin.init({}, this as unknown as IAgentRuntime);
			}
			for (const action of plugin.actions ?? []) {
				this.registerAction(action);
			}
			for (const provider of plugin.providers ?? []) {
				this.registerProvider(provider);
			}
			for (const evaluator of plugin.evaluators ?? []) {
				this.registerEvaluator(evaluator);
			}
			for (const [modelType, handler] of Object.entries(plugin.models ?? {})) {
				this.registerModel(modelType, handler, plugin.name);
			}
			for (const route of plugin.routes ?? []) {
				const routePath = route.path.startsWith("/")
					? route.path
					: `/${route.path}`;
				this.routes.push({
					...route,
					path: `/${plugin.name}${routePath}`,
				});
			}
			for (const [eventName, handlers] of Object.entries(plugin.events ?? {})) {
				for (const handler of handlers ?? []) {
					this.registerEvent(eventName, handler);
				}
			}
			for (const serviceClass of plugin.services ?? []) {
				await this.registerService(serviceClass);
			}
			if (plugin.adapter) {
				const adapter = await plugin.adapter(this.agentId as never, {});
				this.registerDatabaseAdapter(adapter);
			}
		},
	} as unknown as MockRuntime;

	installRuntimePluginLifecycle(runtime);
	return runtime;
}

function createCharacter(name: string): Character {
	return {
		name,
		bio: [],
		lore: [],
		messageExamples: [],
		postExamples: [],
		topics: [],
		adjectives: [],
		knowledge: [],
		plugins: [],
		settings: {},
		secrets: {},
		style: {
			all: [],
			chat: [],
			post: [],
		},
	};
}

describe("installRuntimePluginLifecycle", () => {
	it("tracks plugin-owned runtime state and unloads it cleanly", async () => {
		const runtime = createMockRuntime();
		const serviceStop = vi.fn(async () => undefined);
		const stopRuntime = vi.fn(async () => undefined);
		const dispose = vi.fn(async () => undefined);
		const applyConfig = vi.fn(async () => undefined);

		const sendHandler = vi.fn(async () => undefined);
		const serviceClass: RuntimeServiceClass = {
			serviceType: "demo_service",
			start: vi.fn(async () => ({ stop: serviceStop }) as unknown as Service),
			stopRuntime,
			registerSendHandlers: (rt) => {
				(rt as unknown as MockRuntime).registerSendHandler(
					"demo-source",
					sendHandler,
				);
			},
		};

		const plugin: Plugin = {
			name: "@elizaos/plugin-demo",
			description: "demo",
			actions: [{ name: "DEMO_ACTION" } as never],
			providers: [{ name: "demoProvider" } as never],
			evaluators: [{ name: "demoEvaluator" } as never],
			models: {
				text: async () => ({ ok: true }),
			} as never,
			routes: [
				{
					type: "GET",
					path: "/status",
					handler: async () => undefined,
				},
			],
			events: {
				"demo:event": [async () => undefined],
			},
			services: [serviceClass],
		};

		(
			plugin as Plugin & {
				dispose: typeof dispose;
				applyConfig: typeof applyConfig;
			}
		).dispose = dispose;
		(
			plugin as Plugin & {
				dispose: typeof dispose;
				applyConfig: typeof applyConfig;
			}
		).applyConfig = applyConfig;

		await runtime.registerPlugin(plugin);

		expect(supportsRuntimePluginLifecycle(runtime)).toBe(true);
		expect(runtime.actions).toHaveLength(1);
		expect(runtime.providers).toHaveLength(1);
		expect(runtime.evaluators).toHaveLength(1);
		expect(runtime.routes).toHaveLength(1);
		expect(runtime.events["demo:event"]).toHaveLength(1);
		expect(runtime.models.get("text")).toHaveLength(1);
		expect(runtime.services.get("demo_service")).toHaveLength(1);
		expect(runtime.sendHandlers.has("demo-source")).toBe(true);
		expect(runtime.getPluginOwnership?.("@elizaos/plugin-demo")).not.toBeNull();

		await expect(
			runtime.applyPluginConfig?.("@elizaos/plugin-demo", {
				DEMO_KEY: "demo-value",
			}),
		).resolves.toBe(true);
		expect(applyConfig).toHaveBeenCalledWith(
			{ DEMO_KEY: "demo-value" },
			runtime,
		);

		await runtime.unloadPlugin?.("@elizaos/plugin-demo");

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(serviceStop).toHaveBeenCalledTimes(1);
		expect(stopRuntime).toHaveBeenCalledTimes(1);
		expect(runtime.actions).toHaveLength(0);
		expect(runtime.providers).toHaveLength(0);
		expect(runtime.evaluators).toHaveLength(0);
		expect(runtime.routes).toHaveLength(0);
		expect(runtime.events["demo:event"]).toBeUndefined();
		expect(runtime.models.get("text")).toBeUndefined();
		expect(runtime.services.get("demo_service")).toBeUndefined();
		expect(runtime.sendHandlers.has("demo-source")).toBe(false);
		expect(runtime.plugins).toHaveLength(0);
		expect(runtime.getPluginOwnership?.("@elizaos/plugin-demo")).toBeNull();
	});

	it("rolls back partial plugin registration when init fails", async () => {
		const runtime = createMockRuntime();
		const failingPlugin: Plugin = {
			name: "@elizaos/plugin-broken",
			description: "broken",
			init: async () => {
				throw new Error("boom");
			},
		};

		await expect(runtime.registerPlugin(failingPlugin)).rejects.toThrow("boom");
		expect(runtime.plugins).toHaveLength(0);
		expect(runtime.getPluginOwnership?.("@elizaos/plugin-broken")).toBeNull();
	});

	it("refuses to unload adapter plugins without a runtime reload", async () => {
		const runtime = createMockRuntime();
		const adapterPlugin: Plugin = {
			name: "@elizaos/plugin-adapter-demo",
			description: "adapter",
			adapter: async () =>
				({
					close: async () => undefined,
				}) as never,
		};

		await runtime.registerPlugin(adapterPlugin);

		await expect(
			runtime.unloadPlugin?.("@elizaos/plugin-adapter-demo"),
		).rejects.toThrow("requires a runtime reload");
	});

	it("inherits plugin contexts for unscoped actions and providers", async () => {
		const runtime = createMockRuntime();

		await runtime.registerPlugin({
			name: "@elizaos/plugin-wallet-demo",
			description: "wallet demo",
			contexts: ["wallet"],
			actions: [{ name: "WALLET_ACTION" } as never],
			providers: [{ name: "walletProvider" } as never],
		});

		expect(runtime.actions[0]).toMatchObject({
			name: "WALLET_ACTION",
			contexts: ["wallet"],
		});
		expect(runtime.providers[0]).toMatchObject({
			name: "walletProvider",
			contexts: ["wallet"],
		});
	});

	it("installs lifecycle methods on real AgentRuntime instances", async () => {
		const runtime = new AgentRuntime({
			character: createCharacter("Lifecycle Test"),
		});
		const dispose = vi.fn(async () => undefined);
		const plugin: Plugin = {
			name: "@elizaos/plugin-real-demo",
			description: "real runtime demo",
			actions: [{ name: "REAL_DEMO_ACTION" } as never],
			dispose,
		};

		await runtime.registerPlugin(plugin);

		expect(supportsRuntimePluginLifecycle(runtime)).toBe(true);
		expect(
			runtime.getPluginOwnership("@elizaos/plugin-real-demo"),
		).not.toBeNull();
		expect(
			runtime.actions.some((action) => action.name === "REAL_DEMO_ACTION"),
		).toBe(true);

		await runtime.unloadPlugin("@elizaos/plugin-real-demo");

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(runtime.getPluginOwnership("@elizaos/plugin-real-demo")).toBeNull();
		expect(
			runtime.actions.some((action) => action.name === "REAL_DEMO_ACTION"),
		).toBe(false);
	});
});
