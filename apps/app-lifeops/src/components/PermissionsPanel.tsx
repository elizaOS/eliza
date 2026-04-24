import {
  Button,
  openExternalUrl,
  type AllPermissionsState,
  type PermissionState,
  type SystemPermissionId,
} from "@elizaos/app-core";
import { client } from "@elizaos/app-core/api";
import {
  AlertTriangle,
  Bell,
  Camera,
  FolderLock,
  Heart,
  MapPin,
  Mic,
  Monitor,
  MousePointer2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FullDiskAccessProbeResult } from "../lifeops/fda-probe.js";

type PermissionDisplayStatus =
  | "granted"
  | "denied"
  | "unknown"
  | "not-applicable";

interface PermissionEntry {
  id: string;
  systemId?: SystemPermissionId;
  name: string;
  description: string;
  guidance?: string;
  icon: React.ReactNode;
  status: PermissionDisplayStatus;
  statusText?: string;
  canRequest?: boolean;
}

const ICON_CLASS = "h-4 w-4 shrink-0";
const MACOS_FULL_DISK_ACCESS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const MAC_WINDOW_PERMISSION_IDS = [
  "accessibility",
  "screen-recording",
] as const satisfies readonly SystemPermissionId[];

function detectPlatform(): "macos" | "ios" | "other" {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return "ios";
  }
  if (/Macintosh/.test(ua)) {
    return "macos";
  }
  return "other";
}

function isGranted(state: PermissionState | undefined): boolean {
  return state?.status === "granted" || state?.status === "not-applicable";
}

function displayStatusFromSystem(
  state: PermissionState | undefined,
): PermissionDisplayStatus {
  if (!state) {
    return "unknown";
  }
  if (state.status === "granted") {
    return "granted";
  }
  if (state.status === "not-applicable") {
    return "not-applicable";
  }
  if (state.status === "denied" || state.status === "restricted") {
    return "denied";
  }
  return "unknown";
}

function fullDiskAccessDisplayStatus(
  fdaStatus: FullDiskAccessProbeResult | null,
): PermissionDisplayStatus {
  switch (fdaStatus?.status) {
    case "granted":
      return "granted";
    case "not_applicable":
      return "not-applicable";
    case "revoked":
      return "denied";
    default:
      return "unknown";
  }
}

function systemStatusText(
  state: PermissionState | undefined,
  fallback = "Check in System Settings",
): string {
  switch (state?.status) {
    case "granted":
      return "Enabled";
    case "not-applicable":
      return "Not needed";
    case "denied":
      return "Denied";
    case "restricted":
      return "Restricted";
    case "not-determined":
      return state.canRequest ? "Ready to grant" : fallback;
    default:
      return fallback;
  }
}

function fullDiskAccessStatusText(
  fdaStatus: FullDiskAccessProbeResult | null,
): string {
  switch (fdaStatus?.status) {
    case "granted":
      return "Enabled";
    case "not_applicable":
      return "Not needed";
    case "revoked":
      return "Blocked";
    default:
      return "Check in System Settings";
  }
}

function macosPermissions(
  permissions: AllPermissionsState | null,
  fdaStatus: FullDiskAccessProbeResult | null,
): PermissionEntry[] {
  const accessibility = permissions?.accessibility;
  const screenRecording = permissions?.["screen-recording"];
  return [
    {
      id: "accessibility",
      systemId: "accessibility",
      name: "Accessibility",
      description:
        "Allows Milady to focus windows, click, type, and guide real browser or desktop actions.",
      guidance:
        "When macOS opens Privacy & Security, enable Milady.app. In local dev, enable the host app that launched Milady, such as Terminal, iTerm, Cursor, or Bun.",
      icon: <MousePointer2 className={ICON_CLASS} />,
      status: displayStatusFromSystem(accessibility),
      statusText: systemStatusText(accessibility),
      canRequest: accessibility?.canRequest,
    },
    {
      id: "screen-recording",
      systemId: "screen-recording",
      name: "Screen Recording",
      description:
        "Lets Milady see browser windows, screenshots, and overlay context for visual guidance.",
      guidance:
        "macOS may require quitting and reopening Milady after you toggle this permission.",
      icon: <Monitor className={ICON_CLASS} />,
      status: displayStatusFromSystem(screenRecording),
      statusText: systemStatusText(screenRecording),
      canRequest: screenRecording?.canRequest,
    },
    {
      id: "full-disk-access",
      name: "Full Disk Access",
      description:
        "Allows the local iMessage connector to read chat.db for wake detection and incoming Messages context.",
      guidance:
        "Grant access to Milady.app for packaged desktop builds, or to Terminal, iTerm, Cursor, or Bun when running from source.",
      icon: <FolderLock className={ICON_CLASS} />,
      status: fullDiskAccessDisplayStatus(fdaStatus),
      statusText: fullDiskAccessStatusText(fdaStatus),
    },
  ];
}

function iosPermissions(): PermissionEntry[] {
  return [
    {
      id: "camera",
      name: "Camera",
      description: "Photo and video capture",
      icon: <Camera className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "microphone",
      name: "Microphone",
      description: "Voice commands",
      icon: <Mic className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "location",
      name: "Location",
      description: "Location-aware reminders",
      icon: <MapPin className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "healthkit",
      name: "HealthKit",
      description: "Health and fitness data",
      icon: <Heart className={ICON_CLASS} />,
      status: "unknown",
    },
    {
      id: "notifications",
      name: "Notifications",
      description: "Reminders and alerts",
      icon: <Bell className={ICON_CLASS} />,
      status: "unknown",
    },
  ];
}

function statusColor(status: PermissionDisplayStatus): string {
  switch (status) {
    case "granted":
      return "bg-emerald-500";
    case "denied":
      return "bg-red-500";
    case "not-applicable":
      return "bg-muted/40";
    default:
      return "bg-amber-400";
  }
}

function defaultStatusText(status: PermissionDisplayStatus): string {
  switch (status) {
    case "granted":
      return "Enabled";
    case "denied":
      return "Needs access";
    case "not-applicable":
      return "Not needed";
    default:
      return "Check in System Settings";
  }
}

function PermissionRow({
  busy,
  entry,
  onAction,
}: {
  busy: boolean;
  entry: PermissionEntry;
  onAction: (entry: PermissionEntry) => void;
}) {
  const canAct =
    entry.status !== "granted" && entry.status !== "not-applicable";
  const buttonLabel = entry.canRequest ? "Grant" : "Open Settings";

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-card/12 px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 text-muted">{entry.icon}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-txt">{entry.name}</div>
          <div className="text-xs leading-relaxed text-muted">
            {entry.description}
          </div>
          {entry.guidance ? (
            <div className="mt-1 text-[11px] leading-relaxed text-muted">
              {entry.guidance}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${statusColor(entry.status)}`}
        />
        <span className="text-xs text-muted">
          {entry.statusText ?? defaultStatusText(entry.status)}
        </span>
        {canAct ? (
          <Button
            size="sm"
            variant="default"
            className="h-7 rounded-lg px-3 text-[11px] font-semibold"
            disabled={busy}
            onClick={() => onAction(entry)}
          >
            {busy ? "Opening..." : buttonLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function PermissionsPanel() {
  const platform = useMemo(() => detectPlatform(), []);
  const [fdaStatus, setFdaStatus] = useState<FullDiskAccessProbeResult | null>(
    null,
  );
  const [desktopPermissions, setDesktopPermissions] =
    useState<AllPermissionsState | null>(null);
  const [loading, setLoading] = useState(platform === "macos");
  const [busyPermission, setBusyPermission] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (platform !== "macos") {
      return;
    }
    setLoading(true);
    setError(null);
    const [fdaResult, permissionsResult] = await Promise.allSettled([
      client.getLifeOpsFullDiskAccessStatus(),
      client.getPermissions(),
    ]);

    if (fdaResult.status === "fulfilled") {
      setFdaStatus(fdaResult.value);
    }

    if (permissionsResult.status === "fulfilled") {
      setDesktopPermissions(permissionsResult.value);
    } else {
      setDesktopPermissions(null);
      setError(
        permissionsResult.reason instanceof Error
          ? permissionsResult.reason.message
          : String(permissionsResult.reason),
      );
    }

    setLoading(false);
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.setTimeout(() => {
      void refresh();
    }, 2000);
    window.setTimeout(() => {
      void refresh();
    }, 5000);
  }, [refresh]);

  const handleFullDiskAccess = useCallback(async () => {
    setBusyPermission("full-disk-access");
    setError(null);
    try {
      await openExternalUrl(MACOS_FULL_DISK_ACCESS_SETTINGS_URL);
      scheduleRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyPermission(null);
    }
  }, [scheduleRefresh]);

  const handleSystemPermission = useCallback(
    async (id: SystemPermissionId) => {
      setBusyPermission(id);
      setError(null);
      try {
        const state = desktopPermissions?.[id];
        if (state?.status === "not-determined" && state.canRequest) {
          await client.requestPermission(id);
        } else {
          await client.openPermissionSettings(id);
        }
        await refresh();
        scheduleRefresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyPermission(null);
      }
    },
    [desktopPermissions, refresh, scheduleRefresh],
  );

  const handlePermissionAction = useCallback(
    (entry: PermissionEntry) => {
      if (entry.systemId) {
        void handleSystemPermission(entry.systemId);
        return;
      }
      if (entry.id === "full-disk-access") {
        void handleFullDiskAccess();
      }
    },
    [handleFullDiskAccess, handleSystemPermission],
  );

  const handleGuidedMacSetup = useCallback(async () => {
    for (const id of MAC_WINDOW_PERMISSION_IDS) {
      if (!isGranted(desktopPermissions?.[id])) {
        await handleSystemPermission(id);
        return;
      }
    }
    if (fdaStatus?.status === "revoked") {
      await handleFullDiskAccess();
    }
  }, [
    desktopPermissions,
    fdaStatus?.status,
    handleFullDiskAccess,
    handleSystemPermission,
  ]);

  const permissions = useMemo(() => {
    switch (platform) {
      case "macos":
        return macosPermissions(desktopPermissions, fdaStatus);
      case "ios":
        return iosPermissions();
      default:
        return [];
    }
  }, [desktopPermissions, fdaStatus, platform]);

  const missingMacWindowPermissions = MAC_WINDOW_PERMISSION_IDS.filter(
    (id) => !isGranted(desktopPermissions?.[id]),
  );
  const needsFullDiskAccess = fdaStatus?.status === "revoked";
  const showGuidedMacSetup =
    platform === "macos" &&
    (missingMacWindowPermissions.length > 0 || needsFullDiskAccess);
  const title = platform === "macos" ? "Mac Permissions" : "Device Permissions";

  if (permissions.length === 0) {
    return null;
  }

  return (
    <section id="lifeops-mac-permissions" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">
            {title}
          </div>
          <div className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            For the smoothest setup, Milady opens the exact macOS privacy panes
            it needs. Accessibility handles window control, Screen Recording
            handles screenshots and visual overlays, and Full Disk Access is
            only needed for local iMessage history.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {showGuidedMacSetup ? (
            <Button
              size="sm"
              className="h-8 rounded-xl px-3 text-xs font-semibold"
              disabled={busyPermission !== null}
              onClick={() => void handleGuidedMacSetup()}
            >
              <Sparkles className="mr-1.5 h-3 w-3" />
              Start Mac Permission Setup
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-xl px-3 text-xs font-semibold"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Refresh
          </Button>
        </div>
      </div>

      {fdaStatus?.status === "revoked" ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div>
            <div className="font-semibold">Full Disk Access revoked</div>
            <div className="mt-0.5 text-amber-200/80">
              {fdaStatus.reason ??
                "Grant Full Disk Access to the app running Milady, then relaunch it."}
            </div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="rounded-2xl bg-card/12 px-3 py-3 text-xs text-muted">
          Checking macOS permissions...
        </div>
      ) : null}

      <div className="space-y-2">
        {permissions.map((entry) => (
          <PermissionRow
            key={entry.id}
            busy={busyPermission === entry.id}
            entry={entry}
            onAction={handlePermissionAction}
          />
        ))}
      </div>
    </section>
  );
}
