/**
 * Electrobun carrot host runtime — manages install, start, stop, and
 * lifecycle for `mode: "background"` and `mode: "window"` carrots, plus
 * the host-side dispatcher for `bridge.requestHost(...)` host actions.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CarrotInstallRecord,
	CarrotListEntry,
	CarrotPermissionGrant,
	CarrotRuntimeContext,
	CarrotStoreSnapshot,
	CarrotWorkerMessage,
	HostActionMessage,
	HostRequestMessage,
	HostResponseMessage,
	InstalledCarrot,
	InstalledCarrotSnapshot,
	JsonValue,
	WorkerInitMessage,
	WorkerResponseMessage,
} from "@elizaos/electrobun-carrots";
import {
	buildCarrotRuntimeContext,
	ensureCarrotSourceDirectory,
	hasHostPermission,
	installPrebuiltCarrot,
	loadCarrotListEntries,
	loadCarrotStoreSnapshot,
	loadInstalledCarrot,
	toCarrotListEntry,
	toInstalledCarrotSnapshot,
	uninstallInstalledCarrot,
} from "@elizaos/electrobun-carrots";
import { resolveApiToken } from "@elizaos/shared";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import { logger } from "../logger.js";
import type { SendToWebview } from "../types.js";

type CarrotWindowInstance = InstanceType<typeof BrowserWindow>;

export type CarrotWorkerState = "stopped" | "starting" | "running" | "error";

export interface CarrotWorkerStatus {
	id: string;
	state: CarrotWorkerState;
	startedAt: number | null;
	stoppedAt: number | null;
	error: string | null;
}

export interface CarrotInstallFromDirectoryOptions {
	sourceDir: string;
	devMode?: boolean;
	permissionsGranted?: CarrotPermissionGrant;
}

export interface CarrotUninstallResult {
	removed: boolean;
	carrot: CarrotListEntry | null;
}

export interface CarrotLogsSnapshot {
	id: string;
	path: string;
	text: string;
	truncated: boolean;
}

export interface CarrotWorkerHandle {
	postMessage(message: CarrotWorkerMessage): void;
	terminate(): void;
	onMessage(listener: (message: CarrotWorkerMessage) => void): void;
	onError(listener: (error: Error) => void): void;
}

export interface CarrotWorkerRunner {
	start(carrot: InstalledCarrot): CarrotWorkerHandle;
}

interface CarrotWorkerRecord {
	status: CarrotWorkerStatus;
	handle: CarrotWorkerHandle | null;
	context: CarrotRuntimeContext | null;
	window: CarrotWindowInstance | null;
}

interface CarrotManagerEvents {
	storeChanged?: (snapshot: CarrotStoreSnapshot) => void;
	workerChanged?: (status: CarrotWorkerStatus) => void;
}

export interface CarrotManagerOptions {
	storeRoot?: string;
	workerRunner?: CarrotWorkerRunner;
	now?: () => number;
	events?: CarrotManagerEvents;
}

const CARROT_STORE_ENV_KEYS = [
	"MILADY_CARROT_STORE_DIR",
	"ELIZA_CARROT_STORE_DIR",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveUtilsUserData(): string | null {
	const maybeUtils = Utils as typeof Utils & {
		paths?: { userData?: string };
	};
	const value = maybeUtils.paths.userData;
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveCarrotStoreRoot(
	env: NodeJS.ProcessEnv = process.env,
): string {
	for (const key of CARROT_STORE_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value) return path.resolve(value);
	}
	return path.join(
		resolveUtilsUserData() ?? path.join(os.homedir(), ".eliza"),
		"carrots",
	);
}

class BrowserWorkerHandle implements CarrotWorkerHandle {
	constructor(private readonly worker: Worker) {}

	postMessage(message: CarrotWorkerMessage): void {
		this.worker.postMessage(message);
	}

	terminate(): void {
		this.worker.terminate();
	}

	onMessage(listener: (message: CarrotWorkerMessage) => void): void {
		this.worker.addEventListener("message", (event) => {
			listener(event.data as CarrotWorkerMessage);
		});
	}

	onError(listener: (error: Error) => void): void {
		this.worker.addEventListener("error", (event) => {
			listener(
				new Error(
					typeof event.message === "string"
						? event.message
						: "Carrot worker failed.",
				),
			);
		});
	}
}

class BrowserCarrotWorkerRunner implements CarrotWorkerRunner {
	start(carrot: InstalledCarrot): CarrotWorkerHandle {
		return new BrowserWorkerHandle(
			new Worker(pathToFileURL(carrot.workerPath).href, { type: "module" }),
		);
	}
}

function stoppedStatus(id: string): CarrotWorkerStatus {
	return {
		id,
		state: "stopped",
		startedAt: null,
		stoppedAt: null,
		error: null,
	};
}

function buildWorkerInitMessage(
	carrot: InstalledCarrot,
	context: CarrotRuntimeContext,
): WorkerInitMessage {
	return {
		type: "init",
		manifest: carrot.manifest,
		context: {
			statePath: context.statePath,
			logsPath: context.logsPath,
			permissions: context.permissions,
			grantedPermissions: context.grantedPermissions,
		},
	};
}

function hostRequestStringField(
	params: JsonValue | undefined,
	key: string,
): string {
	if (!isRecord(params)) {
		throw new Error(`Host request missing params object (expected ${key})`);
	}
	const value = params[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Host request missing or invalid ${key}`);
	}
	return value;
}

function actionLogPayload(message: HostActionMessage): string | null {
	if (message.action !== "log" || !isRecord(message.payload)) return null;
	const level = message.payload.level;
	const text = message.payload.message;
	if (typeof text !== "string" || text.length === 0) return null;
	return typeof level === "string" && level.length > 0
		? `[${level}] ${text}`
		: text;
}

interface PendingInvoke {
	callerId: string;
	callerHandle: CarrotWorkerHandle;
	targetId: string;
	originalRequestId: number;
	timeout: ReturnType<typeof setTimeout>;
}

const INVOKE_TIMEOUT_MS = 30_000;

export class CarrotManager {
	private readonly storeRoot: string;
	private readonly workerRunner: CarrotWorkerRunner;
	private readonly now: () => number;
	private events: CarrotManagerEvents;
	private readonly workers = new Map<string, CarrotWorkerRecord>();
	private readonly pendingInvokes = new Map<number, PendingInvoke>();
	private nextInvokeId = 1;

	constructor(options: CarrotManagerOptions = {}) {
		this.storeRoot = options.storeRoot ?? resolveCarrotStoreRoot();
		this.workerRunner = options.workerRunner ?? new BrowserCarrotWorkerRunner();
		this.now = options.now ?? Date.now;
		this.events = options.events ?? {};
	}

	setEvents(events: CarrotManagerEvents): void {
		this.events = events;
	}

	getStoreRoot(): string {
		return this.storeRoot;
	}

	listCarrots(): CarrotListEntry[] {
		return loadCarrotListEntries(this.storeRoot);
	}

	getStoreSnapshot(): CarrotStoreSnapshot {
		return loadCarrotStoreSnapshot(this.storeRoot);
	}

	getCarrot(id: string): InstalledCarrotSnapshot | null {
		const carrot = loadInstalledCarrot(this.storeRoot, id);
		return carrot ? toInstalledCarrotSnapshot(carrot) : null;
	}

	installFromDirectory(
		options: CarrotInstallFromDirectoryOptions,
	): InstalledCarrotSnapshot {
		const sourceDir = ensureCarrotSourceDirectory(options.sourceDir);
		const carrot = installPrebuiltCarrot(this.storeRoot, sourceDir, {
			devMode: options.devMode === true,
			permissionsGranted: options.permissionsGranted,
			source: { kind: "local", path: sourceDir },
			now: this.now,
		});
		this.emitStoreChanged();
		return toInstalledCarrotSnapshot(carrot);
	}

	uninstall(id: string): CarrotUninstallResult {
		const carrot = loadInstalledCarrot(this.storeRoot, id);
		const entry = carrot ? toCarrotListEntry(carrot) : null;
		if (carrot) {
			this.stopWorker(id);
		}
		const record = uninstallInstalledCarrot(this.storeRoot, id);
		if (record) {
			this.workers.delete(id);
			this.emitStoreChanged();
		}
		return { removed: record !== null, carrot: entry };
	}

	startWorker(id: string): CarrotWorkerStatus {
		const existing = this.workers.get(id);
		if (existing?.status.state === "running") return existing.status;
		if (existing?.status.state === "starting") return existing.status;

		const carrot = loadInstalledCarrot(this.storeRoot, id);
		if (!carrot) {
			throw new Error(`Carrot is not installed: ${id}`);
		}

		fs.mkdirSync(carrot.stateDir, { recursive: true });
		if (carrot.install.permissionsGranted.isolation === "isolated-process") {
			logger.warn(
				`[carrots] ${id}: manifest requests isolation:isolated-process but the host runs all carrots as shared-worker today; falling back. Process isolation lands when a Bun.spawn-based runner is wired.`,
			);
		}
		const context = buildCarrotRuntimeContext(
			carrot.currentDir,
			carrot.stateDir,
			carrot.manifest.id,
			carrot.install.permissionsGranted,
		);
		const status: CarrotWorkerStatus = {
			id,
			state: "starting",
			startedAt: this.now(),
			stoppedAt: null,
			error: null,
		};
		const record: CarrotWorkerRecord = {
			status,
			handle: null,
			context,
			window: null,
		};
		this.workers.set(id, record);
		this.emitWorkerChanged(status);

		try {
			const handle = this.workerRunner.start(carrot);
			record.handle = handle;
			handle.onMessage((message) =>
				this.handleWorkerMessage(id, handle, message),
			);
			handle.onError((error) => this.markWorkerError(id, handle, error));
			handle.postMessage(buildWorkerInitMessage(carrot, context));
			if (carrot.manifest.mode === "window") {
				record.window = this.openCarrotWindow(carrot);
			}
			status.state = "running";
			this.emitWorkerChanged(status);
			return status;
		} catch (error) {
			status.state = "error";
			status.error = error instanceof Error ? error.message : String(error);
			status.stoppedAt = this.now();
			this.emitWorkerChanged(status);
			return status;
		}
	}

	/**
	 * Open the carrot's view window. Used for `mode: "window"` carrots; the
	 * carrot's `view/index.html` (and friends) is served via Electrobun's
	 * `views://` scheme rooted at `carrot.currentDir`. Background carrots
	 * never call this.
	 *
	 * Guarded against test stubs: vitest replaces `electrobun/bun` with a
	 * non-constructor stub, so `BrowserWindow` won't be callable in the
	 * test environment. We typeof-check before constructing and log a
	 * warning if the runtime can't open windows (which is harmless in
	 * tests and informative in dev where the host hasn't initialized FFI).
	 */
	private openCarrotWindow(
		carrot: InstalledCarrot,
	): CarrotWindowInstance | null {
		if (
			typeof BrowserWindow !== "function" ||
			typeof BrowserView !== "function"
		) {
			logger.warn(
				`[carrots] ${carrot.manifest.id}: skipping window-mode open — Electrobun BrowserWindow not available in this runtime (typeof=${typeof BrowserWindow}).`,
			);
			return null;
		}

		const { width, height, title, titleBarStyle, transparent } =
			carrot.manifest.view;
		try {
			const win = new BrowserWindow({
				title,
				url: null,
				preload: null,
				frame: { x: 120, y: 120, width, height },
				...(titleBarStyle === undefined ? {} : { titleBarStyle }),
				...(transparent === undefined ? {} : { transparent }),
			});
			try {
				win.webview.remove();
			} catch {
				// Some Electrobun builds expose webview lazily; safe to ignore.
			}
			new BrowserView({
				url: carrot.viewUrl,
				viewsRoot: carrot.currentDir,
				renderer: "cef",
				frame: { x: 0, y: 0, width, height },
				windowId: win.id,
			});
			win.on("close", () => {
				this.handleCarrotWindowClosed(carrot.manifest.id);
			});
			return win;
		} catch (error) {
			logger.warn(
				`[carrots] ${carrot.manifest.id}: failed to open window — ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	private handleCarrotWindowClosed(id: string): void {
		const record = this.workers.get(id);
		if (!record) return;
		record.window = null;
		// Closing the window stops the underlying worker — `mode: "window"`
		// carrots have no UI-less lifetime.
		if (
			record.status.state === "running" ||
			record.status.state === "starting"
		) {
			this.stopWorker(id);
		}
	}

	stopWorker(id: string): CarrotWorkerStatus {
		const record = this.workers.get(id);
		if (!record) {
			const status = stoppedStatus(id);
			this.emitWorkerChanged(status);
			return status;
		}
		this.rejectPendingInvokesForWorker(id);
		record.handle?.terminate();
		if (record.window) {
			try {
				record.window.close();
			} catch {
				// BrowserWindow.close() may throw if already destroyed.
			}
		}
		const status: CarrotWorkerStatus = {
			id,
			state: "stopped",
			startedAt: record.status.startedAt,
			stoppedAt: this.now(),
			error: null,
		};
		this.workers.set(id, {
			status,
			handle: null,
			context: record.context,
			window: null,
		});
		this.emitWorkerChanged(status);
		return status;
	}

	getWorkerStatus(id: string): CarrotWorkerStatus | null {
		const record = this.workers.get(id);
		if (record) return record.status;
		return loadInstalledCarrot(this.storeRoot, id) ? stoppedStatus(id) : null;
	}

	listWorkerStatuses(): CarrotWorkerStatus[] {
		const statuses = new Map<string, CarrotWorkerStatus>();
		for (const carrot of this.listCarrots()) {
			statuses.set(carrot.id, stoppedStatus(carrot.id));
		}
		for (const [id, record] of this.workers) {
			statuses.set(id, record.status);
		}
		return Array.from(statuses.values()).sort((left, right) =>
			left.id.localeCompare(right.id),
		);
	}

	getLogs(id: string, maxBytes = 64 * 1024): CarrotLogsSnapshot {
		const carrot = loadInstalledCarrot(this.storeRoot, id);
		if (!carrot) {
			throw new Error(`Carrot is not installed: ${id}`);
		}
		const context = buildCarrotRuntimeContext(
			carrot.currentDir,
			carrot.stateDir,
			carrot.manifest.id,
			carrot.install.permissionsGranted,
		);
		if (!fs.existsSync(context.logsPath)) {
			return {
				id,
				path: context.logsPath,
				text: "",
				truncated: false,
			};
		}
		const stat = fs.statSync(context.logsPath);
		const size = Math.max(0, stat.size);
		const limit = Math.max(1, maxBytes);
		const start = Math.max(0, size - limit);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		const fd = fs.openSync(context.logsPath, "r");
		try {
			fs.readSync(fd, buffer, 0, length, start);
		} finally {
			fs.closeSync(fd);
		}
		return {
			id,
			path: context.logsPath,
			text: buffer.toString("utf8"),
			truncated: start > 0,
		};
	}

	dispose(): void {
		for (const id of this.workers.keys()) {
			this.stopWorker(id);
		}
		this.events = {};
	}

	private handleWorkerMessage(
		id: string,
		handle: CarrotWorkerHandle,
		message: CarrotWorkerMessage,
	): void {
		const record = this.workers.get(id);
		if (record?.handle !== handle) return;

		if (message.type === "ready") {
			record.status.state = "running";
			record.status.error = null;
			this.emitWorkerChanged(record.status);
			return;
		}

		if (message.type === "host-request") {
			this.handleHostRequest(id, handle, message);
			return;
		}

		if (message.type === "response") {
			this.handleWorkerResponse(id, handle, message);
			return;
		}

		if (message.type !== "action") return;
		if (!record.context) return;

		const logLine = actionLogPayload(message);
		if (logLine) {
			fs.mkdirSync(path.dirname(record.context.logsPath), { recursive: true });
			fs.appendFileSync(record.context.logsPath, `${logLine}\n`, "utf8");
			return;
		}

		if (message.action === "stop-carrot") {
			this.stopWorker(id);
			return;
		}

		if (message.action === "emit-carrot-event") {
			this.dispatchEmitCarrotEvent(id, message.payload);
		}
	}

	private dispatchEmitCarrotEvent(
		callerId: string,
		payload: JsonValue | undefined,
	): void {
		if (!isRecord(payload)) return;
		const targetId = payload.carrotId;
		const name = payload.name;
		if (typeof targetId !== "string" || typeof name !== "string") return;
		const target = this.workers.get(targetId);
		if (!target?.handle || target.status.state !== "running") {
			logger.warn(
				`[carrots] ${callerId} → emit-carrot-event dropped: target ${targetId} is not running.`,
			);
			return;
		}
		target.handle.postMessage({
			type: "event",
			name,
			...(payload.payload === undefined ? {} : { payload: payload.payload }),
		});
	}

	private handleHostRequest(
		callerId: string,
		handle: CarrotWorkerHandle,
		request: HostRequestMessage,
	): void {
		if (request.method === "invoke-carrot") {
			try {
				this.startInvokeCarrot(callerId, handle, request);
			} catch (error) {
				this.postHostResponse(handle, {
					type: "host-response",
					requestId: request.requestId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}

		void this.dispatchHostRequest(callerId, request.method, request.params)
			.then((payload) => {
				this.postHostResponse(handle, {
					type: "host-response",
					requestId: request.requestId,
					success: true,
					payload,
				});
			})
			.catch((error: unknown) => {
				this.postHostResponse(handle, {
					type: "host-response",
					requestId: request.requestId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	private startInvokeCarrot(
		callerId: string,
		callerHandle: CarrotWorkerHandle,
		request: HostRequestMessage,
	): void {
		this.requireManageCarrots(callerId, "invoke-carrot");
		if (!isRecord(request.params)) {
			throw new Error("invoke-carrot: missing params object.");
		}
		const targetId = request.params.carrotId;
		const method = request.params.method;
		if (typeof targetId !== "string" || targetId.length === 0) {
			throw new Error("invoke-carrot: invalid carrotId.");
		}
		if (typeof method !== "string" || method.length === 0) {
			throw new Error("invoke-carrot: invalid method.");
		}
		const target = this.workers.get(targetId);
		if (!target?.handle || target.status.state !== "running") {
			throw new Error(`invoke-carrot: target ${targetId} is not running.`);
		}
		const targetHandle = target.handle;

		const invokeId = ++this.nextInvokeId;
		const timeout = setTimeout(() => {
			const pending = this.pendingInvokes.get(invokeId);
			if (!pending) return;
			this.pendingInvokes.delete(invokeId);
			this.postHostResponse(pending.callerHandle, {
				type: "host-response",
				requestId: pending.originalRequestId,
				success: false,
				error: `invoke-carrot: target ${targetId} did not respond within ${INVOKE_TIMEOUT_MS}ms`,
			});
		}, INVOKE_TIMEOUT_MS);

		this.pendingInvokes.set(invokeId, {
			callerId,
			callerHandle,
			targetId,
			originalRequestId: request.requestId,
			timeout,
		});

		const requestParams = request.params.params;
		const windowId = request.params.windowId;
		const targetRequest: CarrotWorkerMessage = {
			type: "request",
			requestId: invokeId,
			method,
			...(requestParams === undefined
				? {}
				: { params: requestParams as JsonValue }),
			...(typeof windowId === "string" ? { windowId } : {}),
		};
		targetHandle.postMessage(targetRequest);
	}

	private handleWorkerResponse(
		id: string,
		handle: CarrotWorkerHandle,
		response: WorkerResponseMessage,
	): void {
		const record = this.workers.get(id);
		if (record?.handle !== handle) return;
		const pending = this.pendingInvokes.get(response.requestId);
		if (!pending) return;
		this.pendingInvokes.delete(response.requestId);
		clearTimeout(pending.timeout);
		this.postHostResponse(pending.callerHandle, {
			type: "host-response",
			requestId: pending.originalRequestId,
			success: response.success,
			...(response.success
				? response.payload === undefined
					? {}
					: { payload: response.payload }
				: {
						error: response.error ?? "invoke-carrot: target returned failure",
					}),
		});
	}

	private rejectPendingInvokesForWorker(id: string): void {
		for (const [invokeId, pending] of this.pendingInvokes) {
			if (pending.targetId === id) {
				this.pendingInvokes.delete(invokeId);
				clearTimeout(pending.timeout);
				this.postHostResponse(pending.callerHandle, {
					type: "host-response",
					requestId: pending.originalRequestId,
					success: false,
					error: `invoke-carrot: target ${id} stopped before responding`,
				});
			} else if (pending.callerId === id) {
				this.pendingInvokes.delete(invokeId);
				clearTimeout(pending.timeout);
			}
		}
	}

	private postHostResponse(
		handle: CarrotWorkerHandle,
		response: HostResponseMessage,
	): void {
		const record = [...this.workers.values()].find((r) => r.handle === handle);
		if (!record) return;
		handle.postMessage(response);
	}

	private requireManageCarrots(callerId: string, action: string): void {
		const record = this.workers.get(callerId);
		const grant = record?.context?.grantedPermissions ?? null;
		if (!hasHostPermission(grant, "manage-carrots")) {
			throw new Error(
				`${action}: carrot "${callerId}" lacks host:manage-carrots permission`,
			);
		}
	}

	/**
	 * Auth-token model (MVP): each carrot worker has its own
	 * `context.authToken` stored in-process on the host. `get-auth-token` is
	 * lazy — the first call seeds the slot from `resolveApiToken()` so a
	 * carrot can call Milady's HTTP API as the user without seeing the
	 * underlying env var. `set-auth-token` lets a carrot REPLACE ITS OWN
	 * token (Farm-login style flows); cross-carrot exfiltration is prevented
	 * by keying read/write off the calling worker's id. The MVP forwards the
	 * host token verbatim; the production hook is a per-carrot scoped JWT
	 * issued by the auth pairing layer — schema unchanged.
	 */
	private async dispatchHostRequest(
		callerId: string,
		method: string,
		params: JsonValue | undefined,
	): Promise<JsonValue> {
		switch (method) {
			case "list-carrots":
				return this.listCarrots() as unknown as JsonValue;
			case "start-carrot": {
				this.requireManageCarrots(callerId, "start-carrot");
				const targetId = hostRequestStringField(params, "id");
				this.startWorker(targetId);
				return { ok: true };
			}
			case "stop-carrot": {
				this.requireManageCarrots(callerId, "stop-carrot");
				const targetId = hostRequestStringField(params, "id");
				this.stopWorker(targetId);
				return { ok: true };
			}
			case "get-auth-token": {
				const record = this.workers.get(callerId);
				if (!record?.context) {
					throw new Error(`Carrot ${callerId} has no runtime context.`);
				}
				if (record.context.authToken === null) {
					record.context.authToken = resolveApiToken();
				}
				return { token: record.context.authToken };
			}
			case "invoke-carrot":
				throw new Error(
					"invoke-carrot must be routed through startInvokeCarrot",
				);
			case "set-auth-token": {
				const record = this.workers.get(callerId);
				if (!record?.context) {
					throw new Error(`Carrot ${callerId} has no runtime context.`);
				}
				if (!isRecord(params)) {
					throw new Error("set-auth-token: missing params object.");
				}
				const token = params.token;
				if (token !== null && typeof token !== "string") {
					throw new Error("set-auth-token: token must be a string or null.");
				}
				record.context.authToken = token;
				return { ok: true };
			}
			default:
				throw new Error(
					`Host request method not implemented: ${method} (caller=${callerId})`,
				);
		}
	}

	private markWorkerError(
		id: string,
		handle: CarrotWorkerHandle,
		error: Error,
	): void {
		const record = this.workers.get(id);
		if (record?.handle !== handle) return;
		this.rejectPendingInvokesForWorker(id);
		record.status.state = "error";
		record.status.error = error.message;
		record.status.stoppedAt = this.now();
		// Don't leave an orphaned window for a dead worker — close it and
		// let the next start cycle reopen one cleanly.
		if (record.window) {
			try {
				record.window.close();
			} catch {
				// already destroyed
			}
			record.window = null;
		}
		this.emitWorkerChanged(record.status);
	}

	private emitStoreChanged(): void {
		this.events.storeChanged?.(this.getStoreSnapshot());
	}

	private emitWorkerChanged(status: CarrotWorkerStatus): void {
		this.events.workerChanged?.(status);
	}
}

let activeCarrotManager: CarrotManager | null = null;

export function getCarrotManager(): CarrotManager {
	activeCarrotManager ??= new CarrotManager();
	return activeCarrotManager;
}

export function configureCarrotManagerEvents(
	sendToWebview: SendToWebview,
): void {
	getCarrotManager().setEvents({
		storeChanged: (snapshot) => {
			sendToWebview("carrotStoreChanged", { snapshot });
		},
		workerChanged: (status) => {
			sendToWebview("carrotWorkerChanged", { status });
		},
	});
}

export function resetCarrotManagerForTesting(
	manager: CarrotManager | null = null,
): void {
	activeCarrotManager = manager;
}

export type { CarrotInstallRecord };
