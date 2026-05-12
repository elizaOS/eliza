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
	InstalledCarrot,
	InstalledCarrotSnapshot,
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
import { Utils } from "electrobun/bun";
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
			handle.onMessage((message) => this.handleWorkerMessage(id, message));
			handle.onError((error) => this.markWorkerError(id, error));
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

	private handleWorkerMessage(id: string, message: CarrotWorkerMessage): void {
		if (message.type === "ready") {
			const record = this.workers.get(id);
			if (!record) return;
			record.status.state = "running";
			record.status.error = null;
			this.emitWorkerChanged(record.status);
			return;
		}

		if (message.type !== "action") return;
		const record = this.workers.get(id);
		if (!record?.context) return;

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

	private markWorkerError(id: string, error: Error): void {
		const record = this.workers.get(id);
		if (!record) return;
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
