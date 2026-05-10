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

import { promises as fsPromises } from "node:fs";
import nodePath from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

interface WorkerBootData {
	slug: string;
	isolation: "none" | "worker";
	/** Absolute path to the app's plugin entry (a JS or TS module). */
	pluginEntryPath?: string | null;
	/** Per-app sandbox FS root the worker may read/write under. */
	statePath?: string | null;
	/** Raw `elizaos.app.permissions` block from the manifest. */
	requestedPermissions?: Record<string, unknown> | null;
	/** Subset of recognised namespaces the user has granted. */
	grantedNamespaces?: readonly string[];
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
	// biome-ignore lint/suspicious/noExplicitAny: action handler signature is plugin-defined, only narrowed at the call site
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
const statePath =
	typeof boot.statePath === "string" ? nodePath.resolve(boot.statePath) : null;
const grantedSet = new Set(
	Array.isArray(boot.grantedNamespaces)
		? boot.grantedNamespaces.filter((s): s is string => typeof s === "string")
		: [],
);
const requestedPermissions =
	boot.requestedPermissions &&
	typeof boot.requestedPermissions === "object" &&
	!Array.isArray(boot.requestedPermissions)
		? boot.requestedPermissions
		: null;

function declaredHosts(): string[] {
	const block = requestedPermissions?.net;
	if (!block || typeof block !== "object" || Array.isArray(block)) return [];
	const outbound = (block as { outbound?: unknown }).outbound;
	if (!Array.isArray(outbound)) return [];
	return outbound.filter((v): v is string => typeof v === "string");
}

function hostMatches(hostname: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(2);
		return hostname.endsWith(`.${suffix}`);
	}
	return hostname === pattern;
}

/**
 * Phase 2.4 worker-side gated capabilities. Plugins that opt into the
 * sandbox model call `runtime.fetch(...)` and `runtime.fs.readFile(...)`
 * instead of reaching for `globalThis.fetch` / `node:fs` directly.
 *
 * `runtime.fetch` is allowed iff:
 *   - `grantedNamespaces` includes "net"
 *   - the URL's hostname matches at least one declared
 *     `requestedPermissions.net.outbound` pattern
 *
 * `runtime.fs.readFile` / `writeFile` are allowed iff:
 *   - `grantedNamespaces` includes "fs"
 *   - a `statePath` was assigned at boot
 *   - the resolved absolute path is contained in `statePath`
 *
 * Phase 2.4 keeps the gate dumb on purpose — exact-host or `*.suffix`
 * matching for net, statePath-prefix containment for fs. The full
 * glob-against-`fs.read`/`fs.write` patterns from the manifest land
 * when there's a real third-party app exercising the contract.
 */
async function gatedFetch(
	url: string | URL,
	init?: RequestInit,
): Promise<Response> {
	if (!grantedSet.has("net")) {
		throw new Error(
			"net access not granted by user (sandbox: grantedNamespaces does not include 'net')",
		);
	}
	const parsed = url instanceof URL ? url : new URL(url);
	const allowed = declaredHosts();
	if (!allowed.some((p) => hostMatches(parsed.hostname, p))) {
		throw new Error(
			`net access to ${parsed.hostname} not allowed by manifest (declared outbound: ${allowed.join(", ") || "<none>"})`,
		);
	}
	return fetch(parsed, init);
}

function checkFsAccess(absolutePath: string): void {
	if (!grantedSet.has("fs")) {
		throw new Error(
			"fs access not granted by user (sandbox: grantedNamespaces does not include 'fs')",
		);
	}
	if (!statePath) {
		throw new Error(
			"fs access requires a statePath to be assigned to the app at spawn time",
		);
	}
	const resolved = nodePath.resolve(absolutePath);
	const root = `${statePath}${nodePath.sep}`;
	if (resolved !== statePath && !resolved.startsWith(root)) {
		throw new Error(
			`fs access to ${resolved} escapes the sandbox statePath (${statePath})`,
		);
	}
}

const gatedFs = {
	async readFile(path: string): Promise<string> {
		checkFsAccess(path);
		return fsPromises.readFile(path, "utf8");
	},
	async writeFile(path: string, content: string): Promise<void> {
		checkFsAccess(path);
		await fsPromises.mkdir(nodePath.dirname(path), { recursive: true });
		await fsPromises.writeFile(path, content, "utf8");
	},
};

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
 * Worker-side runtime exposed to action handlers. Selectively returns
 * gated capabilities (`fetch`, `fs`, `slug`, `statePath`) and throws
 * on any other property access so plugins can't accidentally leak
 * the sandbox by touching an un-gated `runtime.*` member.
 */
function makeRuntimeStub(): unknown {
	const exposed: Record<string | symbol, unknown> = {
		slug,
		statePath,
		fetch: gatedFetch,
		fs: gatedFs,
	};
	return new Proxy(
		{},
		{
			get(_target, prop: string | symbol) {
				if (prop === "then") return undefined; // not a thenable
				if (prop in exposed) return exposed[prop];
				throw new Error(
					`runtime.${String(prop)} is not implemented in the worker sandbox (Phase 2 stub)`,
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

type BridgeHandler = (
	params: unknown,
) =>
	| unknown
	| Promise<unknown>
	| { ok: false; reason: string }
	| Promise<{ ok: false; reason: string }>;

const BRIDGE_METHODS: Record<string, BridgeHandler> = {
	ping: () => ({
		pong: true,
		slug,
		isolation,
		actions: Array.from(actionRegistry.keys()),
	}),
	echo: (params) => params,
	invokeAction: (params) => dispatchInvokeAction(params),
};

async function dispatch(req: RpcRequest): Promise<RpcResponse> {
	if (req.method === "shutdown") {
		process.exit(0);
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
		// Bridge handlers can return a structured failure ({ ok: false, reason }).
		if (
			result &&
			typeof result === "object" &&
			(result as { ok?: unknown }).ok === false &&
			typeof (result as { reason?: unknown }).reason === "string"
		) {
			return {
				id: req.id,
				ok: false,
				reason: (result as { reason: string }).reason,
			};
		}
		// invokeAction wraps its success as { ok: true, result }.
		if (
			result &&
			typeof result === "object" &&
			(result as { ok?: unknown }).ok === true &&
			"result" in (result as object)
		) {
			return {
				id: req.id,
				ok: true,
				result: (result as { result: unknown }).result,
			};
		}
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
		ok: error ? false : true,
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
