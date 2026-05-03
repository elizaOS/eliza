import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
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

export class PGliteClientManager implements IDatabaseClientManager<PGlite> {
  private client: PGlite;
  private options: PGliteOptions;
  private shuttingDown = false;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;

  constructor(options: PGliteOptions) {
    this.options = options;
    this.client = this.createClient(options);
    this.setupShutdownHandlers();
  }

  public getConnection(): PGlite {
    return this.client;
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
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
    }
  }

  private setupShutdownHandlers() {}

  private createClient(options: PGliteOptions): PGlite {
    return new PGlite({
      ...options,
      extensions: {
        ...(options.extensions ?? {}),
        vector,
        fuzzystrmatch,
      },
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

  private getErrorText(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private reconcilePglitePidFile(dataDir: string): PglitePidFileStatus {
    const pidPath = `${dataDir}/postmaster.pid`;
    if (!existsSync(pidPath)) {
      return "missing";
    }

    try {
      const content = readFileSync(pidPath, "utf-8");
      const firstLine = content.split("\n")[0]?.trim();
      const pid = parseInt(firstLine, 10);

      if (Number.isNaN(pid) || pid <= 0) {
        unlinkSync(pidPath);
        logger.info(
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
      `PGlite data dir is already in use at ${dataDir}. Close the other Milady or Eliza process, or point PGLITE_DATA_DIR at a different directory before retrying.`,
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
      `PGlite initialization failed for ${dataDir}: ${errorText}. Stop Milady, then rename or delete only this directory before retrying: ${dataDir}`,
      { cause: corruptCause, dataDir }
    );
  }

  private async queryMigrationsSchema(): Promise<void> {
    await this.client.query("CREATE SCHEMA IF NOT EXISTS migrations");
    this.initialized = true;
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
        } catch {}
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
