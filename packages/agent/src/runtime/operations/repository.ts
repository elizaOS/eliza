/**
 * Filesystem-backed RuntimeOperationRepository.
 *
 * Storage layout:
 *   <stateDir>/runtime-operations/<id>.json   one JSON file per operation
 *
 * Atomic writes: write to <id>.json.tmp.<pid> then rename — same pattern
 * the Eliza config uses (config.ts:saveElizaConfig).
 *
 * In-memory caches are populated lazily at first access from disk and kept
 * in sync on every mutation. They make `findActive` and
 * `findByIdempotencyKey` O(1) on the hot path.
 *
 * Hydration also reaps abandoned operations: anything still `pending` or
 * `running` whose `startedAt` is older than 24h is force-marked `failed`
 * with code `"abandoned"` (the process must have died mid-flight).
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import { resolveStateDir } from "../../config/paths.js";
import type {
  OperationPhase,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationRepository,
} from "./types.js";

const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

function operationsDirFor(stateDir: string): string {
  return path.join(stateDir, "runtime-operations");
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readJsonFile(filePath: string): RuntimeOperation | null {
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) {
    return null;
  }
  const parsed = JSON.parse(raw) as RuntimeOperation;
  if (!parsed.id || !parsed.kind || !Array.isArray(parsed.phases)) {
    return null;
  }
  return parsed;
}

function writeJsonAtomic(filePath: string, op: RuntimeOperation): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const content = `${JSON.stringify(op, null, 2)}\n`;
  fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

export class FilesystemRuntimeOperationRepository
  implements RuntimeOperationRepository
{
  private readonly dir: string;
  private readonly byId: Map<string, RuntimeOperation> = new Map();
  private readonly byIdempotencyKey: Map<string, string> = new Map();
  private activeId: string | null = null;
  private hydrated = false;

  constructor(stateDir: string = resolveStateDir()) {
    this.dir = operationsDirFor(stateDir);
  }

  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    ensureDir(this.dir);
    const entries = fs.readdirSync(this.dir);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const fullPath = path.join(this.dir, entry);
      const op = readJsonFile(fullPath);
      if (!op) continue;

      // Reap abandoned operations: a process died with this op still "live".
      const isLive = op.status === "pending" || op.status === "running";
      const isStale = now - op.startedAt > ABANDONED_AFTER_MS;
      if (isLive && isStale) {
        const reaped: RuntimeOperation = {
          ...op,
          status: "failed",
          finishedAt: now,
          error: {
            message: "Operation abandoned (process exited before completion)",
            code: "abandoned",
          },
        };
        writeJsonAtomic(fullPath, reaped);
        this.byId.set(reaped.id, reaped);
        if (reaped.idempotencyKey) {
          this.byIdempotencyKey.set(reaped.idempotencyKey, reaped.id);
        }
        logger.info(
          `[runtime-ops] Reaped abandoned operation on hydrate: ${reaped.id}`,
        );
        continue;
      }

      this.byId.set(op.id, op);
      if (op.idempotencyKey) {
        this.byIdempotencyKey.set(op.idempotencyKey, op.id);
      }
      if (isLive && !this.activeId) {
        this.activeId = op.id;
      }
    }
  }

  private pathFor(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private persist(op: RuntimeOperation): void {
    writeJsonAtomic(this.pathFor(op.id), op);
  }

  private syncActiveSlot(op: RuntimeOperation): void {
    const isLive = op.status === "pending" || op.status === "running";
    if (isLive) {
      this.activeId = op.id;
      return;
    }
    if (this.activeId === op.id) {
      this.activeId = null;
    }
  }

  async create(op: RuntimeOperation): Promise<void> {
    this.hydrate();
    if (this.byId.has(op.id)) {
      throw new Error(`[runtime-ops] Operation already exists: ${op.id}`);
    }
    this.persist(op);
    this.byId.set(op.id, op);
    if (op.idempotencyKey) {
      this.byIdempotencyKey.set(op.idempotencyKey, op.id);
    }
    this.syncActiveSlot(op);
  }

  async update(
    id: string,
    patch: Partial<
      Omit<RuntimeOperation, "id" | "phases" | "intent" | "kind">
    >,
  ): Promise<void> {
    this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    const next: RuntimeOperation = { ...current, ...patch };
    this.persist(next);
    this.byId.set(id, next);
    this.syncActiveSlot(next);
  }

  async appendPhase(id: string, phase: OperationPhase): Promise<void> {
    this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    const next: RuntimeOperation = {
      ...current,
      phases: [...current.phases, phase],
    };
    this.persist(next);
    this.byId.set(id, next);
  }

  async updateLastPhase(
    id: string,
    patch: Partial<OperationPhase>,
  ): Promise<void> {
    this.hydrate();
    const current = this.byId.get(id);
    if (!current) {
      throw new Error(`[runtime-ops] Operation not found: ${id}`);
    }
    if (current.phases.length === 0) {
      throw new Error(
        `[runtime-ops] Cannot update last phase — no phases on op ${id}`,
      );
    }
    const last = current.phases[current.phases.length - 1];
    if (!last) {
      throw new Error(
        `[runtime-ops] Cannot update last phase — phase array empty on ${id}`,
      );
    }
    const merged: OperationPhase = { ...last, ...patch };
    const phases = [...current.phases.slice(0, -1), merged];
    const next: RuntimeOperation = { ...current, phases };
    this.persist(next);
    this.byId.set(id, next);
  }

  async get(id: string): Promise<RuntimeOperation | null> {
    this.hydrate();
    return this.byId.get(id) ?? null;
  }

  async list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]> {
    this.hydrate();
    let ops = Array.from(this.byId.values());
    if (opts?.status) {
      ops = ops.filter((o) => o.status === opts.status);
    } else if (opts?.includeTerminal === false) {
      ops = ops.filter(
        (o) => o.status === "pending" || o.status === "running",
      );
    }
    ops.sort((a, b) => b.startedAt - a.startedAt);
    if (typeof opts?.limit === "number" && opts.limit >= 0) {
      ops = ops.slice(0, opts.limit);
    }
    return ops;
  }

  async findByIdempotencyKey(key: string): Promise<RuntimeOperation | null> {
    this.hydrate();
    const id = this.byIdempotencyKey.get(key);
    if (!id) return null;
    const op = this.byId.get(id);
    if (!op) return null;
    if (Date.now() - op.startedAt > IDEMPOTENCY_RETENTION_MS) {
      return null;
    }
    return op;
  }

  async findActive(): Promise<RuntimeOperation | null> {
    this.hydrate();
    if (!this.activeId) return null;
    const op = this.byId.get(this.activeId);
    if (!op) {
      this.activeId = null;
      return null;
    }
    if (op.status !== "pending" && op.status !== "running") {
      this.activeId = null;
      return null;
    }
    return op;
  }
}

let cachedDefault: FilesystemRuntimeOperationRepository | null = null;

/**
 * Lazy per-process singleton. Constructed on first call so tests can swap
 * the env or provide their own repository before the manager is built.
 */
export function getDefaultRepository(): FilesystemRuntimeOperationRepository {
  if (!cachedDefault) {
    cachedDefault = new FilesystemRuntimeOperationRepository();
  }
  return cachedDefault;
}
