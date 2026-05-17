"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
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
    models.findIndex((candidate) => candidate.modelId === model.modelId) ===
    index,
);

export function useAvailableModels() {
  const { authenticated, ready } = useSessionAuth();
  const [models, setModels] = useState<SelectorModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const [refreshTick, setRefreshTick] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the model catalog must refetch after auth readiness changes and explicit steward-token-sync events.
  useEffect(() => {
    if (!ready) return;
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();

    async function fetchModels() {
      setIsLoading(true);

      try {
        const response = await fetch("/api/v1/models", {
          credentials: "include",
          signal: controller.signal,
        });
        if (requestIdRef.current !== requestId) return;

        if (!response.ok) {
          throw new Error("Failed to fetch models");
        }

        const data: ModelsResponse = await response.json();
        if (requestIdRef.current !== requestId) return;
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
        if (err instanceof Error && err.name === "AbortError") return;
        console.error("[useAvailableModels] Error fetching models:", err);

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

        setModels(FALLBACK_MODELS);
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    }

    void fetchModels();
    return () => {
      controller.abort();
    };
  }, [ready, authenticated, refreshTick]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleTokenSync = () => setRefreshTick((tick) => tick + 1);
    window.addEventListener("steward-token-sync", handleTokenSync);
    return () => {
      window.removeEventListener("steward-token-sync", handleTokenSync);
    };
  }, []);

  return { models, isLoading, error };
}
