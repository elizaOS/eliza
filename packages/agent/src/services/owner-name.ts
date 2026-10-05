/**
 * Reads and writes the configured owner display name, persisted at `ui.ownerName`
 * in the Eliza config. Both accessors normalize the value (coerce to trimmed
 * string, drop empties, and repair invalid Unicode). Config failures remain
 * distinguishable from an unset name or invalid input. Display names are
 * preserved in full because they later become model-visible identity context.
 */

import { ElizaError, toWellFormedUnicode } from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeOwnerName(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return toWellFormedUnicode(trimmed);
}

export async function fetchConfiguredOwnerName(): Promise<string | null> {
  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeOwnerName(ui?.ownerName);
  } catch (cause) {
    // error-policy:J2 Corrupt configuration is not an unset owner identity.
    throw new ElizaError("Failed to read configured owner name", {
      code: "OWNER_NAME_READ_FAILED",
      cause,
    });
  }
}

export async function persistConfiguredOwnerName(
  name: string,
): Promise<boolean> {
  const normalized = normalizeOwnerName(name);
  if (!normalized) {
    return false;
  }

  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : {};
    saveElizaConfig({
      ...config,
      ui: {
        ...ui,
        ownerName: normalized,
      },
    });
    return true;
  } catch (cause) {
    // error-policy:J2 Preserve a failed commit for the calling action boundary.
    throw new ElizaError("Failed to persist configured owner name", {
      code: "OWNER_NAME_WRITE_FAILED",
      cause,
    });
  }
}
