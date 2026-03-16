export interface TrainingServiceLike {
  getStatus(): Record<string, unknown>;
  listTrajectories(options: {
    limit?: number;
    offset?: number;
  }): Promise<Record<string, unknown>>;
  getTrajectoryById(
    trajectoryId: string,
  ): Promise<Record<string, unknown> | null>;
  listDatasets(): Record<string, unknown>[];
  buildDataset(options: {
    limit?: number;
    minLlmCallsPerTrajectory?: number;
  }): Promise<Record<string, unknown>>;
  listJobs(): Record<string, unknown>[];
  startTrainingJob(options: {
    datasetId?: string;
    maxTrajectories?: number;
    backend?: "mlx" | "cuda" | "cpu";
    model?: string;
    iterations?: number;
    batchSize?: number;
    learningRate?: number;
  }): Promise<Record<string, unknown>>;
  getJob(jobId: string): Record<string, unknown> | null;
  cancelJob(jobId: string): Promise<Record<string, unknown>>;
  listModels(): Record<string, unknown>[];
  importModelToOllama(
    modelId: string,
    body: {
      modelName?: string;
      baseModel?: string;
      ollamaUrl?: string;
    },
  ): Promise<Record<string, unknown>>;
  activateModel(
    modelId: string,
    providerModel?: string,
  ): Promise<Record<string, unknown>>;
  benchmarkModel(modelId: string): Promise<Record<string, unknown>>;
}

export interface TrainingServiceWithRuntime extends TrainingServiceLike {
  initialize(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
}
