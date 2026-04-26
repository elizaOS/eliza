import { client } from "@elizaos/app-core/api";
import { openExternalUrl } from "@elizaos/app-core/utils";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsXConnectorStatus,
  LifeOpsXPostResponse,
} from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";

function formatError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

export function useLifeOpsXConnector(side: LifeOpsConnectorSide = "owner") {
  const [status, setStatus] = useState<LifeOpsXConnectorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPost, setLastPost] = useState<LifeOpsXPostResponse | null>(null);
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const resolveSuccessRedirectUrl = useCallback((): string | undefined => {
    const baseUrl =
      typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
    const origin =
      baseUrl ||
      (typeof window !== "undefined" &&
      typeof window.location?.origin === "string" &&
      window.location.origin.trim().length > 0
        ? window.location.origin.trim()
        : "");
    if (!origin) return undefined;
    const url = new URL("/api/lifeops/connectors/x/success", origin);
    url.searchParams.set("side", side);
    url.searchParams.set("mode", "cloud_managed");
    return url.toString();
  }, [side]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await client.getXLifeOpsConnectorStatus(
        undefined,
        side,
      );
      setStatus(nextStatus);
      if (nextStatus.connected) {
        setPendingAuthUrl(null);
      }
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "X connector status failed to load."));
    } finally {
      setLoading(false);
    }
  }, [side]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const nextStatus = await client.getXLifeOpsConnectorStatus(
          undefined,
          side,
        );
        if (cancelled) {
          return;
        }
        setStatus(nextStatus);
        if (nextStatus.connected) {
          setPendingAuthUrl(null);
        }
        setError(null);
      } catch (cause) {
        if (cancelled) {
          return;
        }
        setError(formatError(cause, "X connector status failed to load."));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [side]);

  const connect = useCallback(
    async (mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        setPendingAuthUrl(null);
        const connectMode =
          mode ?? status?.mode ?? status?.defaultMode ?? "cloud_managed";
        const result = await client.startXLifeOpsConnector({
          mode: connectMode,
          redirectUrl:
            connectMode === "cloud_managed"
              ? resolveSuccessRedirectUrl()
              : undefined,
          side,
        });
        if (result.authUrl) {
          await openExternalUrl(result.authUrl);
          setPendingAuthUrl(result.authUrl);
        } else {
          const nextStatus = await client.getXLifeOpsConnectorStatus(
            result.mode,
            side,
          );
          setStatus(nextStatus);
        }
        setError(null);
      } catch (cause) {
        setError(formatError(cause, "X connector connect failed."));
      } finally {
        setActionPending(false);
      }
    },
    [resolveSuccessRedirectUrl, side, status],
  );

  const post = useCallback(
    async (text: string, mode?: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        setLastPost(null);
        const result = await client.createXLifeOpsPost({
          side,
          mode: mode ?? status?.mode,
          text,
          confirmPost: true,
        });
        setLastPost(result);
        setError(null);
      } catch (cause) {
        setError(formatError(cause, "X post failed."));
      } finally {
        setActionPending(false);
      }
    },
    [side, status?.mode],
  );

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      await client.disconnectXLifeOpsConnector({
        side,
        mode: status?.mode,
      });
      setPendingAuthUrl(null);
      const nextStatus = await client.getXLifeOpsConnectorStatus(
        status?.mode,
        side,
      );
      setStatus(nextStatus);
      setError(null);
    } catch (cause) {
      setError(formatError(cause, "X connector disconnect failed."));
    } finally {
      setActionPending(false);
    }
  }, [side, status?.mode]);

  return {
    status,
    loading,
    actionPending,
    error,
    lastPost,
    pendingAuthUrl,
    refresh,
    connect,
    disconnect,
    post,
  } as const;
}
