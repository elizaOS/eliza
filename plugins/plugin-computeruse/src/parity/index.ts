/**
 * trycua/cua parity tooling (#9170 M14) — public surface.
 *
 * The machine-checkable capability matrix + its validator, and the ScreenSpot
 * grounding harness. The OSWorld benchmark adapter lives under `src/osworld/`.
 */

export {
  type OsCoverage,
  type OsName,
  PARITY_MATRIX,
  type ParityCapability,
  type ParityCoverageByOs,
  type ParityStatus,
  type ParityValidationProblem,
  type ParityValidationResult,
  parityCoverageByOs,
  parityMatrixSummary,
  validateParityCoverage,
  validateParityMatrix,
} from "./parity-matrix.js";
export {
  pointInBbox,
  type ScreenSpotPrediction,
  type ScreenSpotSample,
  type ScreenSpotSampleResult,
  type ScreenSpotScore,
  scoreScreenSpot,
} from "./screenspot.js";
