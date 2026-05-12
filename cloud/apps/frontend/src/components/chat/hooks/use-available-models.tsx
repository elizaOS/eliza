"use client";

import { useEffect, useState } from "react";
import {
  ADDITIONAL_MODELS,
  type CatalogModel,
  FALLBACK_TEXT_SELECTOR_MODELS,
  isSelectableTextModel,
  type SelectorModel,
  sortSelectorModels,
  toSelectorModel,
} from "@/lib/models";

interface ModelsResponse {
  object: string;
  data: CatalogModel[];
}

const FALLBACK_MODELS: SelectorModel[] = sortSelectorModels([
  ...FALLBACK_TEXT_SELECTOR_MODELS.filter((model) => model.provider !== "groq"),
  ...ADDITIONAL_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    modelId: model.modelId,
    provider: model.provider,
    ...(model.recommended ? { recommended: true } : {}),
    ...(model.free ? { free: true } : {}),
  })),
]).filter(
  (model, index, models) =>
    models.findIndex((candidate) => candidate.modelId === model.modelId) === index,
);

export function useAvailableModels() {
  const [models, setModels] = useState<SelectorModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchModels() {
      setIsLoading(true);

      try {
        const response = await fetch("/api/v1/models", {
          credentials: "include",
        });

        if (!response.ok) {
          throw new Error("Failed to fetch models");
        }

        const data: ModelsResponse = await response.json();
        const filteredModels = sortSelectorModels(
          (data.data || []).filter(isSelectableTextModel).map(toSelectorModel),
        );

        if (filteredModels.length === 0) {
          console.warn(
            "[useAvailableModels] No selectable text models found in API response, using fallback catalog",
          );
          setModels(FALLBACK_MODELS);
        } else {
          setModels(filteredModels);
        }

        setError(null);
      } catch (err) {
        console.error("[useAvailableModels] Error fetching models:", err);

        const errorMessage = err instanceof Error ? err.message : "Failed to load models";
        if (errorMessage.includes("Unauthorized") || errorMessage.includes("Authentication")) {
          setError("Please log in to view available models");
        } else {
          setError(errorMessage);
        }

        setModels(FALLBACK_MODELS);
      } finally {
        setIsLoading(false);
      }
    }

    void fetchModels();
  }, []);

  return { models, isLoading, error };
}
