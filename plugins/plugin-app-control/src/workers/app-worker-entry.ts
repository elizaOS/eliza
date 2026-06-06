/**
 * @module plugin-app-control/workers/app-worker-entry
 *
 * Bun worker entry point spawned by AppWorkerHostService for apps
 * that declare `isolation: "worker"`. The entry dynamically imports the
 * app's plugin module from `workerData.pluginEntryPath`, builds an action
 * registry, and dispatches `invokeAction` requests across the postMessage
 * bridge.
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
 * The action handler receives a sandbox runtime. Only explicit,
 * host-approved capabilities are exposed: app metadata, gated fs/net,
 * and selected runtime bridge methods. Any other `runtime.*` access is
 * rejected instead of leaking the host runtime into the worker.
 */

import { promises as fsPromises } from "node:fs";
import nodePath from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

interface WorkerBootData {
	slug: string;
	isolation: "none" | "worker";
	/** Runtime agent id, when the host has a real runtime attached. */
	agentId?: string | null;
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

interface RuntimeBridgeResponse {
	id: number;
	bridge: "runtime";
	ok: boolean;
	result?: unknown;
	reason?: string;
}

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
const agentId = typeof boot.agentId === "string" ? boot.agentId : null;
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
	const normalizedHost = hostname.toLowerCase();
	const normalizedPattern = pattern.toLowerCase();
	if (normalizedPattern === "*") return true;
	if (normalizedPattern.startsWith("*.")) {
		const suffix = normalizedPattern.slice(2);
		return normalizedHost.endsWith(`.${suffix}`);
	}
	return normalizedHost === normalizedPattern;
}

function hasDeclaredFsOperation(operation: "read" | "write"): boolean {
	const block = requestedPermissions?.fs;
	if (!block || typeof block !== "object" || Array.isArray(block)) return false;
	const value = (block as { read?: unknown; write?: unknown })[operation];
	return Array.isArray(value);
}

/**
 * Worker-side gated capabilities. Plugins that opt into the sandbox model
 * call `runtime.fetch(...)` and `runtime.fs.readFile(...)` instead of reaching
 * for `globalThis.fetch` / `node:fs` directly.
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
 * The gate is intentionally simple: exact-host or `*.suffix` matching for net,
 * and statePath-prefix containment for fs. The manifest-level `fs.read` and
 * `fs.write` declarations currently authorize the operation class; path
 * narrowing is enforced by the per-app statePath sandbox.
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
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`net access only supports http/https URLs (received ${parsed.protocol})`,
		);
	}
	const allowed = declaredHosts();
	if (!allowed.some((p) => hostMatches(parsed.hostname, p))) {
		throw new Error(
			`net access to ${parsed.hostname} not allowed by manifest (declared outbound: ${allowed.join(", ") || "<none>"})`,
		);
	}
	return fetch(parsed, init);
}

function checkFsAccess(
	absolutePath: string,
	operation: "read" | "write",
): void {
	if (!grantedSet.has("fs")) {
		throw new Error(
			"fs access not granted by user (sandbox: grantedNamespaces does not include 'fs')",
		);
	}
	if (!hasDeclaredFsOperation(operation)) {
		throw new Error(`fs.${operation} access not allowed by manifest`);
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
		checkFsAccess(path, "read");
		return fsPromises.readFile(path, "utf8");
	},
	async writeFile(path: string, content: string): Promise<void> {
		checkFsAccess(path, "write");
		await fsPromises.mkdir(nodePath.dirname(path), { recursive: true });
		await fsPromises.writeFile(path, content, "utf8");
	},
};

interface PendingRuntimeCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

const runtimePending = new Map<number, PendingRuntimeCall>();
let runtimeNextId = 1;

function isRuntimeBridgeResponse(raw: unknown): raw is RuntimeBridgeResponse {
	return (
		typeof raw === "object" &&
		raw !== null &&
		(raw as RuntimeBridgeResponse).bridge === "runtime" &&
		typeof (raw as RuntimeBridgeResponse).id === "number" &&
		typeof (raw as RuntimeBridgeResponse).ok === "boolean"
	);
}

function callRuntimeBridge(
	method: "getMemories",
	params: unknown,
): Promise<unknown> {
	const id = runtimeNextId++;
	return new Promise((resolve, reject) => {
		runtimePending.set(id, { resolve, reject });
		parentPort?.postMessage({
			id,
			bridge: "runtime",
			method,
			params,
		});
	});
}

const actionRegistry = new Map<string, LoadedAction>();

async function loadPlugin(entryPath: string): Promise<{
	loaded: number;
	error?: string;
}> {
	try {
		// On Windows, `import('C:\\foo\\bar.js')` fails with "Only URLs with a
		// scheme in: file, data, and node are supported by the default ESM
		// loader" because absolute Windows paths use a drive-letter prefix
		// that the URL parser treats as scheme `c:`. Route every absolute
		// path through `pathToFileURL` so we always hand the ESM loader a
		// proper `file://` URL on every platform.
		const { pathToFileURL } = await import("node:url");
		const { isAbsolute } = await import("node:path");
		const importTarget = isAbsolute(entryPath)
			? pathToFileURL(entryPath).href
			: entryPath;
		const mod = (await import(importTarget)) as Record<string, unknown>;
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
 * gated capabilities (`fetch`, `fs`, `slug`, `statePath`) and bridge
 * methods (`getMemories`) and throws on any other property access so
 * plugins can't accidentally leak the sandbox by touching an un-gated
 * `runtime.*` member.
 */
function makeSandboxRuntimeFacade(): unknown {
	const exposed: Record<string | symbol, unknown> = {
		slug,
		agentId,
		statePath,
		fetch: gatedFetch,
		fs: gatedFs,
		getMemories: (params: unknown) => callRuntimeBridge("getMemories", params),
	};
	return new Proxy(
		{},
		{
			get(_target, prop: string | symbol) {
				if (prop === "then") return undefined; // not a thenable
				if (prop in exposed) return exposed[prop];
				throw new Error(
					`runtime.${String(prop)} is not exposed in the worker sandbox`,
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
			makeSandboxRuntimeFacade(),
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
	if (isRuntimeBridgeResponse(raw)) {
		const pending = runtimePending.get(raw.id);
		if (!pending) return;
		runtimePending.delete(raw.id);
		if (raw.ok) {
			pending.resolve(raw.result);
		} else {
			pending.reject(
				new Error(raw.reason ?? "runtime bridge call failed with no reason"),
			);
		}
		return;
	}
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
