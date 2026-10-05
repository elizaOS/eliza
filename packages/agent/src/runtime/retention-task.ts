/**
 * Registers host retention work with the core task clock and drains it on unload.
 * Scheduled and direct sweeps share one in-flight operation; storage failures
 * propagate to the caller or TaskService's reporting and retry boundary.
 */
import {
  ElizaError,
  type IAgentRuntime,
  logger,
  stringToUuid,
  type TaskWorker,
} from "@elizaos/core";
import { isProtectedProfileSelected } from "../security/protected-profile-state.ts";
import {
  policyIsActive,
  type ResolvedRetentionConfig,
  resolveRetentionConfigWithPrefix,
} from "./memory-retention.ts";

const DEFAULT_RETENTION_INTERVAL_MINUTES = 360; // 6h

/**
 * Runtime setting that makes explicit retention bounds mandatory. It can only
 * tighten policy: the protected profile requires bounds regardless of it.
 */
export const RETENTION_BOUNDS_REQUIRED_SETTING =
  "ELIZA_PROTECTED_RETENTION_REQUIRED";

/** True when this host must refuse to run without an explicit retention bound. */
export function retentionBoundsRequired(runtime: IAgentRuntime): boolean {
  if (isProtectedProfileSelected()) return true;
  const value = runtime.getSetting(RETENTION_BOUNDS_REQUIRED_SETTING);
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

export class RetentionTask<T> {
  private active: Promise<T> | undefined;
  private stopping = false;
  private installed = false;
  private stopOperation: Promise<void> | undefined;
  private readonly id;
  private readonly worker: TaskWorker;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly name: string,
    work: () => Promise<T>,
  ) {
    this.id = stringToUuid(`host-retention:${runtime.agentId}:${name}`);
    this.worker = {
      name,
      shouldRun: async () => this.installed && !this.stopping,
      execute: async () => {
        if (!this.installed || this.stopping) return { preserveTask: true };
        await this.run(work);
        if (this.stopping) return { preserveTask: true };
      },
    };
  }

  /**
   * Resolve `${prefix}_*` bounds from runtime settings, then the process
   * environment, and install the schedule. Without an active bound retention
   * stays off, unless bounds are required, which rejects with
   * `RETENTION_BOUNDS_REQUIRED`.
   */
  async startConfigured(
    prefix: string,
    label: string,
  ): Promise<ResolvedRetentionConfig> {
    const config = resolveRetentionConfigWithPrefix((key) => {
      const fromSettings = this.runtime.getSetting(key);
      if (fromSettings !== undefined && fromSettings !== null) {
        return String(fromSettings);
      }
      return process.env[key];
    }, prefix);
    if (!policyIsActive(config)) {
      if (retentionBoundsRequired(this.runtime)) {
        throw new ElizaError(
          "Set an explicit retention bound for this protected host",
          {
            code: "RETENTION_BOUNDS_REQUIRED",
            context: {
              worker: this.name,
              keys: [`${prefix}_DAYS`, `${prefix}_MAX_ROWS_PER_ROOM`],
            },
          },
        );
      }
      await this.start(undefined);
      logger.info(
        `[${label}] no active bound (${prefix}_DAYS/${prefix}_MAX_ROWS_PER_ROOM unset) — retention DISABLED`,
      );
      return config;
    }
    const intervalMinutes =
      config.intervalMinutes ?? DEFAULT_RETENTION_INTERVAL_MINUTES;
    logger.info(
      `[${label}] enabled: retentionDays=${config.retentionDays ?? "off"} maxRowsPerRoom=${config.maxRowsPerRoom ?? "off"} maxDeletePerSweep=${config.maxDeletePerSweep ?? "none"} intervalMinutes=${intervalMinutes}`,
    );
    await this.start(intervalMinutes * 60 * 1000);
    return config;
  }

  async start(intervalMs: number | undefined): Promise<void> {
    if (this.runtime.getTaskWorker(this.name)) {
      throw new ElizaError("Host retention worker is already registered", {
        code: "RETENTION_WORKER_ALREADY_REGISTERED",
        context: { worker: this.name },
      });
    }
    if (
      intervalMs !== undefined &&
      (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    ) {
      throw new ElizaError(
        "Set a positive, safe retention interval in minutes",
        {
          code: "RETENTION_INTERVAL_INVALID",
          context: { worker: this.name, intervalMs },
        },
      );
    }
    // Claim synchronously so concurrent starts cannot publish two owners.
    this.runtime.registerTaskWorker(this.worker);
    try {
      const existing = await this.runtime.getTask(this.id);
      if (
        existing &&
        (existing.name !== this.name ||
          existing.agentId !== this.runtime.agentId)
      ) {
        throw new ElizaError(
          "Retention task identity belongs to another worker or agent",
          {
            code: "RETENTION_TASK_IDENTITY_CONFLICT",
            context: { taskId: this.id, worker: this.name },
          },
        );
      }
      if (intervalMs === undefined) {
        if (existing) await this.runtime.deleteTask(this.id);
        return;
      }
      const task = {
        id: this.id,
        name: this.name,
        agentId: this.runtime.agentId,
        description: "Run the configured host retention policy",
        tags: ["queue", "repeat"],
        metadata: {
          ...existing?.metadata,
          updateInterval: intervalMs,
          baseInterval: intervalMs,
          // Preserve the existing boot-settle delay without another timer.
          updatedAt: Date.now() + 30_000 - intervalMs,
        },
      };
      if (existing) await this.runtime.updateTask(this.id, task);
      else await this.runtime.createTask(task);
      this.installed = true;
    } finally {
      if (
        !this.installed &&
        this.runtime.getTaskWorker(this.name) === this.worker
      ) {
        this.runtime.unregisterTaskWorker(this.name);
      }
    }
  }

  run(work: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      return Promise.reject(
        new ElizaError("Retention service is stopped", {
          code: "RETENTION_SERVICE_STOPPED",
          context: { worker: this.name },
        }),
      );
    }
    if (this.active) return this.active;
    const operation = Promise.resolve()
      .then(work)
      .finally(() => {
        if (this.active === operation) this.active = undefined;
      });
    this.active = operation;
    return operation;
  }

  stop(): Promise<void> {
    this.stopOperation ??= this.finishStop();
    return this.stopOperation;
  }

  private async finishStop(): Promise<void> {
    this.stopping = true;
    try {
      if (this.installed) await this.runtime.deleteTask(this.id);
    } finally {
      try {
        await this.active;
      } finally {
        if (this.runtime.getTaskWorker(this.name) === this.worker) {
          this.runtime.unregisterTaskWorker(this.name);
        }
      }
    }
  }
}
