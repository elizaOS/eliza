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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
	type IAgentRuntime,
	logger,
	resolveStateDir,
	Service,
} from "@elizaos/core";
import {
	APP_REGISTRY_SERVICE_TYPE,
	type AppRegistryEntry,
	type AppRegistryService,
} from "./app-registry-service.js";

export const APP_WORKER_HOST_SERVICE_TYPE = "app-worker-host";

export interface SpawnedWorkerSnapshot {
	slug: string;
	pid: number | null;
	bootedAt: string;
	readyMs: number | null;
}

export interface InvokeResult<T = unknown> {
	ok: true;
	result: T;
	durationMs: number;
}

export interface InvokeFailure {
	ok: false;
	reason: string;
	durationMs: number;
}

interface PendingCall {
	resolve: (value: { ok: true; result: unknown }) => void;
	reject: (error: Error) => void;
	startedAt: number;
}

interface SpawnedWorker {
	slug: string;
	worker: Worker;
	bootedAt: number;
	readyAt: number | null;
	pending: Map<number, PendingCall>;
	nextId: number;
	readyPromise: Promise<void>;
}

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

/**
 * Internal helper so tests can construct a worker without going
 * through the registry lookup path. Exposed via the service for the
 * Phase 2.2 fixture test that doesn't need a full registry to prove
 * the bridge round-trip.
 */
export interface SpawnOptions {
	slug: string;
	isolation: "none" | "worker";
	statePath?: string;
	requestedPermissions?: Record<string, unknown> | null;
	grantedNamespaces?: readonly string[];
	/**
	 * Absolute path to the app's plugin entry module. The worker
	 * dynamically imports this and registers any actions the export
	 * exposes. Omit to spawn a worker with only the in-line bridge
	 * methods (ping/echo) — useful for tests that don't need plugin
	 * loading.
	 */
	pluginEntryPath?: string;
}

export class AppWorkerHostService extends Service {
	static override serviceType = APP_WORKER_HOST_SERVICE_TYPE;

	override capabilityDescription =
		"Spawns and manages Bun workers for apps declaring isolation:'worker'. Phase 2 enforcement substrate.";

	private readonly workers = new Map<string, SpawnedWorker>();
	private readonly stateDir: string;

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
		this.stateDir = resolveStateDir();
	}

	static override async start(
		runtime: IAgentRuntime,
	): Promise<AppWorkerHostService> {
		return new AppWorkerHostService(runtime);
	}

	override async stop(): Promise<void> {
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
	async startForRegisteredApp(
		slug: string,
	): Promise<
		| { ok: true; snapshot: SpawnedWorkerSnapshot }
		| { ok: false; reason: string }
	> {
		const registry = this.runtime?.getService(APP_REGISTRY_SERVICE_TYPE) as
			| AppRegistryService
			| null
			| undefined;
		if (!registry) {
			return {
				ok: false,
				reason: "AppRegistryService is not registered on the runtime",
			};
		}
		const entries = await registry.list();
		const entry = entries.find((e: AppRegistryEntry) => e.slug === slug);
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
		const snapshot = await this.spawn({
			slug,
			isolation: "worker",
			statePath: path.join(this.stateDir, "app-state", slug),
			requestedPermissions: entry.requestedPermissions ?? null,
			grantedNamespaces: view?.grantedNamespaces ?? [],
		});
		return { ok: true, snapshot };
	}

	/**
	 * Spawn a worker directly with explicit options. Used by tests and
	 * by `startForRegisteredApp`. If a worker already exists for the
	 * slug, returns its existing snapshot.
	 */
	async spawn(options: SpawnOptions): Promise<SpawnedWorkerSnapshot> {
		const existing = this.workers.get(options.slug);
		if (existing) {
			await existing.readyPromise;
			return this.snapshot(existing);
		}

		const worker = new Worker(WORKER_ENTRY, {
			workerData: {
				slug: options.slug,
				isolation: options.isolation,
				statePath: options.statePath ?? null,
				requestedPermissions: options.requestedPermissions ?? null,
				grantedNamespaces: options.grantedNamespaces ?? [],
				pluginEntryPath: options.pluginEntryPath ?? null,
			},
		});

		const spawned: SpawnedWorker = {
			slug: options.slug,
			worker,
			bootedAt: Date.now(),
			readyAt: null,
			pending: new Map(),
			nextId: 1,
			readyPromise: undefined as unknown as Promise<void>,
		};
		spawned.readyPromise = new Promise<void>((resolve, reject) => {
			const onMessage = (raw: unknown) => {
				if (typeof raw !== "object" || raw === null) return;
				const msg = raw as {
					id: number;
					ok: boolean;
					result?: unknown;
					reason?: string;
				};
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
			worker.on("error", (raw: unknown) => {
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
	async invoke<T = unknown>(
		slug: string,
		method: string,
		params?: unknown,
	): Promise<InvokeResult<T> | InvokeFailure> {
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
			const reply = await new Promise<{ ok: true; result: unknown }>(
				(resolve, reject) => {
					spawned.pending.set(id, { resolve, reject, startedAt });
					spawned.worker.postMessage({ id, method, params });
				},
			);
			return {
				ok: true,
				result: reply.result as T,
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

	async stopWorker(slug: string): Promise<void> {
		const spawned = this.workers.get(slug);
		if (!spawned) return;

		const exitPromise = new Promise<void>((resolve) => {
			spawned.worker.once("exit", () => resolve());
		});
		spawned.worker.postMessage({ id: spawned.nextId++, method: "shutdown" });
		const settled = await Promise.race([
			exitPromise.then(() => "exit" as const),
			new Promise<"timeout">((resolve) =>
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

	list(): SpawnedWorkerSnapshot[] {
		return Array.from(this.workers.values()).map((w) => this.snapshot(w));
	}

	private snapshot(spawned: SpawnedWorker): SpawnedWorkerSnapshot {
		return {
			slug: spawned.slug,
			pid: spawned.worker.threadId ?? null,
			bootedAt: new Date(spawned.bootedAt).toISOString(),
			readyMs:
				spawned.readyAt !== null ? spawned.readyAt - spawned.bootedAt : null,
		};
	}
}

export default AppWorkerHostService;
