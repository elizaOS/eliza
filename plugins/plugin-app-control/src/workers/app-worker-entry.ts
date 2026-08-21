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
 * Filesystem operations walk from the canonical sandbox root, reject symlink
 * components, and pin the final file descriptor before reading or writing.
 */

import { constants as fsConstants } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	realpath,
} from "node:fs/promises";
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
	| {
			id: number;
			ok: false;
			reason: string;
			code?: string;
			context?: Record<string, unknown>;
	  };

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

interface RpcFailureFields {
	reason: string;
	code?: string;
	context?: Record<string, unknown>;
}

interface LoadedAction {
	name: string;
	handler: (...args: unknown[]) => unknown | Promise<unknown>;
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

/**
 * Serializable worker-side counterpart to ElizaError. This entry intentionally
 * does not load the full core runtime dependency tree; the host reconstructs an
 * ElizaError from this stable code and context at the RPC boundary.
 */
class SandboxFsError extends Error {
	override readonly name = "SandboxFsError";
	readonly code: string;
	readonly context: Record<string, unknown>;

	constructor(
		message: string,
		code: string,
		context: Record<string, unknown>,
		cause?: unknown,
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
		this.context = context;
	}
}

function errnoCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function fsFailure(
	code: string,
	message: string,
	operation: "read" | "write",
	target?: string,
	cause?: unknown,
): SandboxFsError {
	return new SandboxFsError(
		message,
		code,
		{ operation, statePath, ...(target ? { target } : {}) },
		cause,
	);
}

function relativeSegments(root: string, candidate: string): string[] | null {
	const relative = nodePath.relative(root, candidate);
	if (
		relative === ".." ||
		relative.startsWith(`..${nodePath.sep}`) ||
		nodePath.isAbsolute(relative)
	) {
		return null;
	}
	return relative === "" ? [] : relative.split(nodePath.sep);
}

async function resolveSandboxRoot(
	operation: "read" | "write",
	requestedPath: string,
): Promise<{ root: string; segments: string[] }> {
	if (!statePath) {
		throw fsFailure(
			"APP_WORKER_FS_ROOT_MISSING",
			"fs access requires a statePath to be assigned to the app at spawn time",
			operation,
			requestedPath,
		);
	}
	const resolved = nodePath.resolve(requestedPath);
	const segments = relativeSegments(statePath, resolved);
	if (!segments) {
		throw fsFailure(
			"APP_WORKER_FS_ESCAPE",
			`fs access to ${resolved} escapes the sandbox statePath (${statePath})`,
			operation,
			resolved,
		);
	}
	try {
		const root = await realpath(statePath);
		const rootStat = await lstat(root);
		if (!rootStat.isDirectory()) {
			throw fsFailure(
				"APP_WORKER_FS_ROOT_INVALID",
				`fs access requires statePath to be a directory (${statePath})`,
				operation,
				resolved,
			);
		}
		return { root, segments };
	} catch (error) {
		// error-policy:J2 preserve the root resolution failure in a typed error.
		if (error instanceof SandboxFsError) throw error;
		throw fsFailure(
			"APP_WORKER_FS_ROOT_UNAVAILABLE",
			`fs access requires an existing, resolvable statePath (${statePath})`,
			operation,
			resolved,
			error,
		);
	}
}

async function validateDirectoryComponent(
	root: string,
	candidate: string,
	operation: "read" | "write",
	target: string,
): Promise<string> {
	try {
		const stat = await lstat(candidate);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw fsFailure(
				"APP_WORKER_FS_UNSAFE_COMPONENT",
				`fs access to ${target} crosses a symlink or non-directory component`,
				operation,
				target,
			);
		}
		const canonical = await realpath(candidate);
		if (!relativeSegments(root, canonical)) {
			throw fsFailure(
				"APP_WORKER_FS_ESCAPE",
				`fs access to ${target} escapes the sandbox statePath (${statePath})`,
				operation,
				target,
			);
		}
		return canonical;
	} catch (error) {
		// error-policy:J2 preserve component resolution failures in a typed error.
		if (error instanceof SandboxFsError) throw error;
		throw fsFailure(
			"APP_WORKER_FS_PATH_UNAVAILABLE",
			`fs access could not validate directory component ${candidate}`,
			operation,
			target,
			error,
		);
	}
}

async function resolveParentDirectory(
	root: string,
	segments: string[],
	operation: "read" | "write",
	target: string,
): Promise<{ parent: string; basename: string }> {
	if (segments.length === 0) {
		throw fsFailure(
			"APP_WORKER_FS_ROOT_TARGET",
			"fs file access cannot target the sandbox root directory",
			operation,
			target,
		);
	}
	let parent = root;
	for (const segment of segments.slice(0, -1)) {
		const next = nodePath.join(parent, segment);
		try {
			parent = await validateDirectoryComponent(root, next, operation, target);
		} catch (error) {
			// error-policy:J3 only a missing write directory may be created;
			// every other untrusted path shape remains a hard failure.
			if (
				operation !== "write" ||
				!(error instanceof SandboxFsError) ||
				errnoCode(error.cause) !== "ENOENT"
			) {
				throw error;
			}
			try {
				await mkdir(next);
			} catch (mkdirError) {
				// error-policy:J3 EEXIST is revalidated as a directory below; all
				// other mkdir failures are wrapped and rejected.
				if (errnoCode(mkdirError) !== "EEXIST") {
					throw fsFailure(
						"APP_WORKER_FS_MKDIR_FAILED",
						`fs access could not create sandbox directory ${next}`,
						operation,
						target,
						mkdirError,
					);
				}
			}
			parent = await validateDirectoryComponent(root, next, operation, target);
		}
	}
	return { parent, basename: segments.at(-1) as string };
}

async function openSandboxFile(
	absolutePath: string,
	operation: "read" | "write",
): Promise<FileHandle> {
	if (!grantedSet.has("fs")) {
		throw fsFailure(
			"APP_WORKER_FS_NOT_GRANTED",
			"fs access not granted by user (sandbox: grantedNamespaces does not include 'fs')",
			operation,
			absolutePath,
		);
	}
	if (!hasDeclaredFsOperation(operation)) {
		throw fsFailure(
			"APP_WORKER_FS_NOT_DECLARED",
			`fs.${operation} access not allowed by manifest`,
			operation,
			absolutePath,
		);
	}
	const { root, segments } = await resolveSandboxRoot(operation, absolutePath);
	const { parent, basename } = await resolveParentDirectory(
		root,
		segments,
		operation,
		absolutePath,
	);
	// Revalidate the immediate parent immediately before open. The descriptor
	// pins the selected file for the subsequent I/O, and O_NOFOLLOW (where the
	// platform exposes it) prevents a final-component symlink swap. Node does not
	// expose portable openat/mkdirat APIs, so an external actor can still rename
	// an intermediate directory between this path check and open/mkdir. The
	// post-open canonical check prevents content I/O through such a swap, though
	// O_CREAT could leave an empty file and mkdir could leave an empty directory.
	const canonicalParent = await validateDirectoryComponent(
		root,
		parent,
		operation,
		absolutePath,
	);
	const target = nodePath.join(canonicalParent, basename);
	try {
		const targetStat = await lstat(target);
		if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
			throw fsFailure(
				"APP_WORKER_FS_UNSAFE_TARGET",
				`fs access to ${absolutePath} targets a symlink or non-file`,
				operation,
				absolutePath,
			);
		}
	} catch (error) {
		// error-policy:J3 only a missing final write target is valid input.
		if (error instanceof SandboxFsError) throw error;
		if (errnoCode(error) !== "ENOENT" || operation === "read") {
			throw fsFailure(
				operation === "read" && errnoCode(error) === "ENOENT"
					? "APP_WORKER_FS_NOT_FOUND"
					: "APP_WORKER_FS_PATH_UNAVAILABLE",
				`fs.${operation} could not validate ${absolutePath}`,
				operation,
				absolutePath,
				error,
			);
		}
	}
	const noFollow = fsConstants.O_NOFOLLOW ?? 0;
	const flags =
		operation === "read"
			? fsConstants.O_RDONLY | noFollow
			: fsConstants.O_WRONLY | fsConstants.O_CREAT | noFollow;
	let handle: FileHandle;
	try {
		handle = await open(target, flags, 0o600);
	} catch (error) {
		// error-policy:J2 preserve the OS open failure in a typed boundary error.
		throw fsFailure(
			operation === "read" && errnoCode(error) === "ENOENT"
				? "APP_WORKER_FS_NOT_FOUND"
				: "APP_WORKER_FS_OPEN_FAILED",
			`fs.${operation} could not open ${absolutePath}`,
			operation,
			absolutePath,
			error,
		);
	}
	try {
		const [stat, targetStat, canonicalTarget] = await Promise.all([
			handle.stat({ bigint: true }),
			lstat(target, { bigint: true }),
			realpath(target),
		]);
		const descriptorMatchesPath =
			stat.dev === targetStat.dev && stat.ino === targetStat.ino;
		// A canonical path check alone is insufficient: an attacker can swap an
		// outside parent in for open(), then restore the inside parent before this
		// check. Device/inode identity proves the descriptor and checked path still
		// name the same file before truncate/read begins.
		if (
			!stat.isFile() ||
			targetStat.isSymbolicLink() ||
			!descriptorMatchesPath ||
			!relativeSegments(root, canonicalTarget)
		) {
			throw fsFailure(
				"APP_WORKER_FS_ESCAPE",
				`fs access to ${absolutePath} escapes the sandbox statePath (${statePath})`,
				operation,
				absolutePath,
			);
		}
		return handle;
	} catch (error) {
		// error-policy:J2 preserve descriptor revalidation failures before I/O.
		await handle.close();
		if (error instanceof SandboxFsError) throw error;
		throw fsFailure(
			"APP_WORKER_FS_REVALIDATION_FAILED",
			`fs.${operation} could not revalidate ${absolutePath}`,
			operation,
			absolutePath,
			error,
		);
	}
}

const gatedFs = {
	async readFile(path: string): Promise<string> {
		const handle = await openSandboxFile(path, "read");
		try {
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	},
	async writeFile(path: string, content: string): Promise<void> {
		const handle = await openSandboxFile(path, "write");
		try {
			await handle.truncate(0);
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	},
};

function rpcFailure(error: unknown): RpcFailureFields {
	if (error instanceof SandboxFsError) {
		return {
			reason: error.message,
			code: error.code,
			context: error.context,
		};
	}
	return { reason: error instanceof Error ? error.message : String(error) };
}

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

/**
 * Checks whether a module export is a valid plugin shape. Mirrors the
 * acceptance logic of core's `isValidPluginShape` but is duplicated here
 * because this worker entry is intentionally self-contained — it runs
 * inside a `node:worker_threads` Worker and must not import the full
 * `@elizaos/core` dependency tree. If core's gate changes, update both.
 *
 * One intentional addition over core: this also accepts `routes` as a
 * valid surface (core's gate omits it, but `routes` is a real `Plugin`
 * field and apps can be routes-only).
 */
function isValidPluginExport(c: unknown): c is {
	name: string;
	actions?: LoadedAction[];
} {
	if (!c || typeof c !== "object" || Array.isArray(c)) return false;
	const obj = c as Record<string, unknown>;
	if (typeof obj.name !== "string" || obj.name.length === 0) return false;
	// Validate actions shape before the type predicate narrows it —
	// a non-array `actions` (e.g. `{}` or `"bad"`) must not pass.
	if (obj.actions !== undefined && !Array.isArray(obj.actions)) return false;
	return !!(
		obj.init ||
		obj.services ||
		obj.providers ||
		obj.actions ||
		obj.evaluators ||
		obj.routes ||
		obj.description
	);
}

async function loadPlugin(entryPath: string): Promise<{
	loaded: number;
	error?: string;
	kind?: "no-worker-surface" | "error";
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
		// Prefer the actions-bearing export: a metadata-only default export
		// (valid shape, zero actions) must not shadow a sibling export that
		// actually contributes actions, or the zero-action gate below would
		// reject a module the worker could serve.
		const valid = candidates.filter(isValidPluginExport);
		const plugin = valid.find((p) => p.actions?.length) ?? valid[0] ?? null;
		if (!plugin) {
			return {
				loaded: 0,
				kind: "no-worker-surface" as const,
				error: "no plugin export found in module",
			};
		}
		const actions = plugin.actions ?? [];
		// The worker sandbox only bridges actions via invokeAction. A
		// plugin that contributes only providers, routes, or services has
		// no reachable surface inside the worker — booting it successfully
		// would produce a healthy-looking but inert worker (false success).
		// Fail explicitly so a misconfigured isolation:"worker" app is
		// surfaced as a configuration error, not a silent no-op.
		// error-policy:J3 invalid plugin shape for the worker sandbox →
		// explicit invalid result, never a fake-valid success.
		if (actions.length === 0) {
			return {
				loaded: 0,
				kind: "no-worker-surface" as const,
				error: `plugin "${plugin.name}" contributes no actions; the worker sandbox only exposes actions (invokeAction), not providers/routes/services`,
			};
		}
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
			kind: "error" as const,
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
): Promise<{ ok: true; result: unknown } | ({ ok: false } & RpcFailureFields)> {
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
			...rpcFailure(error),
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
			return { id: req.id, ...result };
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
			...rpcFailure(error),
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
	let kind: "no-worker-surface" | "error" | undefined;
	if (pluginEntryPath) {
		const result = await loadPlugin(pluginEntryPath);
		actionsLoaded = result.loaded;
		pluginLoaded = !result.error;
		if (result.error) {
			error = result.error;
			kind = result.kind ?? "error";
		}
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
		...(kind ? { kind } : {}),
		...(error ? { reason: error } : {}),
	});
}

void bootSequence();
