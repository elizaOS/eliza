/**
 * Registers host retention work with the core task clock and drains it on unload.
 * Scheduled and direct sweeps share one in-flight operation; storage failures
 * propagate to the caller or TaskService's reporting and retry boundary.
 */
import {
  ElizaError,
  type IAgentRuntime,
  stringToUuid,
  type TaskWorker,
} from "@elizaos/core";

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
