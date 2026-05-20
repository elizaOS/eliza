/**
 * Build the {@link WorkerAnnouncePluginMessage.descriptor} payload from
 * the author's Plugin object.
 *
 * The descriptor is a JSON-safe copy of the Plugin where every function
 * value is replaced by a `{ rpc: true, id: <stable-id> }` tag. The host
 * uses the tags as the `target` in subsequent `worker-rpc` invocations.
 *
 * The mapping of `id → handler` is kept in a per-worker
 * {@link HandlerRegistry} so the dispatcher can resolve incoming
 * worker-rpc calls back to the live function.
 */

import type {
	JsonObject,
	JsonValue,
	PluginSurfaceKind,
	RemoteFunctionRef,
} from "@elizaos/plugin-remote-manifest";

/** Live handler registered by the descriptor builder. */
export type AnyHandler = (...args: unknown[]) => unknown;

/** Mapping from rpc.id → live handler, plus its surface kind for routing. */
export interface HandlerRegistry {
	get(id: string): HandlerEntry | undefined;
	set(id: string, entry: HandlerEntry): void;
	clear(): void;
	readonly size: number;
}

export interface HandlerEntry {
	id: string;
	surface: PluginSurfaceKind;
	/** Surface-specific target name (action name, service.method, etc.). */
	target: string;
	handler: AnyHandler;
}

export function createHandlerRegistry(): HandlerRegistry {
	const inner = new Map<string, HandlerEntry>();
	return {
		get: (id) => inner.get(id),
		set: (id, entry) => {
			inner.set(id, entry);
		},
		clear: () => inner.clear(),
		get size() {
			return inner.size;
		},
	};
}

/** Plugin object as seen by the worker bootstrap (loose typing to avoid pulling in @elizaos/core internals here). */
export type WorkerPluginShape = {
	name: string;
	description?: string;
	mode?: "direct" | "remote";
	priority?: number;
	dependencies?: string[];
	config?: Record<string, JsonValue>;
	schema?: Record<string, JsonValue>;
	actions?: Array<{
		name: string;
		similes?: string[];
		description?: string;
		examples?: JsonValue;
		validate?: AnyHandler;
		handler: AnyHandler;
	}>;
	providers?: Array<{
		name: string;
		description?: string;
		dynamic?: boolean;
		position?: number;
		private?: boolean;
		get: AnyHandler;
	}>;
	services?: Array<unknown>;
	models?: Record<string, AnyHandler>;
	events?: Record<string, Array<AnyHandler>>;
	routes?: Array<{
		type?: string;
		name?: string;
		path: string;
		public?: boolean;
		isMultipart?: boolean;
		routeHandler?: AnyHandler;
	}>;
	views?: Array<JsonValue>;
	widgets?: Array<JsonValue>;
	componentTypes?: Array<JsonValue>;
	evaluators?: Array<{
		name: string;
		description?: string;
		validate?: AnyHandler;
		handler: AnyHandler;
	}>;
	init?: AnyHandler;
	[key: string]: unknown;
};

/**
 * Walk `plugin`, allocate a stable id for each function, register the
 * handler, and return a JSON descriptor with `{ rpc: true, id }` in
 * lieu of each function.
 */
export function buildAnnounceDescriptor(
	plugin: WorkerPluginShape,
	registry: HandlerRegistry,
): JsonObject {
	let counter = 0;
	const allocId = (kind: PluginSurfaceKind, target: string): string => {
		counter += 1;
		return `${kind}:${target}:${counter}`;
	};

	const refOf = (
		fn: AnyHandler,
		surface: PluginSurfaceKind,
		target: string,
	): RemoteFunctionRef => {
		const id = allocId(surface, target);
		registry.set(id, { id, surface, target, handler: fn });
		return { rpc: true, id };
	};

	const descriptor: JsonObject = {
		name: plugin.name,
		mode: "remote",
	};
	if (plugin.description) descriptor.description = plugin.description;
	if (plugin.priority !== undefined) descriptor.priority = plugin.priority;
	if (plugin.dependencies) descriptor.dependencies = plugin.dependencies;
	if (plugin.config) descriptor.config = plugin.config as JsonValue;
	if (plugin.schema) descriptor.schema = plugin.schema as JsonValue;

	if (plugin.actions?.length) {
		descriptor.actions = plugin.actions.map((action) => {
			const entry: JsonObject = {
				name: action.name,
				handler: refOf(action.handler, "action", action.name) as unknown as JsonValue,
			};
			if (action.similes) entry.similes = action.similes;
			if (action.description) entry.description = action.description;
			if (action.examples !== undefined) entry.examples = action.examples;
			if (action.validate) {
				entry.validate = refOf(
					action.validate,
					"action",
					`${action.name}.validate`,
				) as unknown as JsonValue;
			}
			return entry;
		});
	}

	if (plugin.providers?.length) {
		descriptor.providers = plugin.providers.map((provider) => {
			const entry: JsonObject = {
				name: provider.name,
				get: refOf(provider.get, "provider", provider.name) as unknown as JsonValue,
			};
			if (provider.description) entry.description = provider.description;
			if (provider.dynamic !== undefined) entry.dynamic = provider.dynamic;
			if (provider.position !== undefined) entry.position = provider.position;
			if (provider.private !== undefined) entry.private = provider.private;
			return entry;
		});
	}

	if (plugin.models) {
		const modelDescriptor: JsonObject = {};
		for (const [modelType, fn] of Object.entries(plugin.models)) {
			modelDescriptor[modelType] = refOf(
				fn,
				"model",
				modelType,
			) as unknown as JsonValue;
		}
		descriptor.models = modelDescriptor;
	}

	if (plugin.events) {
		const eventDescriptor: JsonObject = {};
		for (const [eventName, handlers] of Object.entries(plugin.events)) {
			eventDescriptor[eventName] = handlers.map((handler, index) =>
				refOf(handler, "event", `${eventName}#${index}`) as unknown as JsonValue,
			);
		}
		descriptor.events = eventDescriptor;
	}

	if (plugin.evaluators?.length) {
		descriptor.evaluators = plugin.evaluators.map((evaluator) => {
			const entry: JsonObject = {
				name: evaluator.name,
				handler: refOf(
					evaluator.handler,
					"evaluator",
					evaluator.name,
				) as unknown as JsonValue,
			};
			if (evaluator.description) entry.description = evaluator.description;
			if (evaluator.validate) {
				entry.validate = refOf(
					evaluator.validate,
					"evaluator",
					`${evaluator.name}.validate`,
				) as unknown as JsonValue;
			}
			return entry;
		});
	}

	if (plugin.routes?.length) {
		descriptor.routes = plugin.routes.map((route) => {
			const entry: JsonObject = {
				path: route.path,
			};
			if (route.type) entry.type = route.type;
			if (route.name) entry.name = route.name;
			if (route.public !== undefined) entry.public = route.public;
			if (route.isMultipart !== undefined) entry.isMultipart = route.isMultipart;
			if (route.routeHandler) {
				entry.routeHandler = refOf(
					route.routeHandler,
					"route",
					`${route.type ?? "GET"} ${route.path}`,
				) as unknown as JsonValue;
			}
			return entry;
		});
	}

	// JSON-only metadata fields: copy through unchanged.
	if (plugin.views) descriptor.views = plugin.views as JsonValue;
	if (plugin.widgets) descriptor.widgets = plugin.widgets as JsonValue;
	if (plugin.componentTypes) {
		descriptor.componentTypes = plugin.componentTypes as JsonValue;
	}

	return descriptor;
}
