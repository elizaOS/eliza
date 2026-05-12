import type { Trajectory, TrajectoryListResult } from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";
import { createHashAnonymizer } from "../core/privacy-filter.js";
import { buildTrajectoryExportBundle } from "../core/trajectory-export-bundle.js";
import type { TrainingServiceWithRuntime } from "./training-service-like.js";

/**
 * Thrown for endpoints whose real implementation lives on another surface
 * (GPU fine-tunes on `/api/training/vast/jobs`, prompt optimization on
 * `/api/training/auto/trigger`). The route layer maps this to a 501 with the
 * message verbatim — we do not fabricate success responses for unwired flows.
 */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotImplementedError";
  }
}

export function isNotImplementedError(
  err: unknown,
): err is NotImplementedError {
  return err instanceof NotImplementedError;
}

interface TrainingServiceOptions {
  getRuntime: () => AgentRuntime | null;
  getConfig: () => unknown;
  setConfig: (nextConfig: unknown) => void;
}

interface TrajectoryServiceLike {
  listTrajectories: (options: {
    limit?: number;
    offset?: number;
    runId?: string;
  }) => Promise<TrajectoryListResult>;
  getTrajectoryDetail: (id: string) => Promise<Trajectory | null>;
}

/**
 * Public training API service. Reads trajectories from the runtime
 * `trajectories` DB service and builds privacy-filtered export bundles via
 * `buildTrajectoryExportBundle`. GPU fine-tunes, Ollama import, model
 * activation, and benchmarking are handled by other surfaces — this service
 * does not stub them.
 */
export class TrainingService implements TrainingServiceWithRuntime {
  private readonly listeners = new Set<(event: unknown) => void>();

  constructor(private readonly options: TrainingServiceOptions) {}

  async initialize(): Promise<void> {}

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private trajectoryService(): TrajectoryServiceLike {
    const runtime = this.options.getRuntime();
    const service = runtime?.getService("trajectories") as unknown as
      | TrajectoryServiceLike
      | null
      | undefined;
    if (
      !service ||
      typeof service.listTrajectories !== "function" ||
      typeof service.getTrajectoryDetail !== "function"
    ) {
      throw new NotImplementedError(
        "The trajectories service is not available on the current runtime.",
      );
    }
    return service;
  }

  getStatus(): Record<string, unknown> {
    return {
      runtimeAvailable: this.options.getRuntime() !== null,
    };
  }

  async listTrajectories(options: {
    limit?: number;
    offset?: number;
    runId?: string;
  }): Promise<TrajectoryListResult> {
    return await this.trajectoryService().listTrajectories(options);
  }

  async getTrajectoryById(trajectoryId: string): Promise<Trajectory | null> {
    return await this.trajectoryService().getTrajectoryDetail(trajectoryId);
  }

  /** Datasets are produced as export bundles on disk; there is no persisted list. */
  listDatasets(): Record<string, unknown>[] {
    return [];
  }

  async buildDataset(options: {
    limit?: number;
    minLlmCallsPerTrajectory?: number;
  }): Promise<Record<string, unknown>> {
    const service = this.trajectoryService();
    const listed = await service.listTrajectories({
      limit: options.limit ?? 500,
    });
    const trajectories = (
      await Promise.all(
        listed.trajectories.map((item) => service.getTrajectoryDetail(item.id)),
      )
    ).filter((t): t is Trajectory => t !== null);
    const minCalls = options.minLlmCallsPerTrajectory ?? 0;
    const eligible =
      minCalls > 0
        ? trajectories.filter(
            (t) =>
              (t.steps ?? []).reduce(
                (sum, step) => sum + (step.llmCalls?.length ?? 0),
                0,
              ) >= minCalls,
          )
        : trajectories;
    const bundle = await buildTrajectoryExportBundle({
      trajectories: eligible,
      outputDir: `.tmp/training-dataset-${Date.now()}`,
      privacy: {
        apply: true,
        options: { anonymizer: createHashAnonymizer() },
      },
      source: {
        kind: "training-build-dataset",
        metadata: {
          requestedLimit: options.limit ?? 500,
          minLlmCallsPerTrajectory: minCalls,
          consideredTrajectories: trajectories.length,
          eligibleTrajectories: eligible.length,
        },
      },
    });
    this.emit({ kind: "dataset_built", manifestPath: bundle.manifestPath });
    return {
      outputDir: bundle.outputDir,
      manifestPath: bundle.manifestPath,
      manifest: bundle.manifest,
    };
  }

  /** GPU fine-tune jobs live under `/api/training/vast/jobs`. */
  listJobs(): Record<string, unknown>[] {
    return [];
  }

  async startTrainingJob(): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      "GPU fine-tune jobs are managed via /api/training/vast/jobs; prompt optimization runs via /api/training/auto/trigger.",
    );
  }

  getJob(): Record<string, unknown> | null {
    return null;
  }

  async cancelJob(): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      "GPU fine-tune jobs are managed via /api/training/vast/jobs.",
    );
  }

  /** Trained models are tracked by the Vast registry under `/api/training/vast/models`. */
  listModels(): Record<string, unknown>[] {
    return [];
  }

  async importModelToOllama(): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      "Importing trained checkpoints into Ollama is not wired through this API. Use the GGUF → catalog flow.",
    );
  }

  async activateModel(): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      "Activating a trained model is not wired through this API. Configure the model provider directly.",
    );
  }

  async benchmarkModel(): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      "Model benchmarking runs via /api/training/vast/jobs/:id/eval.",
    );
  }
}
