/**
 * Hook to fetch available models from the gateway API.
 * Filters to only show curated models from ALLOWED_CHAT_MODELS configuration.
 *
 * @returns {object} Models array, loading state, and error state
 */
"use client";

import { useState, useEffect } from "react";
import { ALLOWED_CHAT_MODELS } from "@/lib/eliza/config";

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: string;
  data: Model[];
}

/**
 * Hook to fetch available models from the gateway
 * Filters to only show curated models from ALLOWED_CHAT_MODELS
 */
export function useAvailableModels() {
  const [models, setModels] = useState<Model[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchModels() {
      setIsLoading(true);
      try {
        const response = await fetch("/api/v1/models", {
          credentials: "include", // Include session cookies for auth
        });

        if (!response.ok) {
          throw new Error("Failed to fetch models");
        }

        const data: ModelsResponse = await response.json();

        // Filter to only allowed models
        const filteredModels = (data.data || []).filter((model) =>
          ALLOWED_CHAT_MODELS.includes(
            model.id as (typeof ALLOWED_CHAT_MODELS)[number],
          ),
        );

        // If no models match from API, use fallback curated list
        if (filteredModels.length === 0) {
          console.warn(
            "[useAvailableModels] No allowed models found in API response, using defaults",
          );
          setModels(
            ALLOWED_CHAT_MODELS.map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: id.split("/")[0] || "unknown",
            })),
          );
        } else {
          setModels(filteredModels);
        }

        setError(null);
      } catch (err) {
        console.error("[useAvailableModels] Error fetching models:", err);

        // Handle authentication errors gracefully
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load models";
        if (
          errorMessage.includes("Unauthorized") ||
          errorMessage.includes("Authentication")
        ) {
          setError("Please log in to view available models");
        } else {
          setError(errorMessage);
        }

        // Set curated default models as fallback
        // This ensures the UI is functional even if the API call fails
        setModels(
          ALLOWED_CHAT_MODELS.map((id) => ({
            id,
            object: "model",
            created: 0,
            owned_by: id.split("/")[0] || "unknown",
          })),
        );
      } finally {
        setIsLoading(false);
      }
    }

    fetchModels();
  }, []);

  return { models, isLoading, error };
}
