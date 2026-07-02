/**
 * Shared data layer for OAuth-redirect cloud connectors (Google, Microsoft).
 *
 * Handles listing connections (`GET /api/v1/oauth/connections?platform=`),
 * initiating the OAuth redirect (`POST /api/v1/oauth/<platform>/initiate`), and
 * revoking a connection (`DELETE /api/v1/oauth/connections/:id`).
 * Token/credential connectors (Telegram, Twilio, WhatsApp, Blooio) use a
 * different connect flow and are intentionally not covered here.
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, api } from "../lib/api-client";

/**
 * A single OAuth connection row returned by
 * `GET /api/v1/oauth/connections?platform=<platform>`.
 */
export interface OAuthConnection {
  id: string;
  platform: string;
  email?: string;
  displayName?: string;
  scopes?: string[];
  status: string;
}

/**
 * Per-provider configuration for the shared OAuth connection logic. Only the
 * pieces that genuinely vary between providers (platform key, initiate path,
 * and user-facing labels) live here; the fetch / initiate / disconnect flow is
 * identical and owned by {@link useOAuthConnections}.
 */
export interface OAuthProviderConfig {
  /** Platform query value, e.g. "google" / "microsoft". */
  platform: string;
  /** Human label used in toast messages, e.g. "Google" / "Microsoft". */
  label: string;
}

interface UseOAuthConnectionsResult {
  connections: OAuthConnection[];
  activeConnections: OAuthConnection[];
  isLoading: boolean;
  isConnecting: boolean;
  disconnectingId: string | null;
  connect: () => Promise<void>;
  disconnect: (connectionId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

function errorBodyMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body;
    if (body && typeof body === "object" && "error" in body) {
      const apiError = (body as { error?: unknown }).error;
      if (typeof apiError === "string" && apiError) return apiError;
    }
    return error.message || fallback;
  }
  return fallback;
}

export function useOAuthConnections(
  config: OAuthProviderConfig,
): UseOAuthConnectionsResult {
  const { platform, label } = config;
  const [connections, setConnections] = useState<OAuthConnection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  const fetchConnections = useCallback(
    async (signal?: AbortSignal) => {
      setIsLoading(true);
      try {
        const data = await api<{ connections?: OAuthConnection[] }>(
          `/api/v1/oauth/connections?platform=${platform}`,
          { signal },
        );
        if (!signal?.aborted) {
          setConnections(data.connections ?? []);
        }
      } catch {
        if (!signal?.aborted) {
          toast.error(`Failed to fetch ${label} connections`);
        }
      } finally {
        if (!signal?.aborted) {
          setIsLoading(false);
        }
      }
    },
    [platform, label],
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchConnections(controller.signal);
    return () => controller.abort();
  }, [fetchConnections]);

  const connect = useCallback(async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    try {
      const data = await api<{ authUrl?: string; error?: string }>(
        `/api/v1/oauth/${platform}/initiate`,
        {
          method: "POST",
          json: { redirectUrl: "/dashboard/settings?tab=connections" },
        },
      );
      if (data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      toast.error(data.error || `Failed to initiate ${label} OAuth`);
      setIsConnecting(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? errorBodyMessage(error, `Failed to initiate ${label} OAuth`)
          : "Network error. Please check your connection.",
      );
      setIsConnecting(false);
    }
  }, [isConnecting, platform, label]);

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (disconnectingId) return;
      setDisconnectingId(connectionId);
      try {
        await api(`/api/v1/oauth/connections/${connectionId}`, {
          method: "DELETE",
        });
        toast.success(`${label} account disconnected`);
        await fetchConnections();
      } catch (error) {
        toast.error(errorBodyMessage(error, "Failed to disconnect"));
      } finally {
        setDisconnectingId(null);
      }
    },
    [disconnectingId, label, fetchConnections],
  );

  const activeConnections = connections.filter((c) => c.status === "active");

  return {
    connections,
    activeConnections,
    isLoading,
    isConnecting,
    disconnectingId,
    connect,
    disconnect,
    refetch: fetchConnections,
  };
}
