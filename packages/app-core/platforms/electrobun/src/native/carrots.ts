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
} from "@elizaos/electrobun-carrots";
import {
	buildCarrotRuntimeContext,
	ensureCarrotSourceDirectory,
	installPrebuiltCarrot,
	loadCarrotListEntries,
	loadCarrotStoreSnapshot,
	loadInstalledCarrot,
	toCarrotListEntry,
	toInstalledCarrotSnapshot,
	uninstallInstalledCarrot,
} from "@elizaos/electrobun-carrots";
import { resolveApiToken } from "@elizaos/shared";
import { Utils } from "electrobun/bun";
import { logger } from "../logger.js";
import type { SendToWebview } from "../types.js";

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
	const value = maybeUtils.paths?.userData;
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

export class CarrotManager {
	private readonly storeRoot: string;
	private readonly workerRunner: CarrotWorkerRunner;
	private readonly now: () => number;
	private events: CarrotManagerEvents;
	private readonly workers = new Map<string, CarrotWorkerRecord>();

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
		const record: CarrotWorkerRecord = { status, handle: null, context };
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

	stopWorker(id: string): CarrotWorkerStatus {
		const record = this.workers.get(id);
		if (!record) {
			const status = stoppedStatus(id);
			this.emitWorkerChanged(status);
			return status;
		}
		record.handle?.terminate();
		const status: CarrotWorkerStatus = {
			id,
			state: "stopped",
			startedAt: record.status.startedAt,
			stoppedAt: this.now(),
			error: null,
		};
		this.workers.set(id, { status, handle: null, context: record.context });
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
		}
	}

	private handleHostRequest(
		callerId: string,
		handle: CarrotWorkerHandle,
		request: HostRequestMessage,
	): void {
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

	private postHostResponse(
		handle: CarrotWorkerHandle,
		response: HostResponseMessage,
	): void {
		const record = [...this.workers.values()].find((r) => r.handle === handle);
		if (!record) return;
		handle.postMessage(response);
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
				const targetId = hostRequestStringField(params, "id");
				this.startWorker(targetId);
				return { ok: true };
			}
			case "stop-carrot": {
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
					throw new Error(
						"set-auth-token: token must be a string or null.",
					);
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
		record.status.state = "error";
		record.status.error = error.message;
		record.status.stoppedAt = this.now();
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
