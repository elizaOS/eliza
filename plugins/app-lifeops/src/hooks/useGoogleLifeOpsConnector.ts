import { client } from "@elizaos/app-core";
import { isApiError } from "@elizaos/app-core";
import { APP_RESUME_EVENT } from "@elizaos/shared";
import { dispatchFocusConnector } from "@elizaos/ui";
import { useApp } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "../contracts/index.js";
import {
  dispatchLifeOpsGoogleConnectorRefresh,
  LIFEOPS_GOOGLE_CONNECTOR_REFRESH_EVENT,
  type LifeOpsGoogleConnectorRefreshDetail,
} from "../events/index.js";
import { formatConnectorError } from "./connector-error.js";

const DEFAULT_GOOGLE_CONNECTOR_POLL_INTERVAL_MS = 15_000;
const GOOGLE_CONNECTOR_SILENT_REFRESH_DEBOUNCE_MS = 150;
const GOOGLE_CONNECTOR_SILENT_REFRESH_COOLDOWN_MS = 1_000;
const DEFAULT_VISIBLE_GOOGLE_MODES: readonly LifeOpsConnectorMode[] = [
  "local",
] as const;
const GOOGLE_CONNECTOR_STORAGE_KEY = "elizaos:lifeops:google-connector-refresh";
const GOOGLE_CONNECTOR_BROADCAST_CHANNEL = "elizaos:lifeops:google-connector";
const GOOGLE_CONNECTOR_MESSAGE_TYPE = "lifeops-google-connector-refresh";
const GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX = "connector-account:";
let googleConnectorHookInstanceSeed = 0;

type GoogleConnectorAccountsResponse = Awaited<
  ReturnType<typeof client.listConnectorAccounts>
>;
type GoogleConnectorAccountRecord =
  GoogleConnectorAccountsResponse["accounts"][number];

function googleGrantIdForAccount(accountId: string): string {
  return `${GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX}${accountId}`;
}

function googleAccountIdFromGrantId(grantId: string | null | undefined) {
  const normalized = typeof grantId === "string" ? grantId.trim() : "";
  if (!normalized) {
    return null;
  }
  return normalized.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? normalized.slice(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX.length)
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function metadata(
  account: Pick<GoogleConnectorAccountRecord, "metadata">,
): Record<string, unknown> {
  return isRecord(account.metadata) ? account.metadata : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function isoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : value.trim();
  }
  return null;
}

function mapGoogleCapability(value: string): LifeOpsGoogleCapability | null {
  switch (value) {
    case "google.basic_identity":
    case "basic_identity":
      return "google.basic_identity";
    case "google.calendar.read":
    case "calendar.read":
      return "google.calendar.read";
    case "google.calendar.write":
    case "calendar.write":
      return "google.calendar.write";
    case "google.gmail.triage":
    case "gmail.read":
      return "google.gmail.triage";
    case "google.gmail.send":
    case "gmail.send":
      return "google.gmail.send";
    case "google.gmail.manage":
    case "gmail.manage":
      return "google.gmail.manage";
    case "google.drive.read":
    case "drive.read":
      return "google.drive.read" as LifeOpsGoogleCapability;
    case "google.drive.write":
    case "drive.write":
      return "google.drive.write" as LifeOpsGoogleCapability;
    default:
      return null;
  }
}

function googleSideForAccount(
  account: Pick<GoogleConnectorAccountRecord, "role">,
): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

function googleCapabilitiesForAccount(
  account: GoogleConnectorAccountRecord,
): LifeOpsGoogleCapability[] {
  const meta = metadata(account);
  const values = [
    ...stringArray(meta.grantedCapabilities),
    ...stringArray(meta.capabilities),
    ...stringArray(meta.googleCapabilities),
  ];
  const scopes = stringArray(meta.grantedScopes);
  if (scopes.some((scope) => scope.includes("calendar"))) {
    values.push("google.calendar.read");
  }
  if (scopes.some((scope) => scope.includes("calendar.events"))) {
    values.push("google.calendar.write");
  }
  if (scopes.some((scope) => scope.includes("gmail.readonly"))) {
    values.push("google.gmail.triage");
  }
  if (scopes.some((scope) => scope.includes("gmail.send"))) {
    values.push("google.gmail.send");
  }
  if (
    scopes.some(
      (scope) =>
        scope.includes("gmail.modify") || scope.includes("gmail.settings"),
    )
  ) {
    values.push("google.gmail.manage");
  }
  if (scopes.some((scope) => scope.includes("drive"))) {
    values.push("google.drive.read");
  }
  if (
    scopes.some(
      (scope) => scope.includes("drive.file") || scope.endsWith("/auth/drive"),
    )
  ) {
    values.push("google.drive.write");
  }

  const normalized = new Set<LifeOpsGoogleCapability>([
    "google.basic_identity",
  ]);
  for (const value of values) {
    const capability = mapGoogleCapability(value);
    if (capability) {
      normalized.add(capability);
    }
  }
  if (normalized.has("google.calendar.write")) {
    normalized.add("google.calendar.read");
  }
  if (
    normalized.has("google.gmail.send") ||
    normalized.has("google.gmail.manage")
  ) {
    normalized.add("google.gmail.triage");
  }
  if (normalized.has("google.drive.write" as LifeOpsGoogleCapability)) {
    normalized.add("google.drive.read" as LifeOpsGoogleCapability);
  }
  return [...normalized];
}

function googleScopesForAccount(
  account: GoogleConnectorAccountRecord,
  capabilities = googleCapabilitiesForAccount(account),
): string[] {
  const scopes = stringArray(metadata(account).grantedScopes);
  if (scopes.length > 0) {
    return scopes;
  }
  const derived = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);
  if (capabilities.includes("google.calendar.read")) {
    derived.add("https://www.googleapis.com/auth/calendar.readonly");
  }
  if (capabilities.includes("google.calendar.write")) {
    derived.add("https://www.googleapis.com/auth/calendar.events");
  }
  if (capabilities.includes("google.gmail.triage")) {
    derived.add("https://www.googleapis.com/auth/gmail.readonly");
  }
  if (capabilities.includes("google.gmail.send")) {
    derived.add("https://www.googleapis.com/auth/gmail.send");
  }
  if (capabilities.includes("google.gmail.manage")) {
    derived.add("https://www.googleapis.com/auth/gmail.modify");
    derived.add("https://www.googleapis.com/auth/gmail.settings.basic");
  }
  if (capabilities.includes("google.drive.read" as LifeOpsGoogleCapability)) {
    derived.add("https://www.googleapis.com/auth/drive.readonly");
  }
  if (capabilities.includes("google.drive.write" as LifeOpsGoogleCapability)) {
    derived.add("https://www.googleapis.com/auth/drive.file");
  }
  return [...derived];
}

function googleIdentityForAccount(
  account: GoogleConnectorAccountRecord,
): Record<string, unknown> | null {
  const meta = metadata(account);
  const identity = isRecord(meta.identity) ? { ...meta.identity } : {};
  const externalId = stringValue(account.externalId);
  const handle = stringValue(account.handle);
  const label = stringValue(account.label);
  if (externalId) {
    identity.sub ??= externalId;
  }
  if (handle) {
    identity.email ??= handle;
  }
  if (label) {
    identity.name ??= label;
  }
  if (account.avatarUrl) {
    identity.picture ??= account.avatarUrl;
  }
  for (const key of ["email", "name", "picture", "locale"]) {
    const value = stringValue(meta[key]);
    if (value) {
      identity[key] = value;
    }
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

function googleAccountEmail(account: GoogleConnectorAccountRecord): string | null {
  const identity = googleIdentityForAccount(account);
  return (
    stringValue(identity?.email) ??
    stringValue(account.handle) ??
    null
  )?.toLowerCase() ?? null;
}

function isConnectedGoogleAccount(account: GoogleConnectorAccountRecord): boolean {
  return account.enabled !== false && account.status === "connected";
}

function googleGrantFromAccount(args: {
  account: GoogleConnectorAccountRecord;
  defaultAccountId?: string | null;
}): LifeOpsConnectorGrant {
  const { account, defaultAccountId } = args;
  const capabilities = googleCapabilitiesForAccount(account);
  const meta = metadata(account);
  const updatedAt = new Date(account.updatedAt ?? Date.now()).toISOString();
  const createdAt = new Date(account.createdAt ?? Date.now()).toISOString();
  const preferredByAgent =
    account.isDefault === true ||
    account.id === defaultAccountId ||
    booleanValue(meta.isDefault);
  return {
    id: googleGrantIdForAccount(account.id),
    agentId: "",
    provider: "google",
    connectorAccountId: account.id,
    side: googleSideForAccount(account),
    identity: googleIdentityForAccount(account) ?? {},
    identityEmail: googleAccountEmail(account),
    grantedScopes: googleScopesForAccount(account, capabilities),
    capabilities,
    tokenRef: null,
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    preferredByAgent,
    cloudConnectionId: null,
    metadata: {
      ...meta,
      connectorAccountId: account.id,
      connectorAccountProvider: "google",
    },
    lastRefreshAt: isoString(account.lastSyncedAt) ?? updatedAt,
    createdAt,
    updatedAt,
  };
}

function googleStatusFromConnectorAccount(args: {
  account: GoogleConnectorAccountRecord;
  defaultAccountId?: string | null;
}): LifeOpsGoogleConnectorStatus {
  const { account } = args;
  const grant = googleGrantFromAccount(args);
  const connected = isConnectedGoogleAccount(account);
  const meta = metadata(account);
  const reason =
    account.status === "needs-reauth" || account.status === "error"
      ? "needs_reauth"
      : connected
        ? "connected"
        : "disconnected";
  return {
    provider: "google",
    side: grant.side,
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected,
    reason,
    preferredByAgent: grant.preferredByAgent,
    cloudConnectionId: null,
    identity: googleIdentityForAccount(account),
    grantedCapabilities: [...grant.capabilities] as LifeOpsGoogleCapability[],
    grantedScopes: [...grant.grantedScopes],
    expiresAt: isoString(meta.expiresAt),
    hasRefreshToken:
      booleanValue(meta.hasRefreshToken) ||
      Boolean(stringValue(meta.refreshTokenRef)),
    grant,
  };
}

function disconnectedGoogleStatus(
  side: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side,
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: false,
    connected: false,
    reason: "disconnected",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    grant: null,
  };
}

function googleStatusesFromConnectorAccounts(
  response: GoogleConnectorAccountsResponse,
  side?: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus[] {
  return response.accounts
    .filter((account) => (side ? googleSideForAccount(account) === side : true))
    .map((account) =>
      googleStatusFromConnectorAccount({
        account,
        defaultAccountId: response.defaultAccountId ?? null,
      }),
    );
}

function selectGoogleStatus(
  statuses: readonly LifeOpsGoogleConnectorStatus[],
  side: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus {
  const sideStatuses = statuses.filter((status) => status.side === side);
  return (
    sideStatuses.find(
      (status) => status.connected && status.preferredByAgent,
    ) ??
    sideStatuses.find((status) => status.connected) ??
    sideStatuses[0] ??
    disconnectedGoogleStatus(side)
  );
}

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
    cause.path.startsWith("/api/connectors/google/accounts")
  );
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

type RefreshEnvelope = {
  type?: unknown;
  detail?: unknown;
};

function readRefreshEnvelope(value: unknown): RefreshEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    type: value.type,
    detail: value.detail,
  };
}

function normalizeRefreshDetail(
  value: unknown,
): LifeOpsGoogleConnectorRefreshDetail | null {
  if (!isRecord(value)) {
    return null;
  }
  const side =
    value.side === "owner" || value.side === "agent" ? value.side : undefined;
  const mode = value.mode === "local" ? value.mode : undefined;
  const source =
    value.source === "callback" ||
    value.source === "connect" ||
    value.source === "disconnect" ||
    value.source === "mode_change" ||
    value.source === "refresh" ||
    value.source === "focus" ||
    value.source === "visibility" ||
    value.source === "resume"
      ? value.source
      : undefined;
  return {
    origin:
      typeof value.origin === "string" && value.origin.trim().length > 0
        ? value.origin.trim()
        : undefined,
    side,
    mode,
    source,
  };
}

function parseRefreshEnvelope(rawValue: string): RefreshEnvelope | null {
  try {
    return readRefreshEnvelope(JSON.parse(rawValue));
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
        const response = await client.listConnectorAccounts("google");
        const statuses = googleStatusesFromConnectorAccounts(response);
        const nextStatus = selectGoogleStatus(statuses, side);
        const nextAccounts = includeAccounts
          ? googleStatusesFromConnectorAccounts(response, side)
          : [];
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
      const message = readRefreshEnvelope(event.data);
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
      const message = readRefreshEnvelope(event.data);
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
        const response = await client.listConnectorAccounts("google");
        const nextStatus = selectGoogleStatus(
          googleStatusesFromConnectorAccounts(response),
          side,
        );
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
    [side],
  );

  const connect = useCallback(async () => {
    try {
      setActionPending(true);
      setPendingAuthUrl(null);
      dispatchFocusConnector("google");
      setError(null);
    } catch (cause) {
      setPendingAuthUrl(null);
      setError(
        formatConnectorError(cause, "Google connector setup failed to start."),
      );
    } finally {
      setActionPending(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      setActionPending(true);
      setPendingAuthUrl(null);
      dispatchFocusConnector("google");
      setError(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Google connector management failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, []);

  const disconnectAccount = useCallback(
    async (grantId: string) => {
      try {
        setActionPending(true);
        const accountId = googleAccountIdFromGrantId(grantId);
        if (!accountId) {
          throw new Error("Google account id is missing.");
        }
        await client.deleteConnectorAccount("google", undefined, accountId);
        await refresh({ silent: true });
        setError(null);
      } catch (cause) {
        setError(
          formatConnectorError(cause, "Google account management failed."),
        );
      } finally {
        setActionPending(false);
      }
    },
    [refresh],
  );

  const connectAdditional = useCallback(async () => {
    try {
      setActionPending(true);
      dispatchFocusConnector("google");
      setError(null);
    } catch (cause) {
      setError(
        formatConnectorError(cause, "Google connector management failed."),
      );
    } finally {
      setActionPending(false);
    }
  }, []);

  const modeOptions = useMemo(() => resolveVisibleModes(status), [status]);
  const activeMode =
    selectedMode ?? status?.mode ?? status?.defaultMode ?? "local";

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
