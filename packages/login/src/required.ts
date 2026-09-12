/** Rejects missing required values before login operations can continue with incomplete state. */
import { ElizaError } from "@elizaos/core/errors";

export function requireLoginValue<T>(
  value: T | null | undefined,
  field: string,
): T {
  if (value === null || value === undefined) {
    throw new ElizaError(`Required login value is unavailable: ${field}`, {
      code: "LOGIN_REQUIRED_VALUE_UNAVAILABLE",
      context: { field },
    });
  }
  return value;
}
