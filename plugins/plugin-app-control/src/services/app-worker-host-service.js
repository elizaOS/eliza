/**
 * @module plugin-app-control/services/app-worker-host-service
 *
 * Spawns one Bun `node:worker_threads` Worker per registered app that
 * declares `isolation: "worker"` in its manifest. Phase 2.2 surface:
 * a thin lifecycle owner + typed RPC client that the rest of the
 * Phase 2 work (action invocation, FS/net gating) builds on.
 *
 * - `start(slug)` spawns the worker if the registered entry declares
 *   `isolation: "worker"`. No-op for `"none"`.
 * - `invoke(slug, method, params)` sends a typed message and awaits
 *   the worker's response. The wire format is documented in
 *   `../workers/app-worker-entry.ts`.
 * - `stop(slug)` sends `{ method: "shutdown" }` and awaits the
 *   `exit` event with a 5s grace before falling back to
 *   `worker.terminate()`.
 * - `list()` returns a snapshot of currently spawned workers for
 *   diagnostics.
 *
 * The service is registered alongside `AppRegistryService` in
 * `plugin-app-control/src/index.ts`. It does not auto-start workers
 * during bootstrap — Phase 2.5 wires that.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { logger, resolveStateDir, Service } from "@elizaos/core";
import { APP_REGISTRY_SERVICE_TYPE } from "./app-registry-service.js";
export const APP_WORKER_HOST_SERVICE_TYPE = "app-worker-host";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_WORKER_ENTRY = path.resolve(
	__dirname,
	"../workers/app-worker-entry.ts",
);
const DIST_WORKER_ENTRY = path.resolve(
	__dirname,
	"workers/app-worker-entry.js",
);
const WORKER_ENTRY = existsSync(SOURCE_WORKER_ENTRY)
	? SOURCE_WORKER_ENTRY
	: DIST_WORKER_ENTRY;
const SHUTDOWN_GRACE_MS = 5_000;
function readString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function readStringFromExports(value) {
	if (typeof value === "string") return readString(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value;
	return (
		readString(record.import) ??
		readString(record.default) ??
		readString(record.require)
	);
}
async function resolvePluginEntryPath(entry) {
	const pkgPath = path.join(entry.directory, "package.json");
	const raw = await readFile(pkgPath, "utf8").catch(() => null);
	if (raw === null) return null;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const pkg = parsed;
	const exportsEntry =
		readStringFromExports(pkg.exports) ??
		(pkg.exports &&
		typeof pkg.exports === "object" &&
		!Array.isArray(pkg.exports)
			? readStringFromExports(pkg.exports["."])
			: null);
	const candidates = [
		exportsEntry,
		readString(pkg.module),
		readString(pkg.main),
		"src/index.ts",
		"src/index.js",
		"dist/index.js",
		"index.ts",
		"index.js",
	].filter((candidate) => candidate !== null);
	for (const candidate of candidates) {
		const resolved = path.isAbsolute(candidate)
			? candidate
			: path.resolve(entry.directory, candidate);
		if (existsSync(resolved)) return resolved;
	}
	return null;
}
export class AppWorkerHostService extends Service {
	static serviceType = APP_WORKER_HOST_SERVICE_TYPE;
	capabilityDescription =
		"Spawns and manages Bun workers for apps declaring isolation:'worker'. Phase 2 enforcement substrate.";
	workers = new Map();
	stateDir;
	constructor(runtime) {
		super(runtime);
		this.stateDir = resolveStateDir();
	}
	static async start(runtime) {
		const service = new AppWorkerHostService(runtime);
		await service.bootstrapRegisteredWorkers();
		return service;
	}
	async stop() {
		const slugs = Array.from(this.workers.keys());
		await Promise.all(
			slugs.map((slug) => this.stopWorker(slug).catch(() => {})),
		);
	}
	/**
	 * Look up the registered entry and spawn a worker if the entry
	 * declares isolation:"worker". Returns the spawn snapshot or a
	 * structured reason if the spawn was a no-op.
	 */
	async startForRegisteredApp(slug) {
		const registry = this.runtime.getService(APP_REGISTRY_SERVICE_TYPE);
		if (!registry) {
			return {
				ok: false,
				reason: "AppRegistryService is not registered on the runtime",
			};
		}
		const entries = await registry.list();
		const entry = entries.find((e) => e.slug === slug);
		if (!entry) {
			return { ok: false, reason: `No app registered under slug=${slug}` };
		}
		if (entry.isolation !== "worker") {
			return {
				ok: false,
				reason: `App ${slug} declared isolation:'${entry.isolation ?? "none"}'; nothing to spawn`,
			};
		}
		const view = await registry.getPermissionsView(slug);
		const pluginEntryPath = await resolvePluginEntryPath(entry);
		if (!pluginEntryPath) {
			return {
				ok: false,
				reason: `No worker plugin entry found for app ${slug} under ${entry.directory}`,
			};
		}
		const snapshot = await this.spawn({
			slug,
			isolation: "worker",
			statePath: path.join(this.stateDir, "app-state", slug),
			requestedPermissions: entry.requestedPermissions ?? null,
			grantedNamespaces: view?.grantedNamespaces ?? [],
			pluginEntryPath,
		});
		return { ok: true, snapshot };
	}
	/**
	 * Spawn a worker directly with explicit options. Used by tests and
	 * by `startForRegisteredApp`. If a worker already exists for the
	 * slug, returns its existing snapshot.
	 */
	async spawn(options) {
		const existing = this.workers.get(options.slug);
		if (existing) {
			await existing.readyPromise;
			return this.snapshot(existing);
		}
		const worker = new Worker(WORKER_ENTRY, {
			execArgv: WORKER_ENTRY.endsWith(".ts")
				? ["--experimental-strip-types"]
				: [],
			workerData: {
				slug: options.slug,
				isolation: options.isolation,
				statePath: options.statePath ?? null,
				requestedPermissions: options.requestedPermissions ?? null,
				grantedNamespaces: options.grantedNamespaces ?? [],
				pluginEntryPath: options.pluginEntryPath ?? null,
			},
		});
		const spawned = {
			slug: options.slug,
			worker,
			bootedAt: Date.now(),
			readyAt: null,
			pending: new Map(),
			nextId: 1,
			readyPromise: undefined,
		};
		spawned.readyPromise = new Promise((resolve, reject) => {
			const onMessage = (raw) => {
				if (typeof raw !== "object" || raw === null) return;
				const msg = raw;
				if (msg.id === 0) {
					if (msg.ok === true) {
						spawned.readyAt = Date.now();
						resolve();
					} else {
						reject(
							new Error(
								msg.reason ?? "Worker boot failed (no reason supplied)",
							),
						);
					}
					return;
				}
				const pending = spawned.pending.get(msg.id);
				if (!pending) return;
				spawned.pending.delete(msg.id);
				if (msg.ok) {
					pending.resolve({ ok: true, result: msg.result });
				} else {
					pending.reject(
						new Error(msg.reason ?? "Worker returned ok:false with no reason"),
					);
				}
			};
			worker.on("message", onMessage);
			worker.on("error", (raw) => {
				const error = raw instanceof Error ? raw : new Error(String(raw));
				logger.error(
					`[app-worker-host] worker for slug=${options.slug} errored: ${error.message}`,
				);
				if (spawned.readyAt === null) reject(error);
				for (const pending of spawned.pending.values()) {
					pending.reject(error);
				}
				spawned.pending.clear();
			});
			worker.on("exit", (code) => {
				this.workers.delete(options.slug);
				if (code !== 0 && spawned.readyAt === null) {
					reject(new Error(`Worker exited with code ${code} before ready`));
				}
				const exitErr = new Error(
					`Worker for slug=${options.slug} exited (code=${code})`,
				);
				for (const pending of spawned.pending.values()) {
					pending.reject(exitErr);
				}
				spawned.pending.clear();
			});
		});
		this.workers.set(options.slug, spawned);
		try {
			await spawned.readyPromise;
		} catch (error) {
			this.workers.delete(options.slug);
			await worker.terminate().catch(() => undefined);
			throw error;
		}
		return this.snapshot(spawned);
	}
	/**
	 * Send a typed RPC to the worker. Resolves with the worker's
	 * `{ok: true, result}` reply, or fails with a structured
	 * `{ok: false, reason}` if the worker rejected the call or the
	 * worker channel closed.
	 */
	async invoke(slug, method, params) {
		const spawned = this.workers.get(slug);
		if (!spawned) {
			return {
				ok: false,
				reason: `No worker spawned for slug=${slug}`,
				durationMs: 0,
			};
		}
		const id = spawned.nextId++;
		const startedAt = performance.now();
		try {
			const reply = await new Promise((resolve, reject) => {
				spawned.pending.set(id, { resolve, reject, startedAt });
				spawned.worker.postMessage({ id, method, params });
			});
			return {
				ok: true,
				result: reply.result,
				durationMs: performance.now() - startedAt,
			};
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
				durationMs: performance.now() - startedAt,
			};
		}
	}
	async stopWorker(slug) {
		const spawned = this.workers.get(slug);
		if (!spawned) return;
		const exitPromise = new Promise((resolve) => {
			spawned.worker.once("exit", () => resolve());
		});
		spawned.worker.postMessage({ id: spawned.nextId++, method: "shutdown" });
		const settled = await Promise.race([
			exitPromise.then(() => "exit"),
			new Promise((resolve) =>
				setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS),
			),
		]);
		if (settled === "timeout") {
			logger.warn(
				`[app-worker-host] worker for slug=${slug} did not exit in ${SHUTDOWN_GRACE_MS}ms; terminating`,
			);
			await spawned.worker.terminate();
		}
		this.workers.delete(slug);
	}
	list() {
		return Array.from(this.workers.values()).map((w) => this.snapshot(w));
	}
	async bootstrapRegisteredWorkers() {
		let registry = this.runtime.getService(APP_REGISTRY_SERVICE_TYPE);
		if (!registry) {
			registry = await this.runtime
				?.getServiceLoadPromise?.(APP_REGISTRY_SERVICE_TYPE)
				.catch(() => null);
		}
		if (!registry?.list) return;
		const entries = await registry.list();
		for (const entry of entries) {
			if (entry.isolation !== "worker") continue;
			const result = await this.startForRegisteredApp(entry.slug).catch(
				(error) => ({
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				}),
			);
			if (!result.ok) {
				logger.warn(
					`[app-worker-host] bootstrap spawn failed for slug=${entry.slug}: ${result.reason}`,
				);
			}
		}
	}
	snapshot(spawned) {
		return {
			slug: spawned.slug,
			pid: spawned.worker.threadId,
			bootedAt: new Date(spawned.bootedAt).toISOString(),
			readyMs:
				spawned.readyAt !== null ? spawned.readyAt - spawned.bootedAt : null,
		};
	}
}
export default AppWorkerHostService;
//# sourceMappingURL=app-worker-host-service.js.map
