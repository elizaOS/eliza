/**
 * Shared helpers for safely reading values from untyped config objects.
 */
import { asRecord } from "@elizaos/shared";

export { asRecord };
export declare function readString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null;
//# sourceMappingURL=config-readers.d.ts.map
