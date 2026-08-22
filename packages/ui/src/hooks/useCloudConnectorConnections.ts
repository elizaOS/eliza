/**
 * Normalizes Cloud connector connection catalogs and credential-provider
 * status routes for product surfaces that need connect/disconnect state.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../cloud/lib/api-client";

export type CloudConnectorStatusKind = "oauth" | "discord" | "credential";

export interface CloudConnectorConnectionState {
  connected: boolean;
  statusText: string;
  loading: boolean;
  error: string | null;
}

interface OAuthStatusResponse {
  connections?: Array<{ id?: string; status?: string }>;
}

interface DiscordStatusResponse {
  connections?: Array<{ id?: string; status?: string; isActive?: boolean }>;
}

interface CredentialStatusResponse {
  configured?: boolean;
  connected?: boolean;
  webhookConfigured?: boolean;
  error?: string;
}

function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return "Could not load connection status";
  if (error.status === 401) return "Sign in to Cloud";
  const body = error.body as { error?: unknown; message?: unknown } | undefined;
  if (typeof body?.error === "string" && body.error) return body.error;
  if (typeof body?.message === "string" && body.message) return body.message;
  return error.message || "Could not load connection status";
}

export function normalizeCloudConnectorConnectionState(
  kind: CloudConnectorStatusKind,
  response:
    | OAuthStatusResponse
    | DiscordStatusResponse
    | CredentialStatusResponse,
): Omit<CloudConnectorConnectionState, "loading"> {
  if (kind === "oauth") {
    const connections = (response as OAuthStatusResponse).connections ?? [];
    const active = connections.some(
      (connection) => connection.status === "active",
    );
    return {
      connected: connections.length > 0,
      statusText: active
        ? "Connected"
        : connections.length > 0
          ? "Needs attention"
          : "Not connected",
      error: null,
    };
  }

  if (kind === "discord") {
    const connections = (response as DiscordStatusResponse).connections ?? [];
    return {
      connected: connections.length > 0,
      statusText:
        connections.length > 0
          ? `Connected — ${connections.length} bot${connections.length > 1 ? "s" : ""}`
          : "Not connected",
      error: null,
    };
  }

  const status = response as CredentialStatusResponse;
  const configured = Boolean(
    status.configured || status.connected || status.webhookConfigured,
  );
  return {
    connected: configured,
    statusText: status.connected
      ? "Connected"
      : configured
        ? "Needs attention"
        : "Not connected",
    error: status.error ?? null,
  };
}

export function useCloudConnectorConnections({
  kind,
  statusPath,
}: {
  kind: CloudConnectorStatusKind;
  statusPath: string;
}) {
  const [state, setState] = useState<CloudConnectorConnectionState>({
    connected: false,
    statusText: "Not connected",
    loading: true,
    error: null,
  });

  const refetch = useCallback(async () => {
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const response = await api<
        OAuthStatusResponse | DiscordStatusResponse | CredentialStatusResponse
      >(statusPath);
      setState({
        ...normalizeCloudConnectorConnectionState(kind, response),
        loading: false,
      });
    } catch (error) {
      setState({
        connected: false,
        statusText: "Unavailable",
        loading: false,
        error: apiErrorMessage(error),
      });
    }
  }, [kind, statusPath]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { state, refetch };
}
