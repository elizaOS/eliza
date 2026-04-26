import { client } from "@elizaos/app-core/api";
import { isApiError } from "@elizaos/app-core/api/client-types-core";
import { APP_RESUME_EVENT } from "@elizaos/app-core/events";
import { useApp } from "@elizaos/app-core/state";
import { openExternalUrl } from "@elizaos/app-core/utils";
import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "@elizaos/app-lifeops/contracts";
import { LIFEOPS_GOOGLE_CAPABILITIES } from "@elizaos/app-lifeops/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  dispatchLifeOpsGoogleConnectorRefresh,
  LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT,
  type LifeOpsGoogleConnectorRefreshDetail,
} from "../events/index.js";

const DEFAULT_GOOGLE_CONNECTOR_POLL_INTERVAL_MS = 15_000;
const GOOGLE_CONNECTOR_SILENT_REFRESH_DEBOUNCE_MS = 150;
const GOOGLE_CONNECTOR_SILENT_REFRESH_COOLDOWN_MS = 1_000;
const DEFAULT_VISIBLE_GOOGLE_MODES: readonly LifeOpsConnectorMode[] = [
  "cloud_managed",
  "local",
] as const;
const GOOGLE_INBOX_TRACKING_CAPABILITIES: readonly LifeOpsGoogleCapability[] =
  LIFEOPS_GOOGLE_CAPABILITIES.filter(
    (capability) => capability !== "google.gmail.manage",
  );
const GOOGLE_CONNECTOR_STORAGE_KEY = "elizaos:lifeops:google-connector-refresh";
const GOOGLE_CONNECTOR_BROADCAST_CHANNEL = "elizaos:lifeops:google-connector";
const GOOGLE_CONNECTOR_MESSAGE_TYPE = "lifeops-google-connector-refresh";
let googleConnectorHookInstanceSeed = 0;

function isLifeOpsRuntimeReady(args: {
  startupPhase?: string | null;
  agentState?: string | null;
  backendState?: string | null;
}): boolean {
  return (
    args.startupPhase === "ready" &&
    args.agentState === "running" &&
    args.backendState === "connected"
  );
}

function isTransientLifeOpsAvailabilityError(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    cause.kind === "http" &&
    cause.status === 503 &&
    cause.path.startsWith("/api/lifeops/connectors/google/status")
  );
}

function formatConnectorError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return fallback;
}

function uniqueModes(
  modes: Iterable<LifeOpsConnectorMode | null | undefined>,
): LifeOpsConnectorMode[] {
  const ordered: LifeOpsConnectorMode[] = [];
  const seen = new Set<LifeOpsConnectorMode>();
  for (const mode of modes) {
    if (!mode || seen.has(mode)) {
      continue;
    }
    seen.add(mode);
    ordered.push(mode);
  }
  return ordered;
}

function resolveVisibleModes(
  status: LifeOpsGoogleConnectorStatus | null,
): LifeOpsConnectorMode[] {
  return uniqueModes([
    status?.mode,
    status?.defaultMode,
    ...(status?.availableModes ?? []),
    ...DEFAULT_VISIBLE_GOOGLE_MODES,
  ]);
}

function resolveConnectMode(
  status: LifeOpsGoogleConnectorStatus | null,
  selectedMode: LifeOpsConnectorMode | null,
): LifeOpsConnectorMode {
  if (
    status?.reason === "config_missing" &&
    (selectedMode ?? status.mode) === "local" &&
    (status.availableModes ?? []).includes("cloud_managed")
  ) {
    return "cloud_managed";
  }
  return selectedMode ?? status?.mode ?? status?.defaultMode ?? "cloud_managed";
}

function resolveSuccessRedirectUrl(
  side: LifeOpsConnectorSide,
): string | undefined {
  const baseUrl =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
  const origin =
    baseUrl ||
    (typeof window !== "undefined" &&
    typeof window.location?.origin === "string" &&
    window.location.origin.trim().length > 0
      ? window.location.origin.trim()
      : "");
  if (!origin) {
    return undefined;
  }
  const url = new URL("/api/lifeops/connectors/google/success", origin);
  url.searchParams.set("side", side);
  url.searchParams.set("mode", "cloud_managed");
  return url.toString();
}

function normalizeRefreshDetail(
  value: unknown,
): LifeOpsGoogleConnectorRefreshDetail | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    origin?: unknown;
    side?: unknown;
    mode?: unknown;
    source?: unknown;
  };
  const side =
    candidate.side === "owner" || candidate.side === "agent"
      ? candidate.side
      : undefined;
  const mode =
    candidate.mode === "local" ||
    candidate.mode === "remote" ||
    candidate.mode === "cloud_managed"
      ? candidate.mode
      : undefined;
  const source =
    candidate.source === "callback" ||
    candidate.source === "connect" ||
    candidate.source === "disconnect" ||
    candidate.source === "mode_change" ||
    candidate.source === "refresh" ||
    candidate.source === "focus" ||
    candidate.source === "visibility" ||
    candidate.source === "resume"
      ? candidate.source
      : undefined;
  return {
    origin:
      typeof candidate.origin === "string" && candidate.origin.trim().length > 0
        ? candidate.origin.trim()
        : undefined,
    side,
    mode,
    source,
  };
}

function parseRefreshEnvelope(rawValue: string): {
  type?: unknown;
  detail?: unknown;
} | null {
  try {
    return JSON.parse(rawValue) as {
      type?: unknown;
      detail?: unknown;
    };
  } catch {
    return null;
  }
}

export interface UseGoogleLifeOpsConnectorOptions {
  includeAccounts?: boolean;
  pollIntervalMs?: number;
  pollWhileDisconnected?: boolean;
  side?: LifeOpsConnectorSide;
}

export function useGoogleLifeOpsConnector(
  options: UseGoogleLifeOpsConnectorOptions = {},
) {
  const { agentStatus, backendConnection, startupPhase } = useApp();
  const includeAccounts = options.includeAccounts ?? false;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_GOOGLE_CONNECTOR_POLL_INTERVAL_MS;
  const pollWhileDisconnected = options.pollWhileDisconnected ?? true;
  const side = options.side ?? "owner";
  const instanceIdRef = useRef(
    `google-connector-hook-${googleConnectorHookInstanceSeed++}`,
  );
  const pendingSilentRefreshModeRef = useRef<
    LifeOpsConnectorMode | null | undefined
  >(undefined);
  const selectedModeRef = useRef<LifeOpsConnectorMode | null>(null);
  const silentRefreshTimerRef = useRef<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);
  const lastSilentRefreshAtRef = useRef(0);
  const [selectedMode, setSelectedMode] = useState<LifeOpsConnectorMode | null>(
    null,
  );
  const [status, setStatus] = useState<LifeOpsGoogleConnectorStatus | null>(
    null,
  );
  const [accounts, setAccounts] = useState<LifeOpsGoogleConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the latest OAuth URL local to the hook so it resets when the UI unmounts.
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const runtimeReady = isLifeOpsRuntimeReady({
    startupPhase,
    agentState: agentStatus?.state ?? null,
    backendState: backendConnection?.state ?? null,
  });

  const refresh = useCallback(
    async ({
      silent = false,
      mode,
    }: {
      silent?: boolean;
      mode?: LifeOpsConnectorMode | null;
    } = {}) => {
      if (!runtimeReady) {
        setError(null);
        setLoading(false);
        return;
      }
      if (!silent) {
        setLoading(true);
      }
      try {
        const requestedMode =
          mode === undefined ? selectedModeRef.current : mode;
        const [nextStatus, nextAccounts] = await Promise.all([
          client.getGoogleLifeOpsConnectorStatus(
            requestedMode ?? undefined,
            side,
          ),
          includeAccounts
            ? client.getGoogleLifeOpsConnectorAccounts(undefined, side)
            : Promise.resolve<LifeOpsGoogleConnectorStatus[]>([]),
        ]);
        const nextSelectedMode = requestedMode ?? nextStatus.mode;
        selectedModeRef.current = nextSelectedMode;
        setSelectedMode(nextSelectedMode);
        setStatus(nextStatus);
        setAccounts(nextAccounts);
        if (nextStatus.connected) {
          setPendingAuthUrl(null);
        }
        setError(null);
      } catch (cause) {
        if (isTransientLifeOpsAvailabilityError(cause)) {
          setError(null);
          return;
        }
        setError(
          formatConnectorError(
            cause,
            "Google connector status failed to refresh.",
          ),
        );
      } finally {
        setLoading(false);
      }
    },
    [includeAccounts, runtimeReady, side],
  );

  const queueSilentRefresh = useCallback(
    (mode?: LifeOpsConnectorMode | null) => {
      if (!runtimeReady) {
        return;
      }
      if (mode !== undefined) {
        pendingSilentRefreshModeRef.current = mode;
      }
      if (silentRefreshTimerRef.current !== null) {
        return;
      }
      const elapsed = Date.now() - lastSilentRefreshAtRef.current;
      const delay =
        elapsed >= GOOGLE_CONNECTOR_SILENT_REFRESH_COOLDOWN_MS
          ? GOOGLE_CONNECTOR_SILENT_REFRESH_DEBOUNCE_MS
          : GOOGLE_CONNECTOR_SILENT_REFRESH_COOLDOWN_MS - elapsed;
      silentRefreshTimerRef.current = globalThis.setTimeout(() => {
        silentRefreshTimerRef.current = null;
        const nextMode = pendingSilentRefreshModeRef.current;
        pendingSilentRefreshModeRef.current = undefined;
        lastSilentRefreshAtRef.current = Date.now();
        void refresh({
          silent: true,
          mode: nextMode,
        });
      }, delay);
    },
    [refresh, runtimeReady],
  );

  useEffect(() => {
    return () => {
      if (silentRefreshTimerRef.current === null) {
        return;
      }
      globalThis.clearTimeout(silentRefreshTimerRef.current);
      silentRefreshTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!runtimeReady) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, runtimeReady]);

  useEffect(() => {
    if (!runtimeReady) {
      return;
    }
    if (pollIntervalMs <= 0) {
      return;
    }
    if (!pollWhileDisconnected && status?.connected !== true) {
      return;
    }
    const intervalId = globalThis.setInterval(() => {
      void refresh({ silent: true });
    }, pollIntervalMs);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [
    pollIntervalMs,
    pollWhileDisconnected,
    refresh,
    runtimeReady,
    status?.connected,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const canUseWindowEvents =
      typeof window.addEventListener === "function" &&
      typeof window.removeEventListener === "function";
    const canUseDocumentEvents =
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function" &&
      typeof document.removeEventListener === "function";

    const refreshSilently = (
      detail?: LifeOpsGoogleConnectorRefreshDetail | null,
    ) => {
      if (!runtimeReady) {
        return;
      }
      if (detail?.origin === instanceIdRef.current) {
        return;
      }
      if (detail?.side && detail.side !== side) {
        return;
      }
      queueSilentRefresh(detail?.mode);
    };

    const handleConnectorRefresh = (event: Event) => {
      refreshSilently(
        normalizeRefreshDetail(
          (event as CustomEvent<LifeOpsGoogleConnectorRefreshDetail>).detail,
        ),
      );
    };

    const handleWindowMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        type?: unknown;
        detail?: unknown;
      };
      if (message?.type !== GOOGLE_CONNECTOR_MESSAGE_TYPE) {
        return;
      }
      refreshSilently(normalizeRefreshDetail(message.detail));
    };

    const handleStorage = (event: StorageEvent) => {
      if (
        event.key !== GOOGLE_CONNECTOR_STORAGE_KEY ||
        !event.newValue ||
        event.newValue.trim().length === 0
      ) {
        return;
      }
      const parsed = parseRefreshEnvelope(event.newValue);
      if (parsed?.type !== GOOGLE_CONNECTOR_MESSAGE_TYPE) {
        return;
      }
      refreshSilently(normalizeRefreshDetail(parsed.detail));
    };

    const handleFocus = () => {
      refreshSilently({ side, source: "focus" });
    };

    const handleVisibility = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      refreshSilently({ side, source: "visibility" });
    };

    const handleResume = () => {
      refreshSilently({ side, source: "resume" });
    };

    const broadcastChannel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(GOOGLE_CONNECTOR_BROADCAST_CHANNEL)
        : null;
    const handleBroadcastMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as {
        type?: unknown;
        detail?: unknown;
      };
      if (message?.type !== GOOGLE_CONNECTOR_MESSAGE_TYPE) {
        return;
      }
      refreshSilently(normalizeRefreshDetail(message.detail));
    };

    if (canUseWindowEvents) {
      window.addEventListener(
        LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT,
        handleConnectorRefresh,
      );
      window.addEventListener("message", handleWindowMessage);
      window.addEventListener("storage", handleStorage);
      window.addEventListener("focus", handleFocus);
    }
    if (canUseDocumentEvents) {
      document.addEventListener("visibilitychange", handleVisibility);
      document.addEventListener(APP_RESUME_EVENT, handleResume);
    }
    broadcastChannel?.addEventListener("message", handleBroadcastMessage);

    return () => {
      if (canUseWindowEvents) {
        window.removeEventListener(
          LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT,
          handleConnectorRefresh,
        );
        window.removeEventListener("message", handleWindowMessage);
        window.removeEventListener("storage", handleStorage);
        window.removeEventListener("focus", handleFocus);
      }
      if (canUseDocumentEvents) {
        document.removeEventListener("visibilitychange", handleVisibility);
        document.removeEventListener(APP_RESUME_EVENT, handleResume);
      }
      broadcastChannel?.removeEventListener("message", handleBroadcastMessage);
      broadcastChannel?.close();
    };
  }, [queueSilentRefresh, runtimeReady, side]);

  const selectMode = useCallback(
    async (mode: LifeOpsConnectorMode) => {
      try {
        setActionPending(true);
        setPendingAuthUrl(null);
        const nextStatus = (status?.availableModes ?? []).includes(mode)
          ? await client.selectGoogleLifeOpsConnectorMode({ mode, side })
          : await client.getGoogleLifeOpsConnectorStatus(mode, side);
        selectedModeRef.current = mode;
        setSelectedMode(mode);
        setStatus(nextStatus);
        setError(null);
        dispatchLifeOpsGoogleConnectorRefresh({
          origin: instanceIdRef.current,
          side,
          mode,
          source: "mode_change",
        });
      } catch (cause) {
        setError(
          formatConnectorError(cause, "Google connector mode change failed."),
        );
      } finally {
        setActionPending(false);
      }
    },
    [side, status],
  );

  const connect = useCallback(async () => {
    try {
      setActionPending(true);
      setPendingAuthUrl(null);
      const requestedCapabilities = [...GOOGLE_INBOX_TRACKING_CAPABILITIES];
      const connectMode = resolveConnectMode(
        status ?? null,
        selectedModeRef.current,
      );
      const result = await client.startGoogleLifeOpsConnector({
        capabilities: requestedCapabilities,
        redirectUrl:
          connectMode === "cloud_managed"
            ? resolveSuccessRedirectUrl(side)
            : undefined,
        side,
        mode: connectMode,
      });
      await openExternalUrl(result.authUrl);
      setPendingAuthUrl(result.authUrl);
      setError(null);
    } catch (cause) {
      setPendingAuthUrl(null);
      setError(
        formatConnectorError(cause, "Google connector setup failed to start."),
      );
    } finally {
      setActionPending(false);
    }
  }, [side, status]);

  const disconnect = useCallback(async () => {
    if (!status) {
      return;
    }
    try {
      setActionPending(true);
      setPendingAuthUrl(null);
      await client.disconnectGoogleLifeOpsConnector({
        side,
        mode: selectedModeRef.current ?? status.mode,
      });
      selectedModeRef.current = null;
      await refresh({ mode: null });
      dispatchLifeOpsGoogleConnectorRefresh({
        origin: instanceIdRef.current,
        side,
        source: "disconnect",
      });
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Google connector disconnect failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, [refresh, side, status]);

  const disconnectAccount = useCallback(
    async (grantId: string) => {
      try {
        setActionPending(true);
        await client.disconnectGoogleLifeOpsConnector({
          side,
          mode: selectedModeRef.current ?? status?.mode,
          grantId,
        } as DisconnectLifeOpsGoogleConnectorRequest & { grantId: string });
        await refresh({ mode: selectedModeRef.current });
        dispatchLifeOpsGoogleConnectorRefresh({
          origin: instanceIdRef.current,
          side,
          source: "disconnect",
        });
      } catch (cause) {
        setError(
          formatConnectorError(cause, "Google account disconnect failed."),
        );
      } finally {
        setActionPending(false);
      }
    },
    [refresh, side, status],
  );

  const connectAdditional = useCallback(async () => {
    try {
      setActionPending(true);
      const requestedCapabilities = [...GOOGLE_INBOX_TRACKING_CAPABILITIES];
      const connectMode = resolveConnectMode(
        status ?? null,
        selectedModeRef.current,
      );
      const result = await client.startGoogleLifeOpsConnector({
        capabilities: requestedCapabilities,
        redirectUrl:
          connectMode === "cloud_managed"
            ? resolveSuccessRedirectUrl(side)
            : undefined,
        side,
        mode: connectMode,
      });
      await openExternalUrl(result.authUrl);
      setError(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Google connector setup failed to start."),
      );
    } finally {
      setActionPending(false);
    }
  }, [side, status]);

  const modeOptions = useMemo(() => resolveVisibleModes(status), [status]);
  const activeMode =
    selectedMode ?? status?.mode ?? status?.defaultMode ?? "cloud_managed";

  return {
    accounts,
    activeMode,
    actionPending,
    connect,
    connectAdditional,
    disconnect,
    disconnectAccount,
    error,
    loading,
    modeOptions,
    pendingAuthUrl,
    refresh,
    selectMode,
    selectedMode,
    side,
    status,
  } as const;
}
