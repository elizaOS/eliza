import { db } from "@feed/db";
import { logger } from "@feed/shared";

interface UploadTargetResult {
  success: boolean;
  repository: string;
  filesUploaded: number;
  records: number;
  url?: string;
  error?: string;
}

interface WeeklyUploadResult {
  success: boolean;
  duration: number;
  datasets: {
    benchmarks: UploadTargetResult;
    trajectories: UploadTargetResult;
  };
  models: {
    processed: number;
    benchmarked: number;
    uploaded: number;
  };
  errors: string[];
}

interface ReadinessResult {
  ready: boolean;
  issues: string[];
  warnings: string[];
}

interface UploadFilesModule {
  uploadFiles(options: {
    accessToken: string;
    repo: { type: "dataset"; name: string };
    files: Array<{ path: string; content: Blob }>;
    commitTitle: string;
  }): Promise<unknown>;
}

const DEFAULT_BENCHMARK_DATASET = "feedlabs/agent-benchmarks";
const DEFAULT_TRAJECTORY_DATASET = "feedlabs/agent-trajectories";

function getHuggingFaceToken(): string | undefined {
  return process.env.HUGGING_FACE_TOKEN || process.env.HF_TOKEN;
}

function getBenchmarkDatasetName(): string {
  return process.env.HF_DATASET_NAME || DEFAULT_BENCHMARK_DATASET;
}

function getTrajectoryDatasetName(): string {
  return process.env.HF_TRAJECTORY_DATASET_NAME || DEFAULT_TRAJECTORY_DATASET;
}

function toJsonBlob(value: unknown): Blob {
  return new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
}

function toJsonlBlob(rows: unknown[]): Blob {
  return new Blob([rows.map((row) => JSON.stringify(row)).join("\n")], {
    type: "application/x-ndjson",
  });
}

export class HuggingFaceIntegration {
  async validateSystemReadiness(): Promise<ReadinessResult> {
    const issues: string[] = [];
    const warnings: string[] = [];

    if (!getHuggingFaceToken()) {
      issues.push("HUGGING_FACE_TOKEN or HF_TOKEN is required for uploads");
    }

    const [benchmarkCount, trajectoryCount] = await Promise.all([
      db.benchmarkResult.count(),
      db.trajectory.count({ where: { isTrainingData: true } }),
    ]);

    if (benchmarkCount === 0) {
      warnings.push("No benchmark results are available to upload");
    }

    if (trajectoryCount === 0) {
      warnings.push("No training trajectories are available to upload");
    }

    return {
      ready: issues.length === 0 && (benchmarkCount > 0 || trajectoryCount > 0),
      issues,
      warnings,
    };
  }

  async getStatistics(): Promise<{
    benchmarks: { total: number };
    trajectories: { total: number; unused: number };
    models: { total: number; benchmarked: number; uploaded: number };
  }> {
    const [
      benchmarkTotal,
      trajectoryTotal,
      unusedTrajectories,
      modelTotal,
      benchmarkedModels,
      uploadedModels,
    ] = await Promise.all([
      db.benchmarkResult.count(),
      db.trajectory.count({ where: { isTrainingData: true } }),
      db.trajectory.count({
        where: { isTrainingData: true, usedInTraining: false },
      }),
      db.trainedModel.count(),
      db.trainedModel.count({ where: { lastBenchmarked: { not: null } } }),
      db.trainedModel.count({ where: { huggingFaceRepo: { not: null } } }),
    ]);

    return {
      benchmarks: { total: benchmarkTotal },
      trajectories: { total: trajectoryTotal, unused: unusedTrajectories },
      models: {
        total: modelTotal,
        benchmarked: benchmarkedModels,
        uploaded: uploadedModels,
      },
    };
  }

  async hasNewDataToUpload(): Promise<boolean> {
    const [unusedTrajectories, benchmarkCount] = await Promise.all([
      db.trajectory.count({
        where: { isTrainingData: true, usedInTraining: false },
      }),
      db.benchmarkResult.count(),
    ]);

    return unusedTrajectories > 0 || benchmarkCount > 0;
  }

  async executeWeeklyUpload(): Promise<WeeklyUploadResult> {
    const startedAt = Date.now();
    const errors: string[] = [];
    const validation = await this.validateSystemReadiness();
    const statistics = await this.getStatistics();

    if (!validation.ready) {
      errors.push(...validation.issues);
      return {
        success: false,
        duration: Date.now() - startedAt,
        datasets: {
          benchmarks: this.notUploadedResult(
            getBenchmarkDatasetName(),
            statistics.benchmarks.total,
            validation.issues[0] || "No benchmark data available",
          ),
          trajectories: this.notUploadedResult(
            getTrajectoryDatasetName(),
            statistics.trajectories.total,
            validation.issues[0] || "No trajectory data available",
          ),
        },
        models: {
          processed: statistics.models.total,
          benchmarked: statistics.models.benchmarked,
          uploaded: statistics.models.uploaded,
        },
        errors,
      };
    }

    const [benchmarks, trajectories] = await Promise.all([
      this.buildBenchmarkUpload(),
      this.buildTrajectoryUpload(),
    ]);

    const [benchmarkResult, trajectoryResult] = await Promise.all([
      this.uploadDataset(getBenchmarkDatasetName(), "benchmarks", benchmarks),
      this.uploadDataset(
        getTrajectoryDatasetName(),
        "trajectories",
        trajectories,
      ),
    ]);

    if (!benchmarkResult.success && benchmarkResult.error) {
      errors.push(benchmarkResult.error);
    }
    if (!trajectoryResult.success && trajectoryResult.error) {
      errors.push(trajectoryResult.error);
    }

    return {
      success: errors.length === 0,
      duration: Date.now() - startedAt,
      datasets: {
        benchmarks: benchmarkResult,
        trajectories: trajectoryResult,
      },
      models: {
        processed: statistics.models.total,
        benchmarked: statistics.models.benchmarked,
        uploaded: statistics.models.uploaded,
      },
      errors,
    };
  }

  private notUploadedResult(
    repository: string,
    records: number,
    error: string,
  ): UploadTargetResult {
    return {
      success: false,
      repository,
      filesUploaded: 0,
      records,
      error,
    };
  }

  private async buildBenchmarkUpload(): Promise<unknown[]> {
    return db.benchmarkResult.findMany({
      orderBy: { runAt: "desc" },
      take: 500,
    });
  }

  private async buildTrajectoryUpload(): Promise<unknown[]> {
    return db.trajectory.findMany({
      where: { isTrainingData: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
  }

  private async uploadDataset(
    repository: string,
    name: string,
    rows: unknown[],
  ): Promise<UploadTargetResult> {
    if (rows.length === 0) {
      return {
        success: true,
        repository,
        filesUploaded: 0,
        records: 0,
      };
    }

    const token = getHuggingFaceToken();
    if (!token) {
      return this.notUploadedResult(
        repository,
        rows.length,
        "Missing HF token",
      );
    }

    const importHub = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<UploadFilesModule>;

    try {
      const { uploadFiles } = await importHub("@huggingface/hub");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await uploadFiles({
        accessToken: token,
        repo: { type: "dataset", name: repository },
        files: [
          {
            path: `data/${name}-${timestamp}.jsonl`,
            content: toJsonlBlob(rows),
          },
          {
            path: `metadata/${name}-${timestamp}.json`,
            content: toJsonBlob({
              generatedAt: new Date().toISOString(),
              records: rows.length,
              source: "feed weekly dataset upload",
            }),
          },
        ],
        commitTitle: `Upload ${name} snapshot`,
      });

      return {
        success: true,
        repository,
        filesUploaded: 2,
        records: rows.length,
        url: `https://huggingface.co/datasets/${repository}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown HuggingFace error";
      logger.error(
        "HuggingFace dataset upload failed",
        { repository, name, error: message },
        "HuggingFaceIntegration",
      );
      return this.notUploadedResult(repository, rows.length, message);
    }
  }
}

export const huggingFaceIntegration = new HuggingFaceIntegration();
