// Shared pure helpers for the Fine-Tuning view, used by both FineTuningView /
// FineTuningTuiView (in FineTuningView.tsx) and the `interact` capability handler
// (in FineTuningView.interact.ts). Kept out of the .tsx so that file exports only
// React components and stays Fast-Refresh-compatible in dev.
import { client } from "@elizaos/ui";
import type {
  TrainingDatasetRecord,
  TrainingJobRecord,
  TrainingModelRecord,
  TrainingStatus,
  TrainingTrajectoryList,
} from "@elizaos/ui/api";
import { parseElizaOneBenchmarkTiers } from "../core/eliza1-benchmark-recipe.js";

export function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function parseCollectionTierList(value: string): string[] {
  return parseElizaOneBenchmarkTiers(value, []);
}

export async function loadTrainingTuiState(): Promise<{
  status: TrainingStatus;
  trajectories: TrainingTrajectoryList;
  datasets: { datasets: TrainingDatasetRecord[] };
  jobs: { jobs: TrainingJobRecord[] };
  models: { models: TrainingModelRecord[] };
}> {
  const [status, trajectories, datasets, jobs, models] = await Promise.all([
    client.getTrainingStatus(),
    client.listTrainingTrajectories({ limit: 25, offset: 0 }),
    client.listTrainingDatasets(),
    client.listTrainingJobs(),
    client.listTrainingModels(),
  ]);
  return {
    status,
    trajectories,
    datasets: { datasets: asArray(datasets.datasets) },
    jobs: { jobs: asArray(jobs.jobs) },
    models: { models: asArray(models.models) },
  };
}
