/**
 * @module plugin-app-control/services/app-registry-service
 *
 * Atomically persists app definitions registered via the
 * `load_from_directory` sub-mode of the unified APP action so they survive
 * runtime restarts. On boot, re-applies the persisted entries via
 * `registerCuratedApp(...)`. Idempotent.
 *
 * Also owns the audit log writer for `~/.eliza/audit/app-loads.jsonl` —
 * every register call appends a single JSON line so security review can
 * trace exactly which agent / room / entity loaded which directory.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import {
	type ElizaCuratedAppDefinition,
	logger,
	registerCuratedApp,
	resolveStateDir,
	Service,
} from "@elizaos/core";

export const APP_REGISTRY_SERVICE_TYPE = "app-registry";

export interface AppRegistryEntry extends ElizaCuratedAppDefinition {
	directory: string;
	displayName: string;
}

export interface RegisterContext {
	requesterEntityId?: string | null;
	requesterRoomId?: string | null;
}

interface PersistedShape {
	version: 1;
	entries: AppRegistryEntry[];
}

function registryFilePath(stateDir: string): string {
	return path.join(stateDir, "app-registry.json");
}

function auditFilePath(stateDir: string): string {
	return path.join(stateDir, "audit", "app-loads.jsonl");
}

async function ensureDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function readPersisted(file: string): Promise<PersistedShape> {
	const raw = await fs.readFile(file, "utf8").catch(() => null);
	if (raw === null) {
		return { version: 1, entries: [] };
	}
	const parsed = JSON.parse(raw) as unknown;
	if (
		!parsed ||
		typeof parsed !== "object" ||
		(parsed as { version?: unknown }).version !== 1 ||
		!Array.isArray((parsed as { entries?: unknown }).entries)
	) {
		logger.warn(
			`[plugin-app-control] app-registry.json malformed; resetting (file=${file})`,
		);
		return { version: 1, entries: [] };
	}
	const entries = (parsed as { entries: unknown[] }).entries.filter(
		(e): e is AppRegistryEntry =>
			typeof e === "object" &&
			e !== null &&
			typeof (e as AppRegistryEntry).slug === "string" &&
			typeof (e as AppRegistryEntry).canonicalName === "string" &&
			typeof (e as AppRegistryEntry).directory === "string" &&
			typeof (e as AppRegistryEntry).displayName === "string" &&
			Array.isArray((e as AppRegistryEntry).aliases),
	);
	return { version: 1, entries };
}

async function writePersistedAtomic(
	file: string,
	payload: PersistedShape,
): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const body = `${JSON.stringify(payload, null, 2)}\n`;
	await ensureDir(path.dirname(file));
	await fs.writeFile(tmp, body, "utf8");
	await fs.rename(tmp, file);
}

async function appendAuditLine(
	file: string,
	line: Record<string, unknown>,
): Promise<void> {
	await ensureDir(path.dirname(file));
	await fs.appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

export class AppRegistryService extends Service {
	static override serviceType = APP_REGISTRY_SERVICE_TYPE;

	override capabilityDescription =
		"Persists app definitions registered via load_from_directory and re-registers them at boot. Owns the app-loads audit log.";

	private readonly stateDir: string;
	private readonly registryPath: string;
	private readonly auditPath: string;

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.stateDir = resolveStateDir();
		this.registryPath = registryFilePath(this.stateDir);
		this.auditPath = auditFilePath(this.stateDir);
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<AppRegistryService> {
		const service = new AppRegistryService(runtime);
		await service.bootstrap();
		return service;
	}

	override async stop(): Promise<void> {
		// no-op — persistence is sync per write.
	}

	private async bootstrap(): Promise<void> {
		const persisted = await readPersisted(this.registryPath);
		for (const entry of persisted.entries) {
			registerCuratedApp(entry);
		}
		if (persisted.entries.length > 0) {
			logger.info(
				`[plugin-app-control] AppRegistryService re-registered ${persisted.entries.length} app(s) from ${this.registryPath}`,
			);
		}
	}

	async list(): Promise<AppRegistryEntry[]> {
		const persisted = await readPersisted(this.registryPath);
		return persisted.entries;
	}

	async register(
		entry: AppRegistryEntry,
		ctx: RegisterContext = {},
	): Promise<void> {
		registerCuratedApp(entry);

		const persisted = await readPersisted(this.registryPath);
		const idx = persisted.entries.findIndex((e) => e.slug === entry.slug);
		if (idx >= 0) {
			persisted.entries[idx] = entry;
		} else {
			persisted.entries.push(entry);
		}
		await writePersistedAtomic(this.registryPath, persisted);

		await appendAuditLine(this.auditPath, {
			timestamp: new Date().toISOString(),
			directory: entry.directory,
			appName: entry.canonicalName,
			slug: entry.slug,
			displayName: entry.displayName,
			registeredByEntity: ctx.requesterEntityId ?? null,
			registeredByRoom: ctx.requesterRoomId ?? null,
		});
	}
}

export default AppRegistryService;
