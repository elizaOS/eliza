import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";

export const OWNER_NAME_MAX_LENGTH = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOwnerName(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, OWNER_NAME_MAX_LENGTH);
}

export async function fetchConfiguredOwnerName(): Promise<string | null> {
  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeOwnerName(ui?.ownerName);
  } catch {
    return null;
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
  } catch {
    return false;
  }
}
