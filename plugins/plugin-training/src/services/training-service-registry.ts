import type { TrainingServiceWithRuntime } from "./training-service-like.js";

let activeTrainingService: TrainingServiceWithRuntime | null = null;

export function setActiveTrainingService(
  service: TrainingServiceWithRuntime | null,
): void {
  activeTrainingService = service;
}

export function getActiveTrainingService(): TrainingServiceWithRuntime | null {
  return activeTrainingService;
}
