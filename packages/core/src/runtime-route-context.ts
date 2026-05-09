export interface RuntimeRouteTelemetrySpan {
	success: (meta?: Record<string, unknown>) => void;
	failure: (meta?: Record<string, unknown>) => void;
}

export interface RuntimeRouteTelemetryMeta {
	boundary: string;
	operation: string;
	timeoutMs?: number;
}

export interface RuntimeRouteHostContext<
	TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
	config?: TConfig;
	saveConfig?: (config: TConfig) => void;
	restartRuntime?: (reason: string) => Promise<boolean> | boolean;
	createTelemetrySpan?: (
		meta: RuntimeRouteTelemetryMeta,
	) => RuntimeRouteTelemetrySpan | null | undefined;
}

interface RuntimeRouteHostContextHolder {
	context: RuntimeRouteHostContext | null;
}

const RUNTIME_ROUTE_HOST_CONTEXT_KEY = Symbol.for(
	"elizaos.runtime-route-host-context",
);

function getContextHolder(runtime: object): RuntimeRouteHostContextHolder {
	const target = runtime as Record<PropertyKey, unknown>;
	const existing = target[RUNTIME_ROUTE_HOST_CONTEXT_KEY] as
		| RuntimeRouteHostContextHolder
		| undefined;
	if (existing) return existing;

	const created: RuntimeRouteHostContextHolder = { context: null };
	Object.defineProperty(target, RUNTIME_ROUTE_HOST_CONTEXT_KEY, {
		configurable: true,
		enumerable: false,
		value: created,
		writable: false,
	});
	return created;
}

export function getRuntimeRouteHostContext<
	TConfig extends Record<string, unknown> = Record<string, unknown>,
>(runtime: object | null | undefined): RuntimeRouteHostContext<TConfig> | null {
	if (!runtime) return null;
	return getContextHolder(runtime).context as RuntimeRouteHostContext<TConfig> | null;
}

export function setRuntimeRouteHostContext(
	runtime: object,
	context: RuntimeRouteHostContext | null,
): () => void {
	const holder = getContextHolder(runtime);
	const previous = holder.context;
	holder.context = context;
	return () => {
		holder.context = previous;
	};
}
