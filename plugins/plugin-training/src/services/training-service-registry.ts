/** Process-global holder for the active TrainingService, so route handlers can reach the service the host builds at startup without threading it through every call. */
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
