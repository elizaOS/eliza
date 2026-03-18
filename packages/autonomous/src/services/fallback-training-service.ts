import crypto from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import type { TrainingServiceWithRuntime } from "../api/training-service-like";
import type { MiladyConfig } from "../config/config";

type DatasetRecord = {
  id: string;
  createdAt: string;
  limit?: number;
  minLlmCallsPerTrajectory?: number;
};

type TrainingJobRecord = {
  id: string;
  datasetId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
};

type TrainingModelRecord = {
  id: string;
  createdAt: string;
};

export class FallbackTrainingService implements TrainingServiceWithRuntime {
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly datasets: DatasetRecord[] = [];
  private readonly jobs: TrainingJobRecord[] = [];
  private readonly models: TrainingModelRecord[] = [];

  constructor(
    private readonly options: {
      getRuntime: () => AgentRuntime | null;
      getConfig: () => MiladyConfig;
      setConfig: (nextConfig: MiladyConfig) => void;
    },
  ) {}

  async initialize(): Promise<void> {
    // No-op fallback implementation.
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break service operations.
      }
    }
  }

  getStatus(): {
    runningJobs: number;
    datasetCount: number;
    modelCount: number;
  } {
    return {
      runningJobs: this.jobs.filter((job) => job.status === "running").length,
      datasetCount: this.datasets.length,
      modelCount: this.models.length,
    };
  }

  async listTrajectories(options: {
    limit?: number;
    offset?: number;
  }): Promise<{
    available: boolean;
    reason: string;
    trajectories: unknown[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    if (!this.options.getRuntime()) {
      return {
        available: false,
        reason: "runtime_not_started",
        trajectories: [],
        total: 0,
        limit,
        offset,
      };
    }
    return {
      available: false,
      reason: "trajectory_store_unavailable",
      trajectories: [],
      total: 0,
      limit,
      offset,
    };
  }

  async getTrajectoryById(_trajectoryId: string): Promise<null> {
    return null;
  }

  listDatasets(): DatasetRecord[] {
    return [...this.datasets];
  }

  async buildDataset(options: {
    limit?: number;
    minLlmCallsPerTrajectory?: number;
  }): Promise<DatasetRecord> {
    const dataset: DatasetRecord = {
      id: `dataset-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      limit: options.limit,
      minLlmCallsPerTrajectory: options.minLlmCallsPerTrajectory,
    };
    this.datasets.unshift(dataset);
    this.emit({ kind: "dataset_built", dataset });
    return dataset;
  }

  listJobs(): TrainingJobRecord[] {
    return [...this.jobs];
  }

  async startTrainingJob(options: {
    datasetId?: string;
  }): Promise<TrainingJobRecord> {
    if (!options.datasetId) {
      throw new Error("datasetId is required");
    }
    if (!this.datasets.some((dataset) => dataset.id === options.datasetId)) {
      throw new Error("Dataset not found");
    }

    const job: TrainingJobRecord = {
      id: `job-${crypto.randomUUID()}`,
      datasetId: options.datasetId,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.jobs.unshift(job);
    this.emit({ kind: "job_started", job });
    return job;
  }

  getJob(jobId: string): TrainingJobRecord | null {
    return this.jobs.find((job) => job.id === jobId) ?? null;
  }

  async cancelJob(jobId: string): Promise<TrainingJobRecord> {
    const job = this.getJob(jobId);
    if (!job) throw new Error("Training job not found");
    job.status = "cancelled";
    this.emit({ kind: "job_cancelled", job });
    return job;
  }

  listModels(): TrainingModelRecord[] {
    return [...this.models];
  }

  async importModelToOllama(
    modelId: string,
    _body: {
      modelName?: string;
      baseModel?: string;
      ollamaUrl?: string;
    },
  ): Promise<TrainingModelRecord> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return model;
  }

  async activateModel(
    modelId: string,
    _providerModel?: string,
  ): Promise<{ ok: boolean; activeModelId: string }> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return { ok: true, activeModelId: model.id };
  }

  async benchmarkModel(
    modelId: string,
  ): Promise<{ ok: boolean; modelId: string }> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return { ok: true, modelId: model.id };
  }
}
