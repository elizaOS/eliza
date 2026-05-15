export const MODEL_PREFERENCE_KEYS = [
  "nanoModel",
  "smallModel",
  "mediumModel",
  "largeModel",
  "megaModel",
  "responseHandlerModel",
  "shouldRespondModel",
  "actionPlannerModel",
  "plannerModel",
  "responseModel",
  "mediaDescriptionModel",
] as const;

export type ModelPreferenceKey = (typeof MODEL_PREFERENCE_KEYS)[number];

export interface ModelPreferences {
  nanoModel?: string;
  smallModel?: string;
  mediumModel?: string;
  largeModel?: string;
  megaModel?: string;
  responseHandlerModel?: string;
  shouldRespondModel?: string;
  actionPlannerModel?: string;
  plannerModel?: string;
  responseModel?: string;
  mediaDescriptionModel?: string;
}

export function sanitizeModelPreferences(value: unknown): ModelPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const next: ModelPreferences = {};

  for (const key of MODEL_PREFERENCE_KEYS) {
    const raw = source[key];
    if (typeof raw === "string" && raw.trim()) {
      next[key] = raw.trim();
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export function mergeModelPreferences(
  ...preferences: Array<ModelPreferences | undefined>
): ModelPreferences | undefined {
  const merged: ModelPreferences = {};

  for (const preferenceSet of preferences) {
    if (!preferenceSet) {
      continue;
    }

    for (const key of MODEL_PREFERENCE_KEYS) {
      const value = preferenceSet[key];
      if (typeof value === "string" && value.trim()) {
        merged[key] = value.trim();
      }
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function normalizeModelPreferences(
  preferences: ModelPreferences | undefined,
): ModelPreferences | undefined {
  return sanitizeModelPreferences(preferences);
}
