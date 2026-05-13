import type { BenchmarkResults, HandlerResult } from "./types.js";

export function determineExitCode(
  results: BenchmarkResults,
  _elizaResult?: HandlerResult,
): number {
  if (!results.validationPassed) {
    return 2;
  }

  return 0;
}
