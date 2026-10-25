/**
 * Exposes the machine-checkable computer-use capability matrix and validator.
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
