import type {
	Plugin,
	PluginEventRegistration,
	PluginModelRegistration,
	PluginOwnership,
	PluginServiceRegistration,
} from "./types/plugin";
import type { IAgentRuntime } from "./types/runtime";
import type { Service, ServiceTypeName } from "./types/service";
import {
	resolveActionContexts,
	resolveProviderContexts,
} from "./utils/context-catalog";

type RuntimeAction = NonNullable<Plugin["actions"]>[number];
type RuntimeProvider = NonNullable<Plugin["providers"]>[number];
type RuntimeRoute = NonNullable<Plugin["routes"]>[number];
type RuntimeServiceClass = NonNullable<Plugin["services"]>[number];
type RuntimeEventHandler = PluginEventRegistration["handler"];
type RuntimeEventRegistration = PluginEventRegistration;
type RuntimeModelRegistration = PluginModelRegistration;
type RuntimeServiceRegistration = PluginServiceRegistration;

type RuntimeSendHandler = (
	runtime: unknown,
	target: unknown,
	content: unknown,
) => Promise<unknown>;

type PluginDisposeHook = (runtime: IAgentRuntime) => Promise<void> | void;

type PluginApplyConfigHook = (
	config: Record<string, string>,
	runtime: IAgentRuntime,
) => Promise<void> | void;

type RuntimePluginWithLifecycleHooks = Plugin & {
	dispose?: PluginDisposeHook;
	applyConfig?: PluginApplyConfigHook;
};

type RuntimeServiceRegistrationStatus =
	| "pending"
	| "registering"
	| "registered"
	| "failed";

type RuntimeServicePromiseHandler = {
	resolve: (service: Service) => void;
	reject: (error: Error) => void;
};

type RuntimeModelHandlerRecord = {
	handler: (
		runtime: unknown,
		params: Record<string, unknown>,
	) => Promise<unknown>;
	provider: string;
	priority?: number;
	registrationOrder?: number;
};

type RuntimePluginRegistrationCapture = {
	ownership: PluginOwnership;
	adapterBefore: IAgentRuntime["adapter"] | null | undefined;
};

type RuntimePluginServiceStartCapture = {
	pluginName: string;
};

type AsyncContextStorage<T> = {
	run<R>(store: T, callback: () => R): R;
	getStore(): T | undefined;
};

type RuntimeWithPluginLifecycle = IAgentRuntime & {
	__elizaPluginLifecycleInstalled?: boolean;
	__elizaPluginOwnership?: Map<string, PluginOwnership>;
	registerDatabaseAdapter: (adapter: IAgentRuntime["adapter"]) => void;
	unloadPlugin?: (pluginName: string) => Promise<PluginOwnership | null>;
	reloadPlugin?: (plugin: Plugin) => Promise<void>;
	applyPluginConfig?: (
		pluginName: string,
		config: Record<string, string>,
	) => Promise<boolean>;
	getPluginOwnership?: (pluginName: string) => PluginOwnership | null;
	getAllPluginOwnership?: () => PluginOwnership[];
};

type RuntimePrivateState = {
	serviceTypes: Map<ServiceTypeName, RuntimeServiceClass[]>;
	servicePromises: Map<ServiceTypeName, Promise<Service>>;
	servicePromiseHandlers: Map<ServiceTypeName, RuntimeServicePromiseHandler>;
	startingServices: Map<ServiceTypeName, Promise<Service | null>>;
	serviceRegistrationStatus: Map<
		ServiceTypeName,
		RuntimeServiceRegistrationStatus
	>;
	sendHandlers: Map<string, RuntimeSendHandler>;
	models: Map<string, RuntimeModelHandlerRecord[]>;
	_runServiceStart?: (
		key: ServiceTypeName,
		serviceType: string,
		serviceDef: RuntimeServiceClass,
	) => Promise<Service | null>;
	registerSendHandler?: (source: string, handler: RuntimeSendHandler) => void;
};

class StackAsyncContextStorage<T> implements AsyncContextStorage<T> {
	private readonly stack: T[] = [];

	run<R>(store: T, callback: () => R): R {
		this.stack.push(store);
		try {
			return callback();
		} finally {
			this.stack.pop();
		}
	}

	getStore(): T | undefined {
		return this.stack.length > 0
			? this.stack[this.stack.length - 1]
			: undefined;
	}
}

function createAsyncContextStorage<T>(): AsyncContextStorage<T> {
	if (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<T>();
			return {
				run<R>(store: T, callback: () => R): R {
					return storage.run(store, callback);
				},
				getStore(): T | undefined {
					return storage.getStore();
				},
			};
		} catch {
			// AsyncLocalStorage unavailable — fall back to stack storage.
		}
	}

	return new StackAsyncContextStorage<T>();
}

const pluginRegistrationContext =
	createAsyncContextStorage<RuntimePluginRegistrationCapture>();
const pluginServiceStartContext =
	createAsyncContextStorage<RuntimePluginServiceStartCapture>();
const serviceClassOwners = new WeakMap<RuntimeServiceClass, string>();
const INTENTIONAL_MULTI_SERVICE_TYPES = new Set<string>([
	"wallet",
	"lp_pool",
	"token_data",
	"trajectories",
]);

function getServiceClassLabel(serviceClass: RuntimeServiceClass): string {
	return (
		(serviceClass as { name?: string }).name ||
		serviceClass.constructor?.name ||
		"anonymous service class"
	);
}

function warnOnDuplicateServiceTypeRegistration(
	runtime: RuntimeWithPluginLifecycle,
	serviceType: ServiceTypeName | string,
	serviceClass: RuntimeServiceClass,
	existingServiceClasses: RuntimeServiceClass[],
	pluginName?: string,
): void {
	if (
		existingServiceClasses.length === 0 ||
		INTENTIONAL_MULTI_SERVICE_TYPES.has(String(serviceType))
	) {
		return;
	}

	runtime.logger.warn(
		{
			src: "agent",
			agentId: runtime.agentId,
			plugin: pluginName,
			serviceType,
			serviceClass: getServiceClassLabel(serviceClass),
			existingServiceClasses: existingServiceClasses.map((existing) => ({
				serviceClass: getServiceClassLabel(existing),
				plugin: serviceClassOwners.get(existing),
			})),
		},
		"Duplicate serviceType registration can make getService() ambiguous; use a distinct serviceType or getServicesByType()",
	);
}

function getRuntimePrivateState(runtime: IAgentRuntime): RuntimePrivateState {
	return runtime as unknown as RuntimePrivateState;
}

function getPluginOwnershipStore(
	runtime: RuntimeWithPluginLifecycle,
): Map<string, PluginOwnership> {
	if (!runtime.__elizaPluginOwnership) {
		runtime.__elizaPluginOwnership = new Map();
	}
	return runtime.__elizaPluginOwnership;
}

function getOwnershipTarget(
	runtime: RuntimeWithPluginLifecycle,
	pluginName: string,
): PluginOwnership | null {
	const activeCapture = pluginRegistrationContext.getStore();
	if (activeCapture && activeCapture.ownership.pluginName === pluginName) {
		return activeCapture.ownership;
	}
	return getPluginOwnershipStore(runtime).get(pluginName) ?? null;
}

function pushUniqueRef<T extends object>(items: T[], item: T): void {
	if (!items.includes(item)) {
		items.push(item);
	}
}

function pushUniqueString(items: string[], value: string): void {
	if (!items.includes(value)) {
		items.push(value);
	}
}

function inheritPluginContexts<
	T extends {
		contexts?: Plugin["contexts"];
	},
>(component: T, pluginContexts: Plugin["contexts"] | undefined): T {
	if (!pluginContexts?.length || (component.contexts?.length ?? 0) > 0) {
		return component;
	}

	return {
		...component,
		contexts: [...pluginContexts],
	};
}

function applyEffectiveActionContexts(
	action: RuntimeAction,
	pluginContexts: Plugin["contexts"] | undefined,
): RuntimeAction {
	const inherited = inheritPluginContexts(action, pluginContexts);
	if ((inherited.contexts?.length ?? 0) > 0) {
		return inherited;
	}

	if (inherited === action) {
		action.contexts = [...resolveActionContexts(inherited)];
		return action;
	}

	return {
		...inherited,
		contexts: [...resolveActionContexts(inherited)],
	};
}

function applyEffectiveProviderContexts(
	provider: RuntimeProvider,
	pluginContexts: Plugin["contexts"] | undefined,
): RuntimeProvider {
	const inherited = inheritPluginContexts(provider, pluginContexts);
	if ((inherited.contexts?.length ?? 0) > 0) {
		return inherited;
	}

	if (inherited === provider) {
		provider.contexts = [...resolveProviderContexts(inherited)];
		return provider;
	}

	return {
		...inherited,
		contexts: [...resolveProviderContexts(inherited)],
	};
}

function pushUniqueEvent(
	items: RuntimeEventRegistration[],
	next: RuntimeEventRegistration,
): void {
	if (
		items.some(
			(existing) =>
				existing.eventName === next.eventName &&
				existing.handler === next.handler,
		)
	) {
		return;
	}
	items.push(next);
}

function pushUniqueModel(
	items: RuntimeModelRegistration[],
	next: RuntimeModelRegistration,
): void {
	if (
		items.some(
			(existing) =>
				existing.modelType === next.modelType &&
				existing.handler === next.handler &&
				existing.provider === next.provider,
		)
	) {
		return;
	}
	items.push(next);
}

function pushUniqueService(
	items: RuntimeServiceRegistration[],
	next: RuntimeServiceRegistration,
): void {
	if (
		items.some(
			(existing) =>
				existing.serviceType === next.serviceType &&
				existing.serviceClass === next.serviceClass,
		)
	) {
		return;
	}
	items.push(next);
}

function createEmptyOwnership(plugin: Plugin): PluginOwnership {
	return {
		pluginName: plugin.name,
		plugin,
		registeredPlugin: null,
		actions: [],
		providers: [],
		routes: [],
		events: [],
		models: [],
		services: [],
		sendHandlerSources: [],
		hasAdapter: false,
		registeredAt: Date.now(),
	};
}

function removeArrayItemsByReference<T extends object>(
	items: T[],
	owned: T[],
): void {
	if (owned.length === 0 || items.length === 0) return;
	const ownedSet = new Set(owned);
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const current = items[index];
		if (ownedSet.has(current)) {
			items.splice(index, 1);
		}
	}
}

async function stopOwnedServices(
	privateState: RuntimePrivateState,
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
): Promise<void> {
	if (ownership.services.length === 0) return;

	const serviceGroups = new Map<string, RuntimeServiceClass[]>();
	for (const ownedService of ownership.services) {
		const nextGroup = serviceGroups.get(ownedService.serviceType) ?? [];
		nextGroup.push(ownedService.serviceClass);
		serviceGroups.set(ownedService.serviceType, nextGroup);
	}

	for (const [serviceType, ownedClasses] of serviceGroups) {
		const key = serviceType as ServiceTypeName;
		const inFlightStart = privateState.startingServices.get(key);
		if (inFlightStart) {
			await inFlightStart.catch(() => null);
		}

		const currentClasses = privateState.serviceTypes.get(key) ?? [];
		if (currentClasses.length === 0) {
			continue;
		}

		const ownedClassSet = new Set(ownedClasses);
		const removalIndices: number[] = [];
		currentClasses.forEach((serviceClass, index) => {
			if (ownedClassSet.has(serviceClass)) {
				removalIndices.push(index);
			}
		});

		const instances = runtime.services.get(key) ?? [];
		for (const removalIndex of [...removalIndices].sort((a, b) => b - a)) {
			const instance = instances[removalIndex];
			if (instance && typeof instance.stop === "function") {
				await instance.stop();
			}
			instances.splice(removalIndex, 1);
		}

		for (const ownedClass of ownedClasses) {
			if (typeof ownedClass.stopRuntime === "function") {
				await ownedClass.stopRuntime(runtime as unknown as IAgentRuntime);
			}
			serviceClassOwners.delete(ownedClass);
		}

		const remainingClasses = currentClasses.filter(
			(serviceClass) => !ownedClassSet.has(serviceClass),
		);
		if (remainingClasses.length > 0) {
			privateState.serviceTypes.set(key, remainingClasses);
		} else {
			privateState.serviceTypes.delete(key);
		}

		if (instances.length > 0) {
			runtime.services.set(key, instances);
			privateState.serviceRegistrationStatus.set(key, "registered");
		} else {
			runtime.services.delete(key);
			if (remainingClasses.length > 0) {
				privateState.serviceRegistrationStatus.set(key, "pending");
			} else {
				privateState.serviceRegistrationStatus.delete(key);
				privateState.servicePromises.delete(key);
				privateState.servicePromiseHandlers.delete(key);
			}
		}
	}
}

function removeOwnedModels(
	privateState: RuntimePrivateState,
	ownership: PluginOwnership,
): void {
	if (ownership.models.length === 0) return;

	const modelGroups = new Map<string, RuntimeModelRegistration[]>();
	for (const model of ownership.models) {
		const nextGroup = modelGroups.get(model.modelType) ?? [];
		nextGroup.push(model);
		modelGroups.set(model.modelType, nextGroup);
	}

	for (const [modelType, ownedModels] of modelGroups) {
		const currentModels = privateState.models.get(modelType);
		if (!currentModels || currentModels.length === 0) continue;
		const remainingModels = currentModels.filter(
			(candidate) =>
				!ownedModels.some(
					(owned) =>
						owned.handler === candidate.handler &&
						owned.provider === candidate.provider,
				),
		);
		if (remainingModels.length > 0) {
			privateState.models.set(modelType, remainingModels);
		} else {
			privateState.models.delete(modelType);
		}
	}
}

function removeOwnedEvents(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
): void {
	if (ownership.events.length === 0) return;

	const eventGroups = new Map<string, RuntimeEventHandler[]>();
	for (const ownedEvent of ownership.events) {
		const nextGroup = eventGroups.get(ownedEvent.eventName) ?? [];
		nextGroup.push(ownedEvent.handler);
		eventGroups.set(ownedEvent.eventName, nextGroup);
	}

	for (const [eventName, ownedHandlers] of eventGroups) {
		const currentHandlers = runtime.events[eventName];
		if (!currentHandlers || currentHandlers.length === 0) continue;
		const ownedSet = new Set(ownedHandlers);
		const remainingHandlers = currentHandlers.filter(
			(handler) => !ownedSet.has(handler as unknown as RuntimeEventHandler),
		);
		if (remainingHandlers.length > 0) {
			runtime.events[eventName] = remainingHandlers;
		} else {
			delete runtime.events[eventName];
		}
	}
}

function removeOwnedRoutes(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
): void {
	if (ownership.routes.length === 0 || runtime.routes.length === 0) return;
	removeArrayItemsByReference(runtime.routes, ownership.routes);
}

function removeOwnedPlugins(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
): void {
	if (runtime.plugins.length === 0) return;

	const pluginRefs = ownership.registeredPlugin
		? [ownership.registeredPlugin]
		: [];

	if (pluginRefs.length > 0) {
		removeArrayItemsByReference(runtime.plugins, pluginRefs);
	}

	for (let index = runtime.plugins.length - 1; index >= 0; index -= 1) {
		if (runtime.plugins[index]?.name === ownership.pluginName) {
			runtime.plugins.splice(index, 1);
		}
	}
}

function removeOwnedSendHandlers(
	privateState: RuntimePrivateState,
	ownership: PluginOwnership,
): void {
	for (const source of ownership.sendHandlerSources) {
		privateState.sendHandlers.delete(source);
	}
}

function removeOwnedComponents(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
): void {
	removeArrayItemsByReference(runtime.actions, ownership.actions);
	removeArrayItemsByReference(runtime.providers, ownership.providers);
}

async function restoreAdapterIfNeeded(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
	adapterBefore: IAgentRuntime["adapter"] | null | undefined,
): Promise<void> {
	if (!ownership.hasAdapter) return;
	if (runtime.adapter && runtime.adapter !== adapterBefore) {
		const currentAdapter = runtime.adapter as {
			close?: () => Promise<void>;
			stop?: () => Promise<void>;
		};
		if (typeof currentAdapter.close === "function") {
			await currentAdapter.close();
		} else if (typeof currentAdapter.stop === "function") {
			await currentAdapter.stop();
		}
	}

	runtime.adapter = (adapterBefore ?? null) as IAgentRuntime["adapter"];
}

async function teardownPluginOwnership(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
	options?: {
		allowAdapterUnload?: boolean;
		removeOwnership?: boolean;
		adapterBefore?: IAgentRuntime["adapter"] | null | undefined;
	},
): Promise<void> {
	const privateState = getRuntimePrivateState(runtime);
	if (ownership.hasAdapter && !options?.allowAdapterUnload) {
		throw new Error(
			`Plugin "${ownership.pluginName}" provides a database adapter and requires a runtime reload`,
		);
	}

	const errors: Error[] = [];
	const lifecyclePlugin = ownership.registeredPlugin ?? ownership.plugin;
	const disposeHook = (lifecyclePlugin as RuntimePluginWithLifecycleHooks)
		.dispose;

	if (typeof disposeHook === "function") {
		try {
			await disposeHook(runtime);
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}

	try {
		removeOwnedSendHandlers(privateState, ownership);
	} catch (error) {
		errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	try {
		await stopOwnedServices(privateState, runtime, ownership);
	} catch (error) {
		errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	try {
		removeOwnedEvents(runtime, ownership);
		removeOwnedRoutes(runtime, ownership);
		removeOwnedModels(privateState, ownership);
		removeOwnedComponents(runtime, ownership);
		removeOwnedPlugins(runtime, ownership);
	} catch (error) {
		errors.push(error instanceof Error ? error : new Error(String(error)));
	}

	if (ownership.hasAdapter && options?.allowAdapterUnload) {
		try {
			await restoreAdapterIfNeeded(runtime, ownership, options.adapterBefore);
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
		}
	}

	if (options?.removeOwnership !== false) {
		getPluginOwnershipStore(runtime).delete(ownership.pluginName);
	}

	if (errors.length > 0) {
		throw new AggregateError(
			errors,
			`Failed to fully tear down plugin "${ownership.pluginName}"`,
		);
	}
}

function trackRoutesAndPluginRef(
	runtime: RuntimeWithPluginLifecycle,
	ownership: PluginOwnership,
	pluginsBefore: Set<Plugin>,
	routesBefore: Set<RuntimeRoute>,
): void {
	for (const plugin of runtime.plugins) {
		if (!pluginsBefore.has(plugin) && plugin.name === ownership.pluginName) {
			ownership.registeredPlugin = plugin;
			break;
		}
	}

	for (const route of runtime.routes) {
		if (!routesBefore.has(route)) {
			pushUniqueRef(ownership.routes, route);
		}
	}
}

export function installRuntimePluginLifecycle(runtime: IAgentRuntime): void {
	const runtimeWithLifecycle = runtime as RuntimeWithPluginLifecycle;
	if (runtimeWithLifecycle.__elizaPluginLifecycleInstalled) {
		return;
	}

	const privateState = getRuntimePrivateState(runtimeWithLifecycle);
	const originalRegisterPlugin =
		runtimeWithLifecycle.registerPlugin.bind(runtimeWithLifecycle);
	const originalRegisterAction =
		runtimeWithLifecycle.registerAction.bind(runtimeWithLifecycle);
	const originalRegisterProvider =
		runtimeWithLifecycle.registerProvider.bind(runtimeWithLifecycle);
	const originalRegisterModel =
		runtimeWithLifecycle.registerModel.bind(runtimeWithLifecycle);
	const originalRegisterEvent =
		runtimeWithLifecycle.registerEvent.bind(runtimeWithLifecycle);
	const originalRegisterService =
		runtimeWithLifecycle.registerService.bind(runtimeWithLifecycle);
	const originalRegisterDatabaseAdapter =
		runtimeWithLifecycle.registerDatabaseAdapter.bind(runtimeWithLifecycle);
	const originalRegisterSendHandler =
		typeof privateState.registerSendHandler === "function"
			? privateState.registerSendHandler.bind(runtimeWithLifecycle)
			: null;
	const originalRunServiceStart =
		typeof privateState._runServiceStart === "function"
			? privateState._runServiceStart.bind(runtimeWithLifecycle)
			: null;

	runtimeWithLifecycle.registerAction = ((action: RuntimeAction) => {
		const capture = pluginRegistrationContext.getStore();
		const actionsBefore = runtimeWithLifecycle.actions.length;
		originalRegisterAction(
			applyEffectiveActionContexts(action, capture?.ownership.plugin.contexts),
		);
		if (!capture || runtimeWithLifecycle.actions.length <= actionsBefore)
			return;
		for (const registeredAction of runtimeWithLifecycle.actions.slice(
			actionsBefore,
		)) {
			pushUniqueRef(capture.ownership.actions, registeredAction);
		}
	}) as typeof runtimeWithLifecycle.registerAction;

	runtimeWithLifecycle.registerProvider = ((provider: RuntimeProvider) => {
		const capture = pluginRegistrationContext.getStore();
		const providersBefore = runtimeWithLifecycle.providers.length;
		originalRegisterProvider(
			applyEffectiveProviderContexts(
				provider,
				capture?.ownership.plugin.contexts,
			),
		);
		if (!capture || runtimeWithLifecycle.providers.length <= providersBefore)
			return;
		for (const registeredProvider of runtimeWithLifecycle.providers.slice(
			providersBefore,
		)) {
			pushUniqueRef(capture.ownership.providers, registeredProvider);
		}
	}) as typeof runtimeWithLifecycle.registerProvider;

	runtimeWithLifecycle.registerModel = ((
		modelType,
		handler,
		provider,
		priority,
	) => {
		const capture = pluginRegistrationContext.getStore();
		const modelKey = String(modelType);
		const modelsBefore = privateState.models.get(modelKey)?.length ?? 0;
		originalRegisterModel(modelType, handler, provider, priority);
		if (!capture) return;
		const nextModels = privateState.models.get(modelKey) ?? [];
		for (const registeredModel of nextModels.slice(modelsBefore)) {
			pushUniqueModel(capture.ownership.models, {
				modelType: modelKey,
				handler: registeredModel.handler as RuntimeModelRegistration["handler"],
				provider: registeredModel.provider,
			});
		}
	}) as typeof runtimeWithLifecycle.registerModel;

	runtimeWithLifecycle.registerEvent = ((
		event: string,
		handler: RuntimeEventHandler,
	) => {
		const capture = pluginRegistrationContext.getStore();
		const handlersBefore = runtimeWithLifecycle.events[event]?.length ?? 0;
		originalRegisterEvent(event as never, handler as never);
		if (!capture) return;
		const nextHandlers = runtimeWithLifecycle.events[event] ?? [];
		for (const registeredHandler of nextHandlers.slice(handlersBefore)) {
			pushUniqueEvent(capture.ownership.events, {
				eventName: event,
				handler: registeredHandler as unknown as RuntimeEventHandler,
			});
		}
	}) as typeof runtimeWithLifecycle.registerEvent;

	runtimeWithLifecycle.registerService = (async (
		serviceClass: RuntimeServiceClass,
	) => {
		const capture = pluginRegistrationContext.getStore();
		const serviceType = serviceClass.serviceType as ServiceTypeName;
		const existingServiceClasses =
			privateState.serviceTypes.get(serviceType) ?? [];
		warnOnDuplicateServiceTypeRegistration(
			runtimeWithLifecycle,
			serviceType,
			serviceClass,
			existingServiceClasses,
			capture?.ownership.pluginName,
		);
		const serviceTypesBefore = existingServiceClasses.length;
		await originalRegisterService(serviceClass);
		if (!capture) return;
		const nextClasses = privateState.serviceTypes.get(serviceType) ?? [];
		for (const registeredClass of nextClasses.slice(serviceTypesBefore)) {
			serviceClassOwners.set(registeredClass, capture.ownership.pluginName);
			pushUniqueService(capture.ownership.services, {
				serviceType,
				serviceClass: registeredClass,
			});
		}
	}) as typeof runtimeWithLifecycle.registerService;

	runtimeWithLifecycle.registerDatabaseAdapter = ((
		adapter: IAgentRuntime["adapter"],
	) => {
		const capture = pluginRegistrationContext.getStore();
		const adapterBefore = runtimeWithLifecycle.adapter;
		originalRegisterDatabaseAdapter(adapter);
		if (
			capture &&
			runtimeWithLifecycle.adapter &&
			runtimeWithLifecycle.adapter !== adapterBefore
		) {
			capture.ownership.hasAdapter = true;
		}
	}) as typeof runtimeWithLifecycle.registerDatabaseAdapter;

	if (originalRegisterSendHandler) {
		privateState.registerSendHandler = ((source, handler) => {
			const hadSourceAlready = privateState.sendHandlers.has(source);
			originalRegisterSendHandler(source, handler);
			if (hadSourceAlready) return;

			const pluginName =
				pluginServiceStartContext.getStore()?.pluginName ??
				pluginRegistrationContext.getStore()?.ownership.pluginName;
			if (!pluginName) return;
			const ownership = getOwnershipTarget(runtimeWithLifecycle, pluginName);
			if (!ownership) return;
			pushUniqueString(ownership.sendHandlerSources, source);
		}) as typeof privateState.registerSendHandler;
	}

	if (originalRunServiceStart) {
		privateState._runServiceStart = (async (key, serviceType, serviceClass) => {
			const pluginName =
				serviceClassOwners.get(serviceClass) ??
				pluginRegistrationContext.getStore()?.ownership.pluginName;
			if (!pluginName) {
				return await originalRunServiceStart(key, serviceType, serviceClass);
			}
			return await pluginServiceStartContext.run(
				{ pluginName },
				async () =>
					await originalRunServiceStart(key, serviceType, serviceClass),
			);
		}) as typeof privateState._runServiceStart;
	}

	runtimeWithLifecycle.registerPlugin = (async (plugin: Plugin) => {
		const pluginsBefore = new Set(runtimeWithLifecycle.plugins);
		const routesBefore = new Set(runtimeWithLifecycle.routes);
		const capture: RuntimePluginRegistrationCapture = {
			ownership: createEmptyOwnership(plugin),
			adapterBefore: runtimeWithLifecycle.adapter,
		};

		try {
			await pluginRegistrationContext.run(capture, async () => {
				await originalRegisterPlugin(plugin);
			});
			trackRoutesAndPluginRef(
				runtimeWithLifecycle,
				capture.ownership,
				pluginsBefore,
				routesBefore,
			);
			if (
				capture.ownership.registeredPlugin ||
				capture.ownership.actions.length > 0 ||
				capture.ownership.providers.length > 0 ||
				capture.ownership.routes.length > 0 ||
				capture.ownership.events.length > 0 ||
				capture.ownership.models.length > 0 ||
				capture.ownership.services.length > 0 ||
				capture.ownership.sendHandlerSources.length > 0 ||
				capture.ownership.hasAdapter
			) {
				getPluginOwnershipStore(runtimeWithLifecycle).set(
					capture.ownership.pluginName,
					capture.ownership,
				);
			}
		} catch (error) {
			trackRoutesAndPluginRef(
				runtimeWithLifecycle,
				capture.ownership,
				pluginsBefore,
				routesBefore,
			);
			await teardownPluginOwnership(runtimeWithLifecycle, capture.ownership, {
				allowAdapterUnload: true,
				removeOwnership: true,
				adapterBefore: capture.adapterBefore,
			});
			throw error;
		}
	}) as typeof runtimeWithLifecycle.registerPlugin;

	runtimeWithLifecycle.unloadPlugin = async (pluginName: string) => {
		const ownership =
			getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName);
		if (!ownership) {
			return null;
		}
		await teardownPluginOwnership(runtimeWithLifecycle, ownership, {
			removeOwnership: true,
		});
		return ownership;
	};

	runtimeWithLifecycle.reloadPlugin = async (plugin: Plugin) => {
		const existingOwnership = getPluginOwnershipStore(runtimeWithLifecycle).get(
			plugin.name,
		);
		if (existingOwnership) {
			await teardownPluginOwnership(runtimeWithLifecycle, existingOwnership, {
				removeOwnership: true,
			});
		}
		await runtimeWithLifecycle.registerPlugin(plugin);
	};

	runtimeWithLifecycle.applyPluginConfig = async (
		pluginName: string,
		config: Record<string, string>,
	) => {
		const ownership =
			getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName);
		if (!ownership) {
			return false;
		}
		const pluginWithHooks = (ownership.registeredPlugin ??
			ownership.plugin) as RuntimePluginWithLifecycleHooks;
		if (typeof pluginWithHooks.applyConfig !== "function") {
			return false;
		}
		await pluginWithHooks.applyConfig(config, runtimeWithLifecycle);
		return true;
	};

	runtimeWithLifecycle.getPluginOwnership = (pluginName: string) =>
		getPluginOwnershipStore(runtimeWithLifecycle).get(pluginName) ?? null;

	runtimeWithLifecycle.getAllPluginOwnership = () =>
		Array.from(getPluginOwnershipStore(runtimeWithLifecycle).values());

	runtimeWithLifecycle.__elizaPluginLifecycleInstalled = true;
}

export function supportsRuntimePluginLifecycle(
	runtime: IAgentRuntime | null,
): runtime is RuntimeWithPluginLifecycle {
	return Boolean(
		runtime &&
			typeof (runtime as RuntimeWithPluginLifecycle).unloadPlugin ===
				"function" &&
			typeof (runtime as RuntimeWithPluginLifecycle).reloadPlugin ===
				"function" &&
			typeof (runtime as RuntimeWithPluginLifecycle).getPluginOwnership ===
				"function",
	);
}
