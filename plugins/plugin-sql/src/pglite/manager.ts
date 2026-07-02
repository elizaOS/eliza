import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { live } from "@electric-sql/pglite/live";
import { vector } from "@electric-sql/pglite/vector";
import { electricSync } from "@electric-sql/pglite-sync";
import { logger } from "@elizaos/core";
import type { IDatabaseClientManager } from "../types";
import { WriteBackService } from "../write-back";
import { createPgliteInitError, PGLITE_ERROR_CODES } from "./errors";

/**
 * Canonical list of table names synced via Electric and tracked by the
 * write-back service. Used by both syncShapesToTables (read path) and
 * PgliteDatabaseAdapter (write path) so the two stay in sync.
 */
export const SYNCED_TABLE_NAMES = [
  "agents",
  "entities",
  "worlds",
  "rooms",
  "participants",
  "memories",
  "relationships",
  "tasks",
] as const satisfies readonly string[];

type PglitePidFileStatus =
  | "missing"
  | "active"
  | "active-unconfirmed"
  | "cleared-stale"
  | "cleared-malformed"
  | "check-failed";

interface PgliteDataDirLockInfo {
  pid: number | null;
  createdAt: number | null;
  bootId: string | null;
  processStartTicks: string | null;
}

/**
 * Runtime sync status of the Electric Sync client wired into PGlite.
 * - syncing: the sync stream is connecting or catching up with the source.
 * - synced: the local PGlite is up-to-date with the Electric source.
 * - error: the sync stream encountered a non-recoverable error.
 * - disabled: no ELIZA_ELECTRIC_SYNC_URL was configured at boot.
 */
export type PgliteSyncStatus = "syncing" | "synced" | "error" | "disabled";

/** Per-table sync state. */
export type PgliteSyncTableState = "pending" | "synced" | "error";

/** Per-table status map exposed by getSyncStatus(). */
export type PgliteSyncTableStatus = Record<string, { state: PgliteSyncTableState; error?: string }>;

/**
 * Result row type for live queries. Matches the shape returned by
 * {@link https://pglite.dev/docs/live-queries | pg.live.query()}.
 */
export interface LiveQueryResult<T = Record<string, unknown>> {
  rows: T[];
  fields: { name: string; dataTypeID: number }[];
  affectedRows?: number;
}

/**
 * Return value from {@link https://pglite.dev/docs/live-queries | pg.live.query()}.
 */
export interface LiveQueryReturn<T = Record<string, unknown>> {
  initialResults: LiveQueryResult<T>;
  unsubscribe: () => Promise<void>;
  refresh: (options?: { offset?: number; limit?: number }) => Promise<void>;
}

/**
 * The `pg.live` namespace added by the `@electric-sql/pglite/live` extension.
 */
export interface LiveNamespace {
  query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] | undefined,
    callback: (result: LiveQueryResult<T>) => void
  ): Promise<LiveQueryReturn<T>>;
  incrementalQuery<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] | undefined,
    key: string,
    callback: (result: LiveQueryResult<T>) => void
  ): Promise<LiveQueryReturn<T>>;
  changes<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] | undefined,
    key: string,
    callback: (changes: unknown[]) => void
  ): Promise<LiveQueryReturn<T>>;
}

export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  // A lock whose liveness we cannot positively confirm (EPERM / non-ESRCH probe
  // error, i.e. a possibly recycled cross-user PID) and whose recorded createdAt
  // is older than this window is treated as stale, so a recycled PID cannot
  // permanently brick boot. Confirmed-live PIDs are honored regardless of age.
  // 7 days comfortably exceeds any real unconfirmable window while still
  // bounding the false-positive blast radius. See isLockActive.
  private static readonly LOCK_STALE_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly PID_REUSE_GRACE_MS = 5_000;

  private client: PGlite;
  private options: PGliteOptions;
  private shuttingDown = false;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private lockFd: number | null = null;
  private lockPath: string | null = null;
  private syncUrl: string | null;
  private agentId: string | null;
  private syncStatus: PgliteSyncStatus = "disabled";
  private syncError: string | null = null;
  private syncUnsubscribe: (() => void) | null = null;
  private syncTableStates: PgliteSyncTableStatus = {};
  private syncedTables: string[] = [];
  // Serializes calls to startSync() so concurrent forceResync() / ensureSync()
  // calls don't race into syncShapesToTables ("Already syncing shape" errors).
  private startSyncMutex: Promise<void> | null = null;
  // Serializes the full forceResync() operation so concurrent calls don't race
  // into unsubscribe + DROP SCHEMA ("electric.subscriptions_metadata does not
  // exist" when the extension hasn't drained before DROP CASCADE).
  private forceResyncMutex: ReturnType<PGliteClientManager["forceResync"]> | null = null;
  // Write-back service: forwards local PGlite writes to the cloud API
  // (Electric Pattern 1 — Online Writes) for bidirectional sync.
  private writeBack: WriteBackService;

  constructor(
    options: PGliteOptions & {
      syncUrl?: string;
      agentId?: string;
      writeBackBaseUrl?: string;
      serviceKey?: string;
    }
  ) {
    this.options = options;
    this.syncUrl = options.syncUrl ?? null;
    this.agentId = options.agentId ?? null;
    this.writeBack = new WriteBackService({
      writeBaseUrl: options.writeBackBaseUrl,
      agentId: options.agentId,
      serviceKey: options.serviceKey,
    });
    this.acquireDataDirLockIfNeeded();
    try {
      this.client = this.createClient(options);
      this.setupShutdownHandlers();
    } catch (err) {
      // If client creation (WASM/FS init) throws, no reference to this manager
      // escapes the constructor, so close() can never run. Release the data-dir
      // lock here so the open fd and on-disk lock file don't leak — otherwise a
      // same-process retry would self-deadlock on its own (still-running) PID.
      this.releaseDataDirLock();
      throw err;
    }
  }

  public getConnection(): PGlite {
    return this.client;
  }

  /**
   * Access the write-back service for forwarding local writes to the
   * cloud API. Returns null when write-back is not configured.
   */
  public getWriteBack(): WriteBackService | null {
    return this.writeBack.enabled ? this.writeBack : null;
  }

  /**
   * Notify the write-back service of a local write to a sync table.
   * Called by the adapter after a successful write operation.
   * No-op when write-back is not configured.
   */
  public notifyWrite(
    table: string,
    operation: "insert" | "upsert" | "delete",
    row: Record<string, unknown>
  ): void {
    this.writeBack.enqueue(table, operation, row);
  }

  /**
   * Current Electric Sync status.
   * - "disabled": no ELIZA_ELECTRIC_SYNC_URL was configured.
   * - "syncing": sync client is connecting or catching up.
   * - "synced": local PGlite is up-to-date with the Electric source.
   * - "error": sync encountered an error (see syncError).
   *
   * Also returns per-table state so operators can see which specific
   * tables are healthy vs errored vs still pending.
   */
  public getSyncStatus(): {
    status: PgliteSyncStatus;
    error: string | null;
    tables: PgliteSyncTableStatus;
    synced: string[];
  } {
    return {
      status: this.syncStatus,
      error: this.syncError,
      tables: { ...this.syncTableStates },
      synced: [...this.syncedTables],
    };
  }

  public isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.initializePromise) {
      this.initializePromise = this.initializeInternal().finally(() => {
        this.initializePromise = null;
      });
    }

    await this.initializePromise;
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    // Flush pending write-backs before tearing down.
    if (this.writeBack.enabled) {
      try {
        await this.writeBack.flush();
      } catch {}
    }
    // Drain any in-progress startSync before we tear down.
    if (this.startSyncMutex) {
      try {
        await this.startSyncMutex;
      } catch {}
    }
    if (this.syncUnsubscribe) {
      try {
        this.syncUnsubscribe();
      } catch {}
      this.syncUnsubscribe = null;
    }
    // Allow the sync extension's async teardown (network abort handlers,
    // final subscription-metadata writes) to settle before we close the
    // database. A single setTimeout(0) is insufficient — the extension uses
    // network I/O whose abort + cleanup can take multiple event-loop ticks.
    await new Promise((r) => setTimeout(r, 50));
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
    this.releaseDataDirLock();
  }

  private setupShutdownHandlers() {}

  private createClient(options: PGliteOptions): PGlite {
    // PGlite's in-memory mode is the `memory://` URL. `:memory:` is SQLite
    // syntax that PGlite does NOT recognize, so it treats it as a real path and
    // its NodeFS mkdir()s `resolve(":memory:")` — which throws EINVAL on Windows
    // (the `:` is reserved) and silently creates a junk `:memory:` dir on POSIX.
    // Translate to the URL form so in-memory actually stays in memory.
    if ((options as { dataDir?: unknown }).dataDir === ":memory:") {
      options = { ...options, dataDir: "memory://" };
    }
    if (process.env.ELIZA_PGLITE_DISABLE_EXTENSIONS === "1") {
      return new PGlite(options);
    }
    // When ELIZA_ELECTRIC_SYNC_URL is set (or syncUrl was passed in options),
    // register the electricSync extension so the PGlite instance can sync.
    const syncUrl = this.syncUrl ?? process.env.ELIZA_ELECTRIC_SYNC_URL ?? null;
    const extensions = {
      ...(options.extensions ?? {}),
      vector,
      fuzzystrmatch,
      // Only load the `live` extension when Electric sync is configured — its
      // live-query namespace is only used by the sync/dashboard paths, so the
      // default local-dev PGlite boot pays nothing for it.
      ...(syncUrl ? { electric: electricSync(), live } : {}),
    } as PGliteOptions["extensions"];
    return new PGlite({
      ...options,
      extensions,
    });
  }

  private getDataDir(): string | null {
    const optionsWithDataDir = this.options as PGliteOptions & {
      dataDir?: unknown;
      dataPath?: unknown;
    };

    const dataDir = optionsWithDataDir.dataDir ?? optionsWithDataDir.dataPath;
    return typeof dataDir === "string" ? dataDir : null;
  }

  private isFileBackedDataDir(dataDir: string | null): dataDir is string {
    if (!dataDir) {
      return false;
    }

    if (dataDir.includes("://")) {
      return false;
    }

    if (dataDir === ":memory:") {
      return false;
    }

    return true;
  }

  private getDataDirLockPath(dataDir: string): string {
    return `${dataDir}/eliza-pglite.lock`;
  }

  private getLockInfo(lockPath: string): PgliteDataDirLockInfo {
    try {
      const raw = readFileSync(lockPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        pid?: unknown;
        createdAt?: unknown;
        bootId?: unknown;
        processStartTicks?: unknown;
      };
      const pid = typeof parsed.pid === "number" && parsed.pid > 0 ? parsed.pid : null;
      const createdAtMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
      const createdAt = Number.isNaN(createdAtMs) ? null : createdAtMs;
      const bootId =
        typeof parsed.bootId === "string" && parsed.bootId.length > 0 ? parsed.bootId : null;
      const processStartTicks =
        typeof parsed.processStartTicks === "string" && /^\d+$/.test(parsed.processStartTicks)
          ? parsed.processStartTicks
          : null;
      return { pid, createdAt, bootId, processStartTicks };
    } catch {
      return { pid: null, createdAt: null, bootId: null, processStartTicks: null };
    }
  }

  private readLinuxBootId(): string | null {
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return bootId.length > 0 ? bootId : null;
    } catch {
      return null;
    }
  }

  private readLinuxUptimeSeconds(): number | null {
    try {
      const raw = readFileSync("/proc/uptime", "utf-8").trim().split(/\s+/)[0];
      const uptimeSeconds = Number.parseFloat(raw ?? "");
      return Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? uptimeSeconds : null;
    } catch {
      return null;
    }
  }

  private readLinuxProcStartTicks(pid: number | "self"): string | null {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const commEnd = stat.lastIndexOf(")");
      if (commEnd === -1) {
        return null;
      }
      const fieldsAfterComm = stat
        .slice(commEnd + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fieldsAfterComm[19];
      return startTicks && /^\d+$/.test(startTicks) ? startTicks : null;
    } catch {
      return null;
    }
  }

  private estimateLinuxClockTicksPerSecond(): number | null {
    const selfStartTicks = this.readLinuxProcStartTicks("self");
    const uptimeSeconds = this.readLinuxUptimeSeconds();
    if (!selfStartTicks || uptimeSeconds === null) {
      return null;
    }

    const selfStartSecondsAfterBoot = uptimeSeconds - process.uptime();
    if (!Number.isFinite(selfStartSecondsAfterBoot) || selfStartSecondsAfterBoot <= 0) {
      return null;
    }

    const ticksPerSecond = Number(selfStartTicks) / selfStartSecondsAfterBoot;
    return Number.isFinite(ticksPerSecond) && ticksPerSecond > 0 ? ticksPerSecond : null;
  }

  private readLinuxProcessStartedAtMs(pid: number): number | null {
    const processStartTicks = this.readLinuxProcStartTicks(pid);
    const uptimeSeconds = this.readLinuxUptimeSeconds();
    const ticksPerSecond = this.estimateLinuxClockTicksPerSecond();
    if (!processStartTicks || uptimeSeconds === null || ticksPerSecond === null) {
      return null;
    }

    const bootStartedAtMs = Date.now() - uptimeSeconds * 1000;
    return bootStartedAtMs + (Number(processStartTicks) / ticksPerSecond) * 1000;
  }

  private isLockPidReuseProven(pid: number, createdAt: number | null): boolean {
    if (createdAt === null) {
      return false;
    }

    const processStartedAt = this.readLinuxProcessStartedAtMs(pid);
    return (
      processStartedAt !== null &&
      processStartedAt - createdAt > PGliteClientManager.PID_REUSE_GRACE_MS
    );
  }

  /**
   * Decide whether an existing lock should be honored as held by a live owner.
   *
   * Single-writer safety comes first: a confirmed-running PID whose recorded
   * process identity still matches is honored regardless of lock age. A
   * long-running agent (days or weeks of uptime) must never have its live lock
   * reclaimed by a second manager.
   *
   * Bare PID liveness alone is not enough in containers: after an unclean
   * shutdown, the next container can reuse pid 1, making `kill(1, 0)` look
   * live forever. New locks therefore record Linux boot id + `/proc` process
   * start ticks. Legacy locks are also protected by comparing their createdAt
   * timestamp against the currently-live PID's `/proc/<pid>/stat` start time:
   * if the PID started after the lock was written, it cannot be the owner.
   *
   * The staleness window only rescues the *unconfirmable* case. A bare
   * `process.kill(pid, 0)` is vulnerable to PID reuse, and a recycled
   * cross-user PID surfaces as `EPERM` (or another non-`ESRCH` error) rather
   * than a clean success. For those we cannot prove the PID belongs to a live
   * Eliza process, so we fall back to `createdAt`: a recent lock is still
   * respected, but one older than `LOCK_STALE_MS` (or with no usable timestamp)
   * is treated as stale and reclaimed so an aliased PID cannot brick boot
   * forever. `ESRCH` is unambiguous — the process is gone and the lock is stale.
   */
  private isLockActive(lockInfo: PgliteDataDirLockInfo): boolean {
    const { pid, createdAt, bootId, processStartTicks } = lockInfo;
    if (!pid) {
      return false;
    }

    const currentBootId = this.readLinuxBootId();
    if (bootId && currentBootId && bootId !== currentBootId) {
      return false;
    }

    if (processStartTicks) {
      const currentProcessStartTicks = this.readLinuxProcStartTicks(pid);
      if (currentProcessStartTicks && currentProcessStartTicks !== processStartTicks) {
        return false;
      }
    } else if (this.isLockPidReuseProven(pid, createdAt)) {
      return false;
    }

    try {
      process.kill(pid, 0);
      // Confirmed alive with matching identity -> preserve single-writer.
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Definitely gone -> reclaim.
        return false;
      }
      // Unconfirmable liveness (EPERM, etc.): honor only a recent lock; an old
      // or timestamp-less one is treated as stale so boot can recover.
      if (createdAt === null) {
        return false;
      }
      return Date.now() - createdAt < PGliteClientManager.LOCK_STALE_MS;
    }
  }

  /**
   * Mobile embedded runtimes (iOS/Android local backend) are single-tenant:
   * Bun runs as a thread inside the ONE app process and `ElizaBunRuntime`
   * serializes engine starts, so a leftover `eliza-pglite.lock` is by
   * definition stale — from a prior app launch, or a prior Bun thread in this
   * same process. The `process.kill(pid, 0)` liveness heuristic below is
   * unusable there: a prior launch's PID probes as EPERM inside the iOS
   * sandbox (honored for LOCK_STALE_MS = 7 days → every relaunch bricks with
   * "PGlite data dir is already in use", the #11030 post-engine-fix on-device
   * failure), and a prior Bun thread's PID equals the CURRENT app PID
   * (probes alive forever). Mirrors the identical mobile carve-out in the
   * postmaster.pid reconciliation below.
   */
  private isSingleTenantMobileEmbedded(): boolean {
    return (
      process.env.ELIZA_IOS_LOCAL_BACKEND === "1" || process.env.ELIZA_ANDROID_LOCAL_BACKEND === "1"
    );
  }

  private acquireDataDirLockIfNeeded(): void {
    const dataDir = this.getDataDir();
    if (!this.isFileBackedDataDir(dataDir)) {
      return;
    }

    mkdirSync(dataDir, { recursive: true });
    const lockPath = this.getDataDirLockPath(dataDir);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, "wx");
        writeFileSync(
          fd,
          `${JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
            dataDir,
            bootId: this.readLinuxBootId() ?? undefined,
            processStartTicks: this.readLinuxProcStartTicks("self") ?? undefined,
          })}\n`
        );
        this.lockFd = fd;
        this.lockPath = lockPath;
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          throw this.createActiveLockError(dataDir, err);
        }

        const lockInfo = this.getLockInfo(lockPath);
        const { pid } = lockInfo;
        if (this.isSingleTenantMobileEmbedded()) {
          logger.info(
            { src: "plugin:sql", dataDir, lockPath, pid },
            "Mobile embedded mode: reclaiming leftover PGlite lock file"
          );
        } else if (this.isLockActive(lockInfo)) {
          throw this.createActiveLockError(
            dataDir,
            new Error(`PGlite lock file is held by running process ${pid}`)
          );
        }

        try {
          unlinkSync(lockPath);
          logger.debug(
            { src: "plugin:sql", dataDir, lockPath, pid },
            "Removed stale PGlite lock file"
          );
        } catch (unlinkErr) {
          throw this.createActiveLockError(dataDir, unlinkErr);
        }
      }
    }

    throw this.createActiveLockError(dataDir, new Error("Could not acquire PGlite lock file"));
  }

  private releaseDataDirLock(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
    }

    if (this.lockPath) {
      try {
        unlinkSync(this.lockPath);
      } catch {}
      this.lockPath = null;
    }
  }

  private getErrorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object") {
      const obj = error as { message?: unknown; toString?: unknown };
      if (typeof obj.message === "string" && obj.message.length > 0) {
        return obj.message;
      }
      try {
        const json = JSON.stringify(error);
        if (json && json !== "{}") {
          return json;
        }
      } catch {}
      if (typeof obj.toString === "function") {
        const stringified = obj.toString.call(error);
        if (stringified && stringified !== "[object Object]") {
          return stringified;
        }
      }
    }
    return String(error);
  }

  private reconcilePglitePidFile(dataDir: string): PglitePidFileStatus {
    const pidPath = `${dataDir}/postmaster.pid`;
    if (!existsSync(pidPath)) {
      return "missing";
    }

    // iOS embedded mode is single-tenant: Bun runs as a thread inside the
    // host app process, and ElizaBunRuntime serializes engine starts. Any
    // leftover postmaster.pid is by definition stale — either from a prior
    // app launch, or from a prior Bun thread in this same process that
    // already exited. The standard `process.kill(pid, 0)` heuristic
    // produces false positives here because the recorded PID matches the
    // current iOS app PID.
    // Mobile embedded modes (iOS and Android) are single-tenant: each app
    // launch spawns a fresh Bun process, so any leftover postmaster.pid is
    // always stale.  The process.kill(pid, 0) heuristic below can produce
    // false positives on both platforms (iOS: same-process PID; Android:
    // EPERM instead of ESRCH for cross-UID pids), so clear unconditionally.
    if (
      process.env.ELIZA_IOS_LOCAL_BACKEND === "1" ||
      process.env.ELIZA_ANDROID_LOCAL_BACKEND === "1"
    ) {
      try {
        unlinkSync(pidPath);
        logger.info(
          { src: "plugin:sql", dataDir, pidPath },
          "Mobile embedded mode: removed leftover PGlite postmaster.pid"
        );
        return "cleared-stale";
      } catch (err) {
        logger.warn(
          { src: "plugin:sql", dataDir, error: this.getErrorText(err) },
          "Mobile embedded mode: failed to remove postmaster.pid"
        );
        return "check-failed";
      }
    }

    try {
      const content = readFileSync(pidPath, "utf-8");
      const firstLine = content.split("\n")[0]?.trim();
      const pid = parseInt(firstLine, 10);

      if (Number.isNaN(pid) || pid <= 0) {
        unlinkSync(pidPath);
        logger.debug(
          { src: "plugin:sql", dataDir, pidPath },
          "Removed malformed PGlite postmaster.pid"
        );
        return "cleared-malformed";
      }

      try {
        process.kill(pid, 0);
        logger.warn(
          { src: "plugin:sql", dataDir, pid },
          "PGlite data dir is already in use by another process"
        );
        return "active";
      } catch (killErr: unknown) {
        const code = (killErr as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          unlinkSync(pidPath);
          logger.info({ src: "plugin:sql", dataDir, pid }, "Removed stale PGlite postmaster.pid");
          return "cleared-stale";
        }
        logger.warn(
          { src: "plugin:sql", dataDir, pid, code },
          "Cannot confirm PGlite postmaster.pid ownership"
        );
        return "active-unconfirmed";
      }
    } catch (err) {
      logger.warn(
        {
          src: "plugin:sql",
          dataDir,
          error: this.getErrorText(err),
        },
        "Failed to inspect PGlite postmaster.pid"
      );
      return "check-failed";
    }
  }

  private createActiveLockError(dataDir: string, cause: unknown): Error {
    return createPgliteInitError(
      PGLITE_ERROR_CODES.ACTIVE_LOCK,
      `PGlite data dir is already in use at ${dataDir}. Close the other Eliza process, or point PGLITE_DATA_DIR at a different directory before retrying.`,
      { cause, dataDir }
    );
  }

  private createManualResetRequiredError(dataDir: string, cause: unknown): Error {
    const errorText = this.getErrorText(cause);
    const corruptCause = createPgliteInitError(
      PGLITE_ERROR_CODES.CORRUPT_DATA,
      `PGlite data dir at ${dataDir} appears corrupt or unreadable: ${errorText}`,
      { cause, dataDir }
    );
    return createPgliteInitError(
      PGLITE_ERROR_CODES.MANUAL_RESET_REQUIRED,
      `PGlite initialization failed for ${dataDir}: ${errorText}. Stop Eliza, then rename or delete only this directory before retrying: ${dataDir}`,
      { cause: corruptCause, dataDir }
    );
  }

  private async queryMigrationsSchema(): Promise<void> {
    await this.client.query("CREATE SCHEMA IF NOT EXISTS migrations");
    this.initialized = true;
  }

  /**
   * Ensure the Electric Sync stream is started. Idempotent — safe to call
   * on every database operation. The first call after PGlite is initialized
   * and after migrations have created the target tables will start the sync
   * stream; subsequent calls are no-ops.
   *
   * This is deliberately separate from {@link initialize} because the Drizzle
   * migrations that create the target tables run AFTER plugin init completes.
   * Starting sync during init would try to insert into non-existent tables.
   */
  public async ensureSync(): Promise<void> {
    // Already started or PGlite not initialized yet — no-op.
    if (this.syncUnsubscribe) return;
    if (!this.initialized) return;
    // startSync() handles its own guards: missing syncUrl → "disabled",
    // missing agentId → "error", double-call → no-op. It also resets
    // syncStatus/syncError on entry, so calling it after a transient
    // error safely retries the sync stream.
    await this.startSync();
  }

  /**
   * Access the PGlite live query namespace for reactive queries that
   * push updated results whenever the underlying tables change. Useful
   * for dashboard health endpoints and real-time monitoring.
   *
   * Returns the {@link https://pglite.dev/docs/live-queries | pg.live}
   * namespace, which provides:
   *   - `live.query(sql, params, callback)` — simple live query
   *   - `live.incrementalQuery(sql, params, key, callback)` — diff-based
   *   - `live.changes(sql, params, key, callback)` — raw change stream
   *
   * Returns null when PGlite extensions are disabled.
   */
  public liveQuery(): LiveNamespace | null {
    // Cast through unknown because the PGlite type doesn't declare the
    // `live` namespace added by the extension at runtime.
    const clientWithLive = this.client as PGlite & {
      live?: LiveNamespace;
    };
    return clientWithLive.live ?? null;
  }

  /**
   * Force-reset the Electric Sync stream: unsubscribe, drop all internal
   * sync state from the `electric` schema, and restart from scratch.
   *
   * Use this when operators diagnose a split-brain scenario (local PGlite
   * has diverged from the source Postgres) or when the sync stream is
   * stuck in an unrecoverable error state. The local data in the synced
   * tables is preserved — only the Electric metadata tables are dropped,
   * forcing a full re-sync that reconstructs state from the source.
   *
   * Returns the sync status after the reset. When sync is not configured
   * (no ELIZA_ELECTRIC_SYNC_URL), returns null.
   */
  public async forceResync(): Promise<{
    status: PgliteSyncStatus;
    error: string | null;
    tables: PgliteSyncTableStatus;
    synced: string[];
  } | null> {
    // Serialize the full forceResync operation so concurrent calls don't
    // race into unsubscribe + DROP SCHEMA before the extension has drained.
    if (this.forceResyncMutex) return this.forceResyncMutex;
    this.forceResyncMutex = this.forceResyncInternal();
    try {
      return await this.forceResyncMutex;
    } finally {
      this.forceResyncMutex = null;
    }
  }

  private async forceResyncInternal(): Promise<{
    status: PgliteSyncStatus;
    error: string | null;
    tables: PgliteSyncTableStatus;
    synced: string[];
  } | null> {
    const syncUrl = this.syncUrl ?? process.env.ELIZA_ELECTRIC_SYNC_URL ?? null;
    if (!syncUrl) return null;
    if (!this.initialized) return null;

    // 1. Unsubscribe the current sync stream.
    if (this.syncUnsubscribe) {
      try {
        this.syncUnsubscribe();
      } catch {}
      this.syncUnsubscribe = null;
      // Let the sync extension drain in-flight network operations before we
      // drop the schema it depends on. A single setTimeout(0) is insufficient
      // — the extension uses network I/O whose abort + final teardown can take
      // multiple event-loop ticks. A modest delay prevents "electric.
      // subscriptions_metadata does not exist" when DROP CASCADE removes it
      // while the extension is still writing teardown bookmarks.
      await new Promise((r) => setTimeout(r, 50));
    }

    // 2. Drop the Electric metadata schema so the sync stream loses its
    //    last-known offset and shape state. CASCADE removes all dependent
    //    objects (tables, functions, sequences) that the electricSync
    //    extension created in this schema.
    try {
      await this.client.query("DROP SCHEMA IF EXISTS electric CASCADE");
      logger.info({ src: "plugin:sql", syncUrl }, "Dropped electric schema — sync state reset");
    } catch (err) {
      logger.warn(
        { src: "plugin:sql", error: this.getErrorText(err) },
        "Failed to drop electric schema during force re-sync — continuing"
      );
    }

    // 3. Start a fresh sync stream. startSyncInternal() resets
    //    syncTableStates, syncedTables, syncStatus and syncError
    //    itself, so we don't need a separate state reset here.
    //    (A redundant reset races with concurrent forceResync calls.)
    await this.startSync();

    return this.getSyncStatus();
  }

  /**
   * Start the Electric Sync stream after PGlite is initialized.
   * Uses the official multi-table {@link https://pglite.dev/docs/sync#multi-table-sync | syncShapesToTables}
   * API so all shape updates that happened in a single Postgres transaction
   * are applied in a single PGlite transaction, preserving consistency
   * across all runtime tables.
   *
   * Each shape is filtered by agent_id so that in a shared-Neon deployment
   * an agent only syncs its own data — preserving per-agent physical isolation
   * even though the source Postgres is multi-tenant.
   *
   * Sync failures are non-fatal: the agent runs on its local PGlite
   * regardless of sync health. Per-table error state is tracked so
   * operators can diagnose individual table issues without assuming
   * the entire sync is broken.
   */
  private async startSync(): Promise<void> {
    const syncUrl = this.syncUrl ?? process.env.ELIZA_ELECTRIC_SYNC_URL ?? null;
    if (!syncUrl) {
      this.syncStatus = "disabled";
      return;
    }

    // Guard: don't start sync during shutdown — close() is tearing down.
    if (this.shuttingDown) return;

    // Serialize concurrent startSync() calls. forceResync() unsets
    // syncUnsubscribe before calling startSync(), so the old guard was
    // insufficient — two forceResync()s could race past it. A promise
    // mutex ensures only one call to syncShapesToTables at a time.
    if (this.startSyncMutex) return this.startSyncMutex;
    this.startSyncMutex = this.startSyncInternal(syncUrl);
    try {
      return await this.startSyncMutex;
    } finally {
      this.startSyncMutex = null;
    }
  }

  /** Internal body of startSync, extracted so the mutex wraps only the
   *  syncShapesToTables call, not the early-return guards. */
  private async startSyncInternal(syncUrl: string): Promise<void> {
    // Guard against re-entry via the old syncUnsubscribe path.
    if (this.syncUnsubscribe) {
      return;
    }

    // Set sync status now that we're past the mutex and actually starting.
    this.syncStatus = "syncing";
    this.syncError = null;

    try {
      // TypeScript: pglite-sync adds an `electric` namespace on the PGlite
      // instance when the electricSync() extension is registered.
      // The official API: https://pglite.dev/docs/sync#multitable-sync
      const clientWithElectric = this.client as PGlite & {
        electric?: {
          syncShapesToTables?: (opts: {
            shapes: Record<
              string,
              {
                shape: { url: string; params?: Record<string, string> };
                table: string;
                primaryKey: string[];
              }
            >;
            key: string;
            onInitialSync?: () => void;
            onError?: (err: Error) => void;
          }) => { isUpToDate: boolean; unsubscribe: () => void };
        };
      };

      if (!clientWithElectric.electric?.syncShapesToTables) {
        const msg =
          "electricSync extension registered but pg.electric.syncShapesToTables not available";
        logger.warn({ src: "plugin:sql", syncUrl }, msg);
        this.syncStatus = "error";
        this.syncError = msg;
        return;
      }

      // Per-agent WHERE filter: in a shared-Neon deployment the source
      // Postgres holds all agents' rows. The `agent_id` column scopes every
      // table, so each PGlite syncs only the rows that belong to its agent.
      // Refuse to sync without an agentId — syncing all rows would silently
      // leak every agent's data into the local PGlite.
      const agentId = this.agentId ?? process.env.AGENT_ID ?? null;
      if (!agentId) {
        const msg =
          "ELIZA_ELECTRIC_SYNC_URL is configured but agentId is unknown — refusing to sync without per-agent filtering";
        logger.error({ src: "plugin:sql", syncUrl }, msg);
        this.syncStatus = "error";
        this.syncError = msg;
        return;
      }

      // Electric Cloud does NOT support $1 positional placeholders — the
      // `where` clause must use literal SQL values. agentId is a UUID,
      // validated explicitly so direct interpolation is safe.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
        const msg = `agentId is not a valid UUID: ${agentId}`;
        logger.error({ src: "plugin:sql", syncUrl }, msg);
        this.syncStatus = "error";
        this.syncError = msg;
        return;
      }
      const where = `agent_id = '${agentId}'`;
      const agentWhere = `id = '${agentId}'`;

      // Derive the shape definitions from SYNCED_TABLE_NAMES so the read path
      // stays in sync with the write-back notification path. Per-table
      // override: agents filters by id (literal UUID, not $1 placeholder —
      // Electric Cloud requires literal values in WHERE clauses).
      const tables = SYNCED_TABLE_NAMES.map((name) => ({
        key: name,
        table: name,
        pk: ["id"] as string[],
        where: name === "agents" ? agentWhere : where,
        params: {} as Record<string, string>,
      }));

      // Initialize per-table state as "pending".
      this.syncTableStates = {};
      for (const { key } of tables) {
        this.syncTableStates[key] = { state: "pending" };
      }
      this.syncedTables = [];

      // Build the shapes record as expected by syncShapesToTables.
      // https://pglite.dev/docs/sync#syncshapestotables-api
      const shapes: Record<
        string,
        {
          shape: { url: string; params: Record<string, string> };
          table: string;
          primaryKey: string[];
        }
      > = {};
      for (const { key, table, pk, where: tableWhere, params: tableParams } of tables) {
        shapes[key] = {
          shape: {
            url: syncUrl,
            params: { table, where: tableWhere, ...tableParams },
          },
          table,
          primaryKey: pk,
        };
      }

      // Per-agent sync key so different agents' sync streams don't collide
      // and resume-from-last-offset works across container restarts.
      const syncKey = agentId;

      // Track which tables have completed initial sync. The onInitialSync
      // callback fires once when ALL shapes are synced.
      let initialSyncComplete = false;

      const sync = clientWithElectric.electric.syncShapesToTables({
        shapes,
        key: syncKey,
        onInitialSync: () => {
          // Guard: if the manager is shutting down, don't touch
          // PGlite or internal state — close() is running.
          if (this.shuttingDown) return;
          initialSyncComplete = true;
          // Mark all tables as synced.
          for (const { key } of tables) {
            this.syncTableStates[key] = { state: "synced" };
          }
          this.syncedTables = tables.map((t) => t.key);
          this.syncStatus = "synced";
          this.syncError = null;
          logger.info(
            { src: "plugin:sql", syncedTables: this.syncedTables },
            `Electric Sync initial sync complete for all ${tables.length} tables`
          );
        },
        onError: (err: Error) => {
          // Guard: if the manager is shutting down, the PGlite
          // instance may already be closed — don't touch state.
          if (this.shuttingDown) return;
          // Sync errors are warnings, not fatal — the agent runs on
          // local PGlite regardless. Track the error for diagnostics
          // but don't declare every table broken.
          this.syncError = err.message;
          if (!initialSyncComplete) {
            // Before initial sync: all pending tables that haven't
            // individually errored stay pending.
            this.syncStatus = "error";
          }
          // After initial sync: the existing synced data is fine;
          // just log the stream disruption.
          logger.error(
            { src: "plugin:sql", error: err.message },
            "Electric Sync stream error — agent continues on local PGlite"
          );
        },
      });

      this.syncUnsubscribe = () => sync.unsubscribe();

      // If isUpToDate is already true after syncShapesToTables returns,
      // the initial sync happened synchronously (e.g., all tables empty
      // or caught up instantly). Fire onInitialSync manually.
      if (sync.isUpToDate && !initialSyncComplete && !this.shuttingDown) {
        for (const { key } of tables) {
          this.syncTableStates[key] = { state: "synced" };
        }
        this.syncedTables = tables.map((t) => t.key);
        this.syncStatus = "synced";
      }

      logger.info(
        {
          src: "plugin:sql",
          syncUrl,
          agentId,
          syncKey,
          status: this.syncStatus,
          tables: tables.length,
          syncedTables: this.syncedTables,
        },
        "Electric Sync client started for all core tables"
      );
    } catch (err) {
      this.syncStatus = "error";
      this.syncError = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "plugin:sql", error: this.syncError },
        "Failed to start Electric Sync client — agent continues on local PGlite"
      );
    }
  }

  private async initializeInternal(): Promise<void> {
    try {
      await this.queryMigrationsSchema();
      // Sync is deferred to ensureSync() — called lazily from
      // withDatabase() after migrations have created the target tables.
      return;
    } catch (initialError) {
      const dataDir = this.getDataDir();
      if (!this.isFileBackedDataDir(dataDir)) {
        throw initialError;
      }

      const pidStatus = this.reconcilePglitePidFile(dataDir);
      if (
        pidStatus === "active" ||
        pidStatus === "active-unconfirmed" ||
        pidStatus === "check-failed"
      ) {
        throw this.createActiveLockError(dataDir, initialError);
      }

      if (pidStatus === "cleared-stale" || pidStatus === "cleared-malformed") {
        logger.warn(
          {
            src: "plugin:sql",
            dataDir,
            error: this.getErrorText(initialError),
          },
          "Retrying PGlite initialization after clearing postmaster.pid"
        );
        try {
          await this.client.close();
        } catch {}
        this.client = this.createClient(this.options);

        try {
          await this.queryMigrationsSchema();
          // Sync deferred — will be started by ensureSync() on first DB op.
          return;
        } catch (retryError) {
          logger.error(
            {
              src: "plugin:sql",
              dataDir,
              error: this.getErrorText(retryError),
            },
            "PGlite initialization still failed after clearing postmaster.pid"
          );
          throw this.createManualResetRequiredError(dataDir, retryError);
        }
      }

      logger.error(
        {
          src: "plugin:sql",
          dataDir,
          error: this.getErrorText(initialError),
        },
        "PGlite initialization failed; manual reset required"
      );
      throw this.createManualResetRequiredError(dataDir, initialError);
    }
  }
}
