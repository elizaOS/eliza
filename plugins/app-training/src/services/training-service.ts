import crypto from "node:crypto";
import type {
  Trajectory,
  TrajectoryListResult,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import type { TrainingServiceWithRuntime } from "./training-service-like.js";

interface DatasetRecord {
  id: string;
  createdAt: string;
  limit?: number;
  minLlmCallsPerTrajectory?: number;
}

interface TrainingJobRecord {
  id: string;
  datasetId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
}

interface TrainingModelRecord {
  id: string;
  createdAt: string;
}

interface TrainingServiceOptions {
  getRuntime: () => AgentRuntime | null;
  getConfig: () => unknown;
  setConfig: (nextConfig: unknown) => void;
}

export class TrainingService implements TrainingServiceWithRuntime {
  private readonly listeners = new Set<(event: unknown) => void>();
  private readonly datasets: DatasetRecord[] = [];
  private readonly jobs: TrainingJobRecord[] = [];
  private readonly models: TrainingModelRecord[] = [];

  constructor(private readonly options: TrainingServiceOptions) {}

  async initialize(): Promise<void> {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      runningJobs: this.jobs.filter((job) => job.status === "running").length,
      datasetCount: this.datasets.length,
      modelCount: this.models.length,
    };
  }

  async listTrajectories(options: {
    limit?: number;
    offset?: number;
  }): Promise<TrajectoryListResult> {
    return {
      trajectories: [],
      total: 0,
      offset: options.offset ?? 0,
      limit: options.limit ?? 100,
    };
  }

  async getTrajectoryById(_trajectoryId: string): Promise<Trajectory | null> {
    return null;
  }

  listDatasets(): Record<string, unknown>[] {
    return this.datasets.map((dataset) => ({ ...dataset }));
  }

  async buildDataset(options: {
    limit?: number;
    minLlmCallsPerTrajectory?: number;
  }): Promise<Record<string, unknown>> {
    const dataset: DatasetRecord = {
      id: `dataset-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      limit: options.limit,
      minLlmCallsPerTrajectory: options.minLlmCallsPerTrajectory,
    };
    this.datasets.unshift(dataset);
    this.emit({ kind: "dataset_built", dataset });
    return { ...dataset };
  }

  listJobs(): Record<string, unknown>[] {
    return this.jobs.map((job) => ({ ...job }));
  }

  async startTrainingJob(options: {
    datasetId?: string;
  }): Promise<Record<string, unknown>> {
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
    return { ...job };
  }

  getJob(jobId: string): Record<string, unknown> | null {
    const job = this.jobs.find((entry) => entry.id === jobId);
    return job ? { ...job } : null;
  }

  async cancelJob(jobId: string): Promise<Record<string, unknown>> {
    const job = this.jobs.find((entry) => entry.id === jobId);
    if (!job) throw new Error("Training job not found");
    job.status = "cancelled";
    this.emit({ kind: "job_cancelled", job });
    return { ...job };
  }

  listModels(): Record<string, unknown>[] {
    return this.models.map((model) => ({ ...model }));
  }

  async importModelToOllama(
    modelId: string,
    _body: { modelName?: string; baseModel?: string; ollamaUrl?: string },
  ): Promise<Record<string, unknown>> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return { ...model };
  }

  async activateModel(
    modelId: string,
    _providerModel?: string,
  ): Promise<Record<string, unknown>> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return { ok: true, activeModelId: model.id };
  }

  async benchmarkModel(modelId: string): Promise<Record<string, unknown>> {
    const model = this.models.find((entry) => entry.id === modelId);
    if (!model) throw new Error("Model not found");
    return { ok: true, modelId: model.id };
  }
}
