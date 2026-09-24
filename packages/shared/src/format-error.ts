/** Runtime error formatting with optional diagnostic stack context. */
import { formatDiagnosticError } from "./utils/safe-diagnostic-error.js";

export { formatError } from "@elizaos/shared/browser-contracts";
export function formatErrorWithStack(error: unknown): string {
  return formatDiagnosticError(error);
}
