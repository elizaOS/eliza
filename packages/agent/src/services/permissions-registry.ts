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
import * as os from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  IPermissionsRegistry,
  PermissionId,
  PermissionState,
  Prober,
} from "@elizaos/shared";

export type { IPermissionsRegistry, Prober } from "@elizaos/shared";

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
  const explicit = process.env.MILADY_STATE_DIR ?? process.env.ELIZA_STATE_DIR;
  if (explicit && explicit.trim()) return explicit;
  return path.join(os.homedir(), ".milady");
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
      "./permissions/register-probers.js"
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
    const prober = this.probers.get(id);
    if (!prober) {
      throw new Error(`[PermissionRegistry] no prober registered for ${id}`);
    }
    const next = await prober.check();
    this.commit(id, next);
    return next;
  }

  async request(
    id: PermissionId,
    opts: { reason: string; feature: { app: string; action: string } },
  ): Promise<PermissionState> {
    const prober = this.probers.get(id);
    if (!prober) {
      throw new Error(`[PermissionRegistry] no prober registered for ${id}`);
    }
    const next = await prober.request({ reason: opts.reason });
    const withRequest: PermissionState = {
      ...next,
      lastRequested: Date.now(),
      lastBlockedFeature: {
        app: opts.feature.app,
        action: opts.feature.action,
        at: Date.now(),
      },
    };
    this.commit(id, withRequest);
    return withRequest;
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
      if (s.lastBlockedFeature && s.lastBlockedFeature.at >= cutoff) return true;
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
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.flushPersist();
    }
  }

  private commit(id: PermissionId, next: PermissionState): void {
    this.states.set(id, next);
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
      this.flushPersist();
    }, this.persistDebounceMs);
    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
    }
  }

  private flushPersist(): void {
    try {
      this.persistence.write(this.list());
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[PermissionRegistry] failed to persist state",
      );
    }
  }
}
