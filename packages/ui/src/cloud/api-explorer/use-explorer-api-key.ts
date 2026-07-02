/**
 * Auto-mints (or fetches) the per-user "API Explorer" key used to run real,
 * billed test calls from the explorer.
 *
 * Backend: `GET /api/v1/api-keys/explorer` returns `{ apiKey, isNew? }`.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../lib/api-client";
import { toast } from "./toast";

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

export interface UseExplorerApiKeyResult {
  authToken: string;
  explorerKey: ExplorerApiKey | null;
  isLoading: boolean;
  error: string | null;
  refreshExplorerKey: () => Promise<void>;
  setAuthToken: (token: string) => void;
}

export function useExplorerApiKey(): UseExplorerApiKeyResult {
  const [authToken, setAuthToken] = useState("");
  const [explorerKey, setExplorerKey] = useState<ExplorerApiKey | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshExplorerKey = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await api<ExplorerApiKeyResponse>(
        "/api/v1/api-keys/explorer",
        { cache: "no-store" },
      );

      if (!data.apiKey) {
        setExplorerKey(null);
        setAuthToken("");
        setError(data.error || "Failed to fetch API key");
        return;
      }

      setExplorerKey(data.apiKey);
      setAuthToken(data.apiKey.key);

      if (data.isNew) {
        toast({ message: "API Explorer key created!", mode: "success" });
      }
    } catch (err) {
      setExplorerKey(null);
      setAuthToken("");
      setError(
        err instanceof ApiError ? err.message : "Failed to connect to server",
      );
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
