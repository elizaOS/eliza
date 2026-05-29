"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

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

/**
 * Shared data layer for OAuth-redirect connection cards (Google, Microsoft).
 * Handles listing connections, initiating the OAuth redirect, and revoking a
 * connection. Token/credential connectors (Telegram, Twilio, WhatsApp, Blooio)
 * use a different connect flow and are intentionally not covered here.
 */
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
        const response = await fetch(
          `/api/v1/oauth/connections?platform=${platform}`,
          { signal },
        );
        if (signal?.aborted) return;
        if (!response.ok) {
          toast.error(`Failed to fetch ${label} connections`);
          return;
        }
        const data = (await response.json()) as {
          connections?: OAuthConnection[];
        };
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
      const response = await fetch(`/api/v1/oauth/${platform}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUrl: "/dashboard/settings?tab=connections",
        }),
      });
      const data = (await response.json()) as {
        authUrl?: string;
        error?: string;
      };
      if (response.ok && data.authUrl) {
        window.location.href = data.authUrl;
        return;
      }
      toast.error(data.error || `Failed to initiate ${label} OAuth`);
      setIsConnecting(false);
    } catch {
      toast.error("Network error. Please check your connection.");
      setIsConnecting(false);
    }
  }, [isConnecting, platform, label]);

  const disconnect = useCallback(
    async (connectionId: string) => {
      if (disconnectingId) return;
      setDisconnectingId(connectionId);
      try {
        const response = await fetch(
          `/api/v1/oauth/connections/${connectionId}`,
          { method: "DELETE" },
        );
        if (response.ok) {
          toast.success(`${label} account disconnected`);
          await fetchConnections();
        } else {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(data.error || "Failed to disconnect");
        }
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
