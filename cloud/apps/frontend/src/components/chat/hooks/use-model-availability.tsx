/**
 * Hook to check model availability status from the gateway.
 * Used to show unavailable models in the selector UI.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

export interface ModelAvailability {
  modelId: string;
  available: boolean;
  reason?: string;
}

interface UseModelAvailabilityResult {
  availability: Map<string, boolean>;
  reasons: Map<string, string>;
  isLoading: boolean;
  error: string | null;
  checkModels: (modelIds: string[]) => Promise<void>;
}

/**
 * Hook to check and track model availability
 * @param initialModelIds - Optional array of model IDs to check on mount
 */
export function useModelAvailability(initialModelIds?: string[]): UseModelAvailabilityResult {
  const [availability, setAvailability] = useState<Map<string, boolean>>(new Map());
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkModels = useCallback(async (modelIds: string[]) => {
    if (modelIds.length === 0) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/v1/models/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ modelIds }),
      });

      if (!response.ok) {
        throw new Error("Failed to check model availability");
      }

      const data = (await response.json()) as {
        models: ModelAvailability[];
        timestamp: number;
      };

      setAvailability((prev) => {
        const next = new Map(prev);
        for (const model of data.models) {
          next.set(model.modelId, model.available);
        }
        return next;
      });

      setReasons((prev) => {
        const next = new Map(prev);
        for (const model of data.models) {
          if (model.reason) {
            next.set(model.modelId, model.reason);
          }
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check availability");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Check initial models on mount
  useEffect(() => {
    if (initialModelIds && initialModelIds.length > 0) {
      void checkModels(initialModelIds);
    }
  }, [checkModels, initialModelIds]);

  return { availability, reasons, isLoading, error, checkModels };
}
