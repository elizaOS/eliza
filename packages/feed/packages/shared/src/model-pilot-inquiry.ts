/**
 * Allowed values and estimate helper for the model pilot inquiry form (client-safe).
 */

export const MODEL_PILOT_DELIVERABLES = [
  "Behavioral data",
  "Evaluation report",
  "Labeled dataset",
  "Fine-tuned model",
  "Dataset + fine-tuned model",
  "Ongoing retraining",
] as const;

export const MODEL_PILOT_SCENARIOS = [
  "Market manipulation",
  "Scam detection",
  "Multi-agent coordination",
  "Social engineering resistance",
  "Narrative volatility",
  "Custom scenarios",
] as const;

export const MODEL_PILOT_OUTPUTS = [
  "Raw logs",
  "Structured data",
  "Labeled data",
  "Evaluation report",
  "Fine-tuned model",
  "Hosted endpoint",
] as const;

export const MODEL_PILOT_REVIEW_LEVELS = [
  "Off",
  "Light review",
  "Full labeling support",
] as const;

export type ModelPilotDeliverable = (typeof MODEL_PILOT_DELIVERABLES)[number];
export type ModelPilotScenario = (typeof MODEL_PILOT_SCENARIOS)[number];
export type ModelPilotOutput = (typeof MODEL_PILOT_OUTPUTS)[number];
export type ModelPilotReviewLevel = (typeof MODEL_PILOT_REVIEW_LEVELS)[number];

export interface ModelPilotEstimateInput {
  deliverables: readonly ModelPilotDeliverable[];
  review: ModelPilotReviewLevel;
  privateDeployment: boolean;
  dataExclusivity: boolean;
  concurrentAgents: number;
  scenarioRuns: number;
}

export function modelPilotDeliverableAffectsEstimate(
  deliverable: ModelPilotDeliverable,
): boolean {
  return deliverable.toLowerCase().includes("fine-tuned");
}

/**
 * Rough pilot cost range from selections (same logic as the standalone mock UI).
 */
export function calculateModelPilotEstimateRange(
  input: ModelPilotEstimateInput,
): string {
  let min = 5000;
  let max = 8000;

  if (input.deliverables.some(modelPilotDeliverableAffectsEstimate)) {
    min += 8000;
    max += 12000;
  }
  if (input.review === "Full labeling support") {
    min += 4000;
    max += 6000;
  }
  if (input.privateDeployment || input.dataExclusivity) {
    min += 5000;
    max += 10000;
  }

  const scale = 1 + input.concurrentAgents / 2000 + input.scenarioRuns / 50000;

  const finalMin = Math.round((min * scale) / 1000) * 1000;
  const finalMax = Math.round((max * scale) / 1000) * 1000;

  return `$${finalMin.toLocaleString("en-US")} – $${finalMax.toLocaleString("en-US")}`;
}
