/**
 * Shared helpers for safely reading values from untyped config objects.
 */

import { asNonEmptyString, asRecord } from "@elizaos/shared";

export { asRecord };

export function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  return asNonEmptyString(source?.[key]) ?? null;
}
