/** Normalizes a user-supplied owner name: trims and caps at `OWNER_NAME_MAX_LENGTH`, coercing non-strings to empty. */
export const OWNER_NAME_MAX_LENGTH = 60;

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

export function normalizeOwnerName(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return truncateWellFormed(
    toWellFormedUnicode(value.trim()),
    OWNER_NAME_MAX_LENGTH,
  );
}
