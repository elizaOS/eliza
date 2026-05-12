import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
	type IAgentRuntime,
	logger,
	resolveStateDir,
	Service,
} from "@elizaos/core";

import { normalizeDevicePath } from "../path.js";
import {
	DEVICE_FILESYSTEM_LOG_PREFIX,
	DEVICE_FILESYSTEM_SERVICE_TYPE,
	type DirectoryEntry,
	type FileEncoding,
} from "../types.js";

interface CapacitorWindow {
	Capacitor?: {
		isNativePlatform?: () => boolean;
	};
}

type CapacitorEncoding = "utf8" | undefined;

interface CapacitorWriteOptions {
	path: string;
	data: string;
	directory: string;
	encoding?: CapacitorEncoding;
	recursive?: boolean;
}

interface CapacitorReadOptions {
	path: string;
	directory: string;
	encoding?: CapacitorEncoding;
}

interface CapacitorReaddirOptions {
	path: string;
	directory: string;
}

interface CapacitorReaddirResultEntry {
	name: string;
	type: "file" | "directory";
}

interface CapacitorReaddirResult {
	files: CapacitorReaddirResultEntry[];
}

interface CapacitorMkdirOptions {
	path: string;
	directory: string;
	recursive?: boolean;
}

interface CapacitorFilesystemModule {
	Filesystem: {
		readFile(options: CapacitorReadOptions): Promise<{ data: string }>;
		writeFile(options: CapacitorWriteOptions): Promise<{ uri: string }>;
		readdir(options: CapacitorReaddirOptions): Promise<CapacitorReaddirResult>;
		mkdir(options: CapacitorMkdirOptions): Promise<void>;
	};
	Directory: {
		Documents: string;
	};
}

function isCapacitorNative(): boolean {
	if (typeof globalThis === "undefined") return false;
	const win = (globalThis as { window?: CapacitorWindow }).window;
	if (!win) return false;
	const cap = win.Capacitor;
	if (!cap || typeof cap.isNativePlatform !== "function") return false;
	return cap.isNativePlatform();
}

function nodeEncodingFor(encoding: FileEncoding): BufferEncoding {
	return encoding === "base64" ? "base64" : "utf8";
}

function capacitorEncodingFor(encoding: FileEncoding): CapacitorEncoding {
	return encoding === "base64" ? undefined : "utf8";
}

export class DeviceFilesystemBridge extends Service {
	static override readonly serviceType = DEVICE_FILESYSTEM_SERVICE_TYPE;

	override capabilityDescription =
		"Mobile-safe filesystem bridge. Routes read/write/list to Capacitor Filesystem on iOS/Android (Directory.Documents) and to node:fs/promises rooted under resolveStateDir()/workspace on desktop/AOSP.";

	private readonly useCapacitor: boolean;
	private capacitorModule: CapacitorFilesystemModule | null = null;
	private nodeRoot: string | null = null;

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.useCapacitor = isCapacitorNative();
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<DeviceFilesystemBridge> {
		const service = new DeviceFilesystemBridge(runtime);
		await service.init();
		return service;
	}

	override async stop(): Promise<void> {}

	/** Exposed for tests so they can construct a bridge bound to a temp root. */
	static forNodeRoot(root: string): DeviceFilesystemBridge {
		const bridge = new DeviceFilesystemBridge();
		bridge.nodeRoot = root;
		return bridge;
	}

	private async init(): Promise<void> {
		if (this.useCapacitor) {
			const mod = (await import("@capacitor/filesystem")) as unknown;
			if (!isCapacitorFilesystemModule(mod)) {
				throw new Error(
					`${DEVICE_FILESYSTEM_LOG_PREFIX} @capacitor/filesystem did not expose Filesystem/Directory`,
				);
			}
			this.capacitorModule = mod;
			logger.info(
				`${DEVICE_FILESYSTEM_LOG_PREFIX} initialised Capacitor backend (Directory.Documents)`,
			);
			return;
		}
		const root = path.join(resolveStateDir(), "workspace");
		await mkdir(root, { recursive: true });
		this.nodeRoot = root;
		logger.info(
			`${DEVICE_FILESYSTEM_LOG_PREFIX} initialised Node backend at ${root}`,
		);
	}

	async read(
		relativePath: string,
		encoding: FileEncoding = "utf8",
	): Promise<string> {
		const { relative } = normalizeDevicePath(relativePath);
		if (this.useCapacitor) {
			const mod = this.requireCapacitor();
			const result = await mod.Filesystem.readFile({
				path: relative,
				directory: mod.Directory.Documents,
				encoding: capacitorEncodingFor(encoding),
			});
			return result.data;
		}
		const absolute = this.resolveNodePath(relative);
		return readFile(absolute, nodeEncodingFor(encoding));
	}

	async write(
		relativePath: string,
		content: string,
		encoding: FileEncoding = "utf8",
	): Promise<void> {
		const { relative } = normalizeDevicePath(relativePath);
		if (this.useCapacitor) {
			const mod = this.requireCapacitor();
			await mod.Filesystem.writeFile({
				path: relative,
				data: content,
				directory: mod.Directory.Documents,
				encoding: capacitorEncodingFor(encoding),
				recursive: true,
			});
			return;
		}
		const absolute = this.resolveNodePath(relative);
		await mkdir(path.dirname(absolute), { recursive: true });
		await writeFile(absolute, content, nodeEncodingFor(encoding));
	}

	async list(relativePath: string): Promise<DirectoryEntry[]> {
		const { relative } = normalizeDevicePath(relativePath, { allowRoot: true });
		if (this.useCapacitor) {
			const mod = this.requireCapacitor();
			const result = await mod.Filesystem.readdir({
				path: relative,
				directory: mod.Directory.Documents,
			});
			return result.files.map((entry) => ({
				name: entry.name,
				type: entry.type,
			}));
		}
		const absolute = this.resolveNodePath(relative);
		const entries = await readdir(absolute, { withFileTypes: true });
		const out: DirectoryEntry[] = [];
		for (const entry of entries) {
			if (entry.isDirectory()) {
				out.push({ name: entry.name, type: "directory" });
			} else if (entry.isFile()) {
				out.push({ name: entry.name, type: "file" });
			} else {
				const child = path.join(absolute, entry.name);
				const info = await stat(child);
				out.push({
					name: entry.name,
					type: info.isDirectory() ? "directory" : "file",
				});
			}
		}
		return out;
	}

	private requireCapacitor(): CapacitorFilesystemModule {
		if (!this.capacitorModule) {
			throw new Error(
				`${DEVICE_FILESYSTEM_LOG_PREFIX} Capacitor backend selected but module not initialised. Did init() run?`,
			);
		}
		return this.capacitorModule;
	}

	private resolveNodePath(relative: string): string {
		if (!this.nodeRoot) {
			throw new Error(
				`${DEVICE_FILESYSTEM_LOG_PREFIX} Node backend root not initialised. Did init() run?`,
			);
		}
		const absolute = path.resolve(this.nodeRoot, relative);
		const rootWithSep = this.nodeRoot.endsWith(path.sep)
			? this.nodeRoot
			: this.nodeRoot + path.sep;
		if (absolute !== this.nodeRoot && !absolute.startsWith(rootWithSep)) {
			throw new Error(
				`${DEVICE_FILESYSTEM_LOG_PREFIX} resolved path escapes workspace root: ${absolute}`,
			);
		}
		return absolute;
	}
}

function isCapacitorFilesystemModule(
	value: unknown,
): value is CapacitorFilesystemModule {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { Filesystem?: unknown; Directory?: unknown };
	if (typeof record.Filesystem !== "object" || record.Filesystem === null) {
		return false;
	}
	const fs = record.Filesystem as Record<string, unknown>;
	if (
		typeof fs.readFile !== "function" ||
		typeof fs.writeFile !== "function" ||
		typeof fs.readdir !== "function" ||
		typeof fs.mkdir !== "function"
	) {
		return false;
	}
	if (typeof record.Directory !== "object" || record.Directory === null) {
		return false;
	}
	const dir = record.Directory as Record<string, unknown>;
	return typeof dir.Documents === "string";
}

export function getDeviceFilesystemBridge(
	runtime: IAgentRuntime,
): DeviceFilesystemBridge {
	const svc = runtime.getService<DeviceFilesystemBridge>(
		DEVICE_FILESYSTEM_SERVICE_TYPE,
	);
	if (!svc) {
		throw new Error(
			`${DEVICE_FILESYSTEM_LOG_PREFIX} DeviceFilesystemBridge is not registered — ensure @elizaos/plugin-device-filesystem is enabled.`,
		);
	}
	return svc;
}
