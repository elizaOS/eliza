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
import os from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import {
	type ElizaCuratedAppDefinition,
	registerCuratedApp,
} from "@elizaos/shared";

export const APP_REGISTRY_SERVICE_TYPE = "app-registry";

/**
 * Source classification computed by the loader at register time. NOT
 * declared by the app — encoded by the caller based on where the
 * directory came from (in-tree first-party dir vs. external load). See
 * `eliza/packages/docs/architecture/app-permissions-manifest.md`.
 */
export type AppTrust = "first-party" | "external";

export interface AppRegistryEntry extends ElizaCuratedAppDefinition {
	directory: string;
	displayName: string;
	/**
	 * Raw `elizaos.app.permissions` block as declared in the app's
	 * `package.json`, or absent when the app declared no permissions
	 * block. Persisted as the open shape (Record<string, unknown>) so
	 * future Milady versions can read namespaces this version did not
	 * validate. See parser at `../permissions.ts`.
	 */
	requestedPermissions?: Record<string, unknown>;
}

export interface RegisterContext {
	requesterEntityId?: string | null;
	requesterRoomId?: string | null;
	/**
	 * How the loader classifies this app's source. Defaults to
	 * `"external"` for back-compat — first-party callers should pass
	 * `"first-party"` explicitly.
	 */
	trust?: AppTrust;
}

export interface ManifestRejection {
	directory: string;
	packageName: string | null;
	reason: string;
	path: string;
	requesterEntityId?: string | null;
	requesterRoomId?: string | null;
}

interface PersistedShape {
	version: 1;
	entries: AppRegistryEntry[];
}

const STATE_DIR_KEYS = ["ELIZA_STATE_DIR", "ELIZA_STATE_DIR"] as const;
const NAMESPACE_KEYS = ["ELIZA_NAMESPACE"] as const;

function readEnv(
	env: NodeJS.ProcessEnv,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return null;
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = readEnv(env, STATE_DIR_KEYS);
	if (override) {
		return path.isAbsolute(override)
			? override
			: path.resolve(os.homedir(), override.replace(/^~\//, ""));
	}
	const namespace = readEnv(env, NAMESPACE_KEYS) ?? "eliza";
	return path.join(os.homedir(), `.${namespace}`);
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
		(e): e is AppRegistryEntry => {
			if (typeof e !== "object" || e === null) return false;
			const candidate = e as AppRegistryEntry;
			if (
				typeof candidate.slug !== "string" ||
				typeof candidate.canonicalName !== "string" ||
				typeof candidate.directory !== "string" ||
				typeof candidate.displayName !== "string" ||
				!Array.isArray(candidate.aliases)
			) {
				return false;
			}
			if (candidate.requestedPermissions !== undefined) {
				if (
					typeof candidate.requestedPermissions !== "object" ||
					candidate.requestedPermissions === null ||
					Array.isArray(candidate.requestedPermissions)
				) {
					return false;
				}
			}
			return true;
		},
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
			kind: "registered",
			timestamp: new Date().toISOString(),
			directory: entry.directory,
			appName: entry.canonicalName,
			slug: entry.slug,
			displayName: entry.displayName,
			trust: ctx.trust ?? "external",
			requestedPermissions: entry.requestedPermissions ?? null,
			registeredByEntity: ctx.requesterEntityId ?? null,
			registeredByRoom: ctx.requesterRoomId ?? null,
		});
	}

	async recordManifestRejection(rejection: ManifestRejection): Promise<void> {
		await appendAuditLine(this.auditPath, {
			kind: "rejected-manifest",
			timestamp: new Date().toISOString(),
			directory: rejection.directory,
			appName: rejection.packageName,
			reason: rejection.reason,
			path: rejection.path,
			registeredByEntity: rejection.requesterEntityId ?? null,
			registeredByRoom: rejection.requesterRoomId ?? null,
		});
	}
}

export default AppRegistryService;
