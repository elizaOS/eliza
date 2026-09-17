/** Browser-safe error formatting with optional diagnostic stack context. */
import { formatDiagnosticError } from "./utils/safe-diagnostic-error.js";

export { formatError } from "@elizaos/common";
export function formatErrorWithStack(error: unknown): string {
  return formatDiagnosticError(error);
}
