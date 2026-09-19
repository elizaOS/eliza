/** Owns a local PGlite database, exclusive data-directory access and shutdown. */
import {
  chmodSync,
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
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { logger } from "@elizaos/core";
import type { IDatabaseClientManager } from "../types";
import { createPgliteInitError, PGLITE_ERROR_CODES } from "./errors";

type PglitePidFileStatus =
  | "missing"
  | "active"
  | "active-unconfirmed"
  | "cleared-stale"
  | "cleared-malformed"
  | "check-failed";

/**
 * Create the PGlite data directory (and parents) owner-only, then heal the
 * mode on directories left behind by older installs. The memory DB tree holds
 * full agent history and connector ciphertext, and PGlite creates its files
 * 0644 — a 0700 root keeps the whole tree unreachable for other local users.
 */
export function ensurePrivateDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dataDir, 0o700);
  } catch {
    // error-policy:J6 best-effort heal for directories created by older
    // installs; platforms without POSIX chmod semantics skip.
  }
}

interface PgliteDataDirLockInfo {
  pid: number | null;
  createdAt: number | null;
  bootId: string | null;
  processStartTicks: string | null;
}

export const PGLITE_DATA_DIR_EXPORT_BUSY_CODE = "PGLITE_DATA_DIR_EXPORT_BUSY";
export const PGLITE_DATA_DIR_EXPORT_UNBOUNDED_CODE = "PGLITE_DATA_DIR_EXPORT_UNBOUNDED";

export interface PgliteBoundedDataDirExport<T> {
  dump: File | Blob;
  preflight: T;
  /** Release only after every consumer has finished with the materialized Blob. */
  release: () => void;
}

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
  private lifecycleTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private activeDataDirExport:
    | {
        token: symbol;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;
  private lockFd: number | null = null;
  private lockPath: string | null = null;

  constructor(options: PGliteOptions) {
    this.options = options;
    this.acquireDataDirLockIfNeeded();
    try {
      this.client = this.createClient(options);
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
   * The legacy exporter cannot prove a physical-size/RSS bound before PGlite
   * materializes its archive, so it is intentionally fail-closed. Callers must
   * use dumpDataDirAfterPreflight() and retain its lease through Blob use.
   */
  public async dumpDataDir(compression: "gzip" = "gzip"): Promise<File | Blob> {
    void compression;
    if (this.shuttingDown) {
      throw new Error("PGlite is closing");
    }
    if (this.activeDataDirExport) {
      throw this.createDataDirExportError(
        PGLITE_DATA_DIR_EXPORT_BUSY_CODE,
        "A PGlite data-directory export is already active"
      );
    }
    throw this.createDataDirExportError(
      PGLITE_DATA_DIR_EXPORT_UNBOUNDED_CODE,
      "Unbounded PGlite data-directory export is disabled"
    );
  }

  /**
   * Run a bounded-export preflight and the materializing PGlite dump under one
   * query fence, while the outer lifecycle fence prevents concurrent close.
   */
  public async dumpDataDirAfterPreflight<T>(
    preflight: () => Promise<T>,
    compression: "gzip" = "gzip"
  ): Promise<PgliteBoundedDataDirExport<T>> {
    if (this.shuttingDown) {
      throw new Error("PGlite is closing");
    }
    const lease = this.acquireDataDirExportLease();
    try {
      const bounded = await this.withLifecycleLock(
        async () =>
          await this.client.runExclusive(async () => {
            const preflightResult = await preflight();
            const dump = await this.client.dumpDataDir(compression);
            return { dump, preflight: preflightResult };
          })
      );
      return { ...bounded, release: lease.release };
    } catch (error) {
      lease.release();
      throw error;
    }
  }

  private acquireDataDirExportLease(): { release: () => void } {
    if (this.activeDataDirExport) {
      throw this.createDataDirExportError(
        PGLITE_DATA_DIR_EXPORT_BUSY_CODE,
        "A PGlite data-directory export is already active"
      );
    }
    const token = Symbol("pglite-data-dir-export");
    let resolveReleased!: () => void;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    let releasedOnce = false;
    const release = () => {
      if (releasedOnce) return;
      releasedOnce = true;
      if (this.activeDataDirExport?.token === token) {
        this.activeDataDirExport = undefined;
      }
      resolveReleased();
    };
    this.activeDataDirExport = { token, released, release };
    return { release };
  }

  private createDataDirExportError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
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
    if (!this.closePromise) {
      this.shuttingDown = true;
      this.closePromise = this.withLifecycleLock(async () => {
        await this.closeInternal();
      });
    }
    await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    // Keep the process/data-dir ownership fence until the materialized archive
    // is no longer retained by its consumer. Releasing it earlier could let a
    // replacement manager overlap another full PGlite archive in memory.
    await this.activeDataDirExport?.released;
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        // error-policy:J6 best-effort teardown — a failed client close still
        // proceeds to release the data-dir lock so the writer slot is freed.
        logger.debug({ src: "plugin:sql", error: String(error) }, "close: client close failed");
      }
    }
    this.releaseDataDirLock();
  }

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
    const extensions = {
      ...(options.extensions ?? {}),
      vector,
      fuzzystrmatch,
      // Message-search partial-word / typo fallback (`similarity`, `gin_trgm_ops`).
      // Without this WASM contrib bundle, `CREATE EXTENSION pg_trgm` fails and
      // MessageSearch degrades to FTS-only (#13534).
      pg_trgm,
    } as PGliteOptions["extensions"];
    return new PGlite({
      ...options,
      extensions,
    });
  }

  /** Physical-storage configuration attested to bounded backup callers. */
  public getDataDir(): string | null {
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
      // error-policy:J3 untrusted-input parse — a missing/corrupt lock file
      // yields the typed all-null "unknown" struct; the liveness check treats
      // unknown conservatively (does not reclaim on guesswork).
      return { pid: null, createdAt: null, bootId: null, processStartTicks: null };
    }
  }

  private readLinuxBootId(): string | null {
    // error-policy:J3 optional-source probe — /proc is Linux-only and may be
    // unreadable; null is the designed "couldn't determine" signal.
    try {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
      return bootId.length > 0 ? bootId : null;
    } catch {
      return null;
    }
  }

  private readLinuxUptimeSeconds(): number | null {
    // error-policy:J3 optional-source probe — /proc/uptime is Linux-only; null
    // means "unavailable", not zero uptime.
    try {
      const raw = readFileSync("/proc/uptime", "utf-8").trim().split(/\s+/)[0];
      const uptimeSeconds = Number.parseFloat(raw ?? "");
      return Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? uptimeSeconds : null;
    } catch {
      return null;
    }
  }

  private readLinuxProcStartTicks(pid: number | "self"): string | null {
    // error-policy:J3 optional-source probe — /proc/<pid>/stat is Linux-only and
    // absent once the process exits; null is the designed "unknown" signal.
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

    ensurePrivateDir(dataDir);
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
      } catch (error) {
        // error-policy:J6 best-effort teardown — a stale fd or double-close is
        // harmless during lock release; drop the handle regardless.
        logger.debug({ src: "plugin:sql", error: String(error) }, "lock: closeSync failed");
      }
      this.lockFd = null;
    }

    if (this.lockPath) {
      try {
        unlinkSync(this.lockPath);
      } catch (error) {
        // error-policy:J6 best-effort teardown — an already-removed lock file is
        // fine; clear the path regardless.
        logger.debug({ src: "plugin:sql", error: String(error) }, "lock: unlinkSync failed");
      }
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
      } catch {
        // error-policy:J3 untrusted-input sanitizing — a non-serializable value
        // (circular ref, throwing getter) just means JSON isn't a usable
        // representation; fall through to the toString/String strategies below.
      }
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

    // Mobile embedded modes (iOS and Android) are single-tenant: each app
    // launch spawns a fresh Bun process, so any leftover postmaster.pid is
    // always stale. The process.kill(pid, 0) heuristic below can produce
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

  private async initializeInternal(): Promise<void> {
    try {
      await this.queryMigrationsSchema();
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
        } catch (error) {
          // error-policy:J6 best-effort teardown — closing the failed client
          // before recreating it is best-effort; a close error must not block
          // the retry that follows.
          logger.debug(
            { src: "plugin:sql", error: String(error) },
            "retry: stale client close failed"
          );
        }
        this.client = this.createClient(this.options);

        try {
          await this.queryMigrationsSchema();
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
