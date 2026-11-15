/**
 * Central registry for system-permission state. Holds an in-memory map of
 * `PermissionState` keyed by `PermissionId`, hydrates from disk on boot,
 * persists changes (debounced), and exposes a pub/sub channel for the UI.
 *
 * Probers are pluggable — each `PermissionId` is wired to a `Prober` that
 * knows how to `check()` the OS state and `request()` user consent. The
 * registry is the single source of truth; native bridges register probers,
 * features call `recordBlock()` to surface why a permission is needed.
 */

import * as fs from "node:fs";
import path from "node:path";
import {
  ElizaError,
  type IAgentRuntime,
  type IPermissionsRegistry,
  logger,
  type PermissionId,
  type PermissionState,
  type Prober,
  resolveStateDir as resolveCoreStateDir,
  Service,
} from "@elizaos/core";

export type {
  IPermissionsRegistry,
  Prober,
} from "@elizaos/core";

export const PERMISSIONS_REGISTRY_SERVICE = "eliza_permissions_registry";

const PENDING_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 500;

function currentPlatform(): "darwin" | "win32" | "linux" {
  const p = process.platform;
  return p === "darwin" || p === "win32" || p === "linux" ? p : "linux";
}

function defaultStateFor(id: PermissionId): PermissionState {
  return {
    id,
    status: "not-determined",
    canRequest: true,
    lastChecked: Date.now(),
    platform: currentPlatform(),
  };
}

function resolveStateDir(): string {
  return resolveCoreStateDir();
}

function resolvePersistencePath(): string {
  return path.join(resolveStateDir(), "permissions.json");
}

interface PersistenceAdapter {
  read(): PermissionState[] | null;
  write(states: PermissionState[]): void;
}

class FilePersistenceAdapter implements PersistenceAdapter {
  constructor(private readonly filePath: string) {}

  read(): PermissionState[] | null {
    if (!fs.existsSync(this.filePath)) return null;
    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry): entry is PermissionState =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string",
    );
  }

  write(states: PermissionState[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(states, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}

export interface PermissionRegistryOptions {
  persistence?: PersistenceAdapter;
  /**
   * Override the debounce window for persistence writes. Tests pass `0` for
   * synchronous writes.
   */
  persistDebounceMs?: number;
}

export class PermissionRegistry
  extends Service
  implements IPermissionsRegistry
{
  static serviceType = PERMISSIONS_REGISTRY_SERVICE;

  static async start(runtime: IAgentRuntime): Promise<PermissionRegistry> {
    const instance = new PermissionRegistry(runtime);
    instance.hydrate();
    const { registerAllProbers } = await import(
      "./permissions/probers/index.js"
    );
    registerAllProbers(instance);
    return instance;
  }

  capabilityDescription =
    "Central registry for system permission state, probers, and pub/sub";

  private readonly states = new Map<PermissionId, PermissionState>();
  private readonly probers = new Map<PermissionId, Prober>();
  private readonly subscribers = new Set<(state: PermissionState[]) => void>();
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly persistence: PersistenceAdapter;
  private readonly persistDebounceMs: number;
  private readonly probes = new Map<PermissionId, Promise<PermissionState>>();
  private readonly settingsOperations = new Set<Promise<boolean>>();
  private stopped = false;
  private dirty = false;

  constructor(runtime: IAgentRuntime, options: PermissionRegistryOptions = {}) {
    super(runtime);
    this.persistence =
      options.persistence ??
      new FilePersistenceAdapter(resolvePersistencePath());
    this.persistDebounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
  }

  hydrate(): void {
    const loaded = this.persistence.read();
    if (!loaded) return;
    for (const state of loaded) {
      this.states.set(state.id, state);
    }
  }

  registerProber(prober: Prober): void {
    this.probers.set(prober.id, prober);
  }

  get(id: PermissionId): PermissionState {
    const existing = this.states.get(id);
    if (existing) return existing;
    const fresh = defaultStateFor(id);
    return fresh;
  }

  async check(id: PermissionId): Promise<PermissionState> {
    return this.probe(id, async (prober) => prober.check());
  }

  async request(
    id: PermissionId,
    opts: { reason: string; feature: { app: string; action: string } },
  ): Promise<PermissionState> {
    return this.probe(id, async (prober) => {
      const next = await prober.request({ reason: opts.reason });
      return {
        ...next,
        lastRequested: Date.now(),
        lastBlockedFeature: { ...opts.feature, at: Date.now() },
      };
    });
  }

  private requireRunning(): void {
    if (this.stopped)
      throw new ElizaError("Permission registry has stopped", {
        code: "PERMISSION_REGISTRY_STOPPED",
      });
  }

  private probe(
    id: PermissionId,
    operation: (prober: Prober) => Promise<PermissionState>,
  ): Promise<PermissionState> {
    this.requireRunning();
    const previous = this.probes.get(id) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        this.requireRunning();
        const prober = this.probers.get(id);
        if (!prober)
          throw new ElizaError(`No permission prober registered for ${id}`, {
            code: "PERMISSION_PROBER_UNAVAILABLE",
          });
        const next = await operation(prober);
        this.commit(id, next);
        return next;
      });
    this.probes.set(id, pending);
    const release = () => {
      if (this.probes.get(id) === pending) this.probes.delete(id);
    };
    // error-policy:J5 Callers observe the failure; bookkeeping never poisons later probes.
    void pending.then(release, release);
    return pending;
  }

  async openSettings(id: PermissionId): Promise<boolean> {
    this.requireRunning();
    const prober = this.probers.get(id);
    const openSettings = prober?.openSettings;
    if (!openSettings) return false;
    const pending = Promise.resolve().then(() => {
      this.requireRunning();
      return openSettings.call(prober);
    });
    this.settingsOperations.add(pending);
    const release = () => this.settingsOperations.delete(pending);
    // error-policy:J5 The caller observes failure; shutdown drains accepted native UI work.
    void pending.then(release, release);
    return pending;
  }

  recordBlock(
    id: PermissionId,
    feature: { app: string; action: string },
  ): void {
    const current = this.states.get(id) ?? defaultStateFor(id);
    const next: PermissionState = {
      ...current,
      lastBlockedFeature: {
        app: feature.app,
        action: feature.action,
        at: Date.now(),
      },
    };
    this.commit(id, next);
  }

  list(): PermissionState[] {
    return Array.from(this.states.values());
  }

  pending(): PermissionState[] {
    const cutoff = Date.now() - PENDING_BLOCK_WINDOW_MS;
    return this.list().filter((s) => {
      if (s.status === "not-determined") return true;
      if (s.lastBlockedFeature && s.lastBlockedFeature.at >= cutoff)
        return true;
      return false;
    });
  }

  subscribe(cb: (state: PermissionState[]) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Native probes have no cancellation API. Drain them but fence their late results.
    await Promise.allSettled([
      ...this.probes.values(),
      ...this.settingsOperations,
    ]);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flushPersist();
    this.subscribers.clear();
  }

  private commit(id: PermissionId, next: PermissionState): void {
    this.requireRunning();
    this.states.set(id, next);
    this.dirty = true;
    this.notify();
    this.schedulePersist();
  }

  private notify(): void {
    if (this.subscribers.size === 0) return;
    const snapshot = this.list();
    for (const sub of this.subscribers) {
      try {
        sub(snapshot);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "[PermissionRegistry] subscriber threw",
        );
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistDebounceMs <= 0) {
      this.flushPersist();
      return;
    }
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.flushPersist();
      } catch (error) {
        // error-policy:J7 Retain dirty state for the next mutation or stop retry.
        this.runtime.reportError("PermissionRegistry.persist", error);
      }
    }, this.persistDebounceMs);
    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
    }
  }

  private flushPersist(): void {
    if (!this.dirty) return;
    try {
      this.persistence.write(this.list());
      this.dirty = false;
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[PermissionRegistry] failed to persist state",
      );
      throw new ElizaError("Permission state persistence failed", {
        code: "PERMISSION_PERSIST_FAILED",
        cause: err,
      });
    }
  }
}
