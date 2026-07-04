// Implements the public training service for trajectory export and dataset builds.
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

function isTrajectoryService(
  service: unknown,
): service is TrajectoryServiceLike {
  if (!service || typeof service !== "object") return false;
  const candidate = service as Partial<TrajectoryServiceLike>;
  return (
    typeof candidate.listTrajectories === "function" &&
    typeof candidate.getTrajectoryDetail === "function"
  );
}

/**
 * Public training API service. Reads trajectories from the runtime
 * `trajectories` DB service and builds privacy-filtered export bundles via
 * `buildTrajectoryExportBundle`. GPU fine-tunes, Ollama import, model
 * activation, and benchmarking are handled by other surfaces — this service
 * does not emulate them.
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
    const service = runtime?.getService("trajectories");
    if (!isTrajectoryService(service)) {
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

    // When no explicit limit is given, the dataset covers the FULL set: the
    // reader caps each page at 500, so a single call silently dropped every
    // trajectory beyond the most-recent 500. Page through with an offset loop
    // until the set is drained. An explicit `options.limit` is honored as a
    // hard cap (the prior behavior).
    const PAGE_SIZE = 500;
    const items: TrajectoryListResult["trajectories"] = [];
    let offset = 0;
    while (true) {
      const remaining =
        options.limit !== undefined ? options.limit - items.length : PAGE_SIZE;
      if (options.limit !== undefined && remaining <= 0) break;
      const pageLimit = Math.min(PAGE_SIZE, Math.max(1, remaining));
      const page = await service.listTrajectories({ limit: pageLimit, offset });
      items.push(...page.trajectories);
      offset += page.trajectories.length;
      if (
        page.trajectories.length < pageLimit ||
        page.trajectories.length === 0
      )
        break;
    }

    // Bound the detail fan-out: hydrate in chunks instead of one unbounded
    // Promise.all over a potentially very large set.
    const DETAIL_CHUNK = 100;
    const hydrated: (Trajectory | null)[] = [];
    for (let i = 0; i < items.length; i += DETAIL_CHUNK) {
      const chunk = items.slice(i, i + DETAIL_CHUNK);
      hydrated.push(
        ...(await Promise.all(
          chunk.map((item) => service.getTrajectoryDetail(item.id)),
        )),
      );
    }
    const trajectories = hydrated.filter((t): t is Trajectory => t !== null);
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
          // null = no cap (full dataset); a number is the explicit hard cap.
          requestedLimit: options.limit ?? null,
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
