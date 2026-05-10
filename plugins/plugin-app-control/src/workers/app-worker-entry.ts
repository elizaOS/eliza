/**
 * @module plugin-app-control/workers/app-worker-entry
 *
 * Bun worker entry point spawned by AppWorkerHostService for apps
 * that declare `isolation: "worker"`. Phase 2.3 surface: dynamically
 * imports the app's plugin module from `workerData.pluginEntryPath`,
 * builds an action registry, and dispatches `invokeAction` requests
 * across the postMessage bridge.
 *
 * Wire format (parentPort messages):
 *
 *   host -> worker:  { id, method: "ping" }                          → { id, ok: true, result: { pong: true, slug, isolation, actions: [...] } }
 *   host -> worker:  { id, method: "echo", params }                  → { id, ok: true, result: params }
 *   host -> worker:  { id, method: "invokeAction", params: {...} }   → { id, ok: true, result } | { id, ok: false, reason }
 *   host -> worker:  { id, method: "shutdown" }                      → exits the worker (no response)
 *   host -> worker:  { id, method: "<unknown>", params }             → { id, ok: false, reason: "unknown method" }
 *
 * `invokeAction` params: { actionName: string, content?: unknown, options?: Record<string, unknown> }
 *
 * The runtime + message + state arguments to the action handler are
 * **stubbed** for Phase 2.3. Actions that need real `IAgentRuntime`
 * methods will fail with "not implemented in worker sandbox" until
 * Phase 2.4 wires the runtime-bridge surface that gates fs/net + a
 * subset of memory/action APIs across the worker boundary.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";

interface WorkerBootData {
	slug: string;
	isolation: "none" | "worker";
	/** Absolute path to the app's plugin entry (a JS or TS module). */
	pluginEntryPath?: string | null;
}

interface RpcRequest {
	id: number;
	method: string;
	params?: unknown;
}

type RpcResponse =
	| { id: number; ok: true; result: unknown }
	| { id: number; ok: false; reason: string };

interface InvokeActionParams {
	actionName: string;
	content?: unknown;
	options?: Record<string, unknown>;
}

interface LoadedAction {
	name: string;
	handler: (...args: any[]) => unknown | Promise<unknown>;
}

if (isMainThread) {
	throw new Error(
		"app-worker-entry must be loaded via new Worker(), not as a main module.",
	);
}

if (!parentPort) {
	throw new Error("app-worker-entry expects parentPort to be defined.");
}

const boot = (workerData ?? {}) as Partial<WorkerBootData>;
const slug = typeof boot.slug === "string" ? boot.slug : "unknown";
const isolation = boot.isolation === "worker" ? "worker" : "none";
const pluginEntryPath =
	typeof boot.pluginEntryPath === "string" ? boot.pluginEntryPath : null;

const actionRegistry = new Map<string, LoadedAction>();

async function loadPlugin(entryPath: string): Promise<{
	loaded: number;
	error?: string;
}> {
	try {
		const mod = (await import(entryPath)) as Record<string, unknown>;
		// Plugins are commonly exported as `default`, `plugin`, or
		// matching the package's name. Be lenient.
		const candidates: unknown[] = [
			mod.default,
			mod.plugin,
			mod.appPlugin,
			mod.sandboxPlugin,
		];
		let plugin: { actions?: LoadedAction[] } | null = null;
		for (const c of candidates) {
			if (
				c &&
				typeof c === "object" &&
				Array.isArray((c as { actions?: unknown }).actions)
			) {
				plugin = c as { actions: LoadedAction[] };
				break;
			}
		}
		if (!plugin) {
			return { loaded: 0, error: "no plugin export found in module" };
		}
		const actions = plugin.actions ?? [];
		for (const action of actions) {
			if (
				action &&
				typeof action === "object" &&
				typeof action.name === "string" &&
				typeof action.handler === "function"
			) {
				actionRegistry.set(action.name, action);
			}
		}
		return { loaded: actionRegistry.size };
	} catch (error) {
		return {
			loaded: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Phase 2.3 stub: worker-side runtime that satisfies the parameter
 * shape of an Action handler but throws on any property access. Phase
 * 2.4 replaces this with a typed RPC proxy back to the host that
 * gates each runtime method against the granted permissions.
 */
function makeRuntimeStub(): unknown {
	return new Proxy(
		{},
		{
			get(_target, prop: string | symbol) {
				if (prop === "then") return undefined; // not a thenable
				throw new Error(
					`runtime.${String(prop)} is not implemented in the worker sandbox (Phase 2.3 stub)`,
				);
			},
		},
	);
}

async function dispatchInvokeAction(
	params: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
	if (
		typeof params !== "object" ||
		params === null ||
		typeof (params as InvokeActionParams).actionName !== "string"
	) {
		return {
			ok: false,
			reason:
				"invokeAction params must be { actionName: string, content?, options? }",
		};
	}
	const { actionName, content, options } = params as InvokeActionParams;
	const action = actionRegistry.get(actionName);
	if (!action) {
		return { ok: false, reason: `unknown action: ${actionName}` };
	}
	try {
		const message = {
			id: `worker-msg-${Date.now()}`,
			content: content ?? {},
		};
		const result = await action.handler(
			makeRuntimeStub(),
			message,
			undefined,
			options ?? {},
		);
		return { ok: true, result };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

type BridgeHandler = (params: unknown) => unknown | Promise<unknown>;

const BRIDGE_METHODS: Record<string, BridgeHandler> = {
	ping: () => ({
		pong: true,
		slug,
		isolation,
		actions: Array.from(actionRegistry.keys()),
	}),
	echo: (params) => params,
};

async function dispatch(req: RpcRequest): Promise<RpcResponse> {
	if (req.method === "shutdown") {
		process.exit(0);
	}
	if (req.method === "invokeAction") {
		const result = await dispatchInvokeAction(req.params);
		if (!result.ok) {
			return { id: req.id, ok: false, reason: result.reason };
		}
		return { id: req.id, ok: true, result: result.result };
	}
	const handler = BRIDGE_METHODS[req.method];
	if (!handler) {
		return {
			id: req.id,
			ok: false,
			reason: `unknown method: ${req.method}`,
		};
	}
	try {
		const result = await handler(req.params);
		return { id: req.id, ok: true, result };
	} catch (error) {
		return {
			id: req.id,
			ok: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

parentPort.on("message", (raw: unknown) => {
	if (
		typeof raw !== "object" ||
		raw === null ||
		typeof (raw as RpcRequest).id !== "number" ||
		typeof (raw as RpcRequest).method !== "string"
	) {
		return;
	}
	const req = raw as RpcRequest;
	void dispatch(req).then((response) => {
		parentPort?.postMessage(response);
	});
});

// Single id=0 ready notification fires once the optional plugin
// import has settled (or immediately if no pluginEntryPath was
// supplied). The host's spawn() resolves on this message and reads
// `actionsLoaded` to verify the dispatch surface is wired.
async function bootSequence() {
	let pluginLoaded = false;
	let actionsLoaded = 0;
	let error: string | undefined;
	if (pluginEntryPath) {
		const result = await loadPlugin(pluginEntryPath);
		actionsLoaded = result.loaded;
		pluginLoaded = !result.error;
		if (result.error) error = result.error;
	}
	parentPort?.postMessage({
		id: 0,
		ok: !error,
		result: {
			ready: true,
			slug,
			pluginLoaded,
			actionsLoaded,
			...(error ? { error } : {}),
		},
		...(error ? { reason: error } : {}),
	});
}

void bootSequence();
