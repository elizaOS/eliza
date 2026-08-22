/** Normalizes a user-supplied owner name without shortening its content. */
import { toWellFormedUnicode } from "@elizaos/core";

export function normalizeOwnerName(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return toWellFormedUnicode(value.trim());
}
