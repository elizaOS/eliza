"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "@/lib/utils/toast-adapter";

export interface ExplorerApiKey {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  key: string;
  created_at: string;
  is_active: boolean;
  usage_count: number;
  last_used_at: string | null;
}

interface ExplorerApiKeyResponse {
  apiKey?: ExplorerApiKey;
  error?: string;
  isNew?: boolean;
}

export function useExplorerApiKey() {
  const [authToken, setAuthToken] = useState("");
  const [explorerKey, setExplorerKey] = useState<ExplorerApiKey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshExplorerKey = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/v1/api-keys/explorer", {
        cache: "no-store",
      });
      const data = (await response.json()) as ExplorerApiKeyResponse;

      if (!response.ok || !data.apiKey) {
        setExplorerKey(null);
        setAuthToken("");
        setError(data.error || "Failed to fetch API key");
        return;
      }

      setExplorerKey(data.apiKey);
      setAuthToken(data.apiKey.key);

      if (data.isNew) {
        toast({
          message: "API Explorer key created!",
          mode: "success",
        });
      }
    } catch (error) {
      console.error("Failed to fetch explorer key:", error);
      setExplorerKey(null);
      setAuthToken("");
      setError("Failed to connect to server");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshExplorerKey();
    });
  }, [refreshExplorerKey]);

  return {
    authToken,
    explorerKey,
    isLoading,
    error,
    refreshExplorerKey,
    setAuthToken,
  };
}
