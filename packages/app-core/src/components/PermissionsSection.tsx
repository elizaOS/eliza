/**
 * PermissionsSection — System permissions and capability toggles for Settings.
 *
 * Displays:
 *   - System permission statuses (accessibility, screen-recording, microphone, camera)
 *   - Shell access toggle (soft disable/enable)
 *   - Capability toggles (browser, computeruse, vision) that depend on permissions
 *
 * Works cross-platform with platform-specific permission requirements:
 *   - Electrobun desktop: OS-level permission prompts and system settings links
 *   - Capacitor (mobile): Camera/mic/screen streaming permissions via native plugins
 *   - Web: Informational message only (no OS-level access)
 */

import { Button } from "@miladyai/ui";
import { Check } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type AllPermissionsState,
  client,
  type PermissionState,
  type PermissionStatus,
  type PluginInfo,
  type SystemPermissionId,
} from "../api";
import {
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../bridge";
import {
  hasRequiredOnboardingPermissions,
  isDesktopPlatform,
  isNative,
  isWebPlatform,
} from "../platform";
import { useApp } from "../state";
import { PermissionIcon } from "./permissions/PermissionIcon";
import {
  StreamingPermissionsOnboardingView,
  StreamingPermissionsSettingsView,
} from "./permissions/StreamingPermissions";
import { StatusBadge } from "./ui-badges";
import { Switch } from "./ui-switch";

/** Permission definition for UI rendering. */
interface PermissionDef {
  id: SystemPermissionId;
  name: string;
  description: string;
  icon: string;
  platforms: string[];
  requiredForFeatures: string[];
}

const SYSTEM_PERMISSIONS: PermissionDef[] = [
  {
    id: "accessibility",
    name: "Accessibility",
    description:
      "Control mouse, keyboard, and interact with other applications",
    icon: "cursor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "browser"],
  },
  {
    id: "screen-recording",
    name: "Screen Recording",
    description: "Capture screen content for screenshots and vision",
    icon: "monitor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "vision"],
  },
  {
    id: "microphone",
    name: "Microphone",
    description: "Voice input for talk mode and speech recognition",
    icon: "mic",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["talkmode", "voice"],
  },
  {
    id: "camera",
    name: "Camera",
    description: "Video input for vision and video capture",
    icon: "camera",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["camera", "vision"],
  },
  {
    id: "shell",
    name: "Shell Access",
    description: "Execute terminal commands and scripts",
    icon: "terminal",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["shell"],
  },
];

/** Capability toggle definition. */
interface CapabilityDef {
  id: string;
  label: string;
  description: string;
  requiredPermissions: SystemPermissionId[];
}

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "browser",
    label: "Browser Control",
    description: "Automated web browsing and interaction",
    requiredPermissions: ["accessibility"],
  },
  {
    id: "computeruse",
    label: "Computer Use",
    description: "Full desktop control with mouse and keyboard",
    requiredPermissions: ["accessibility", "screen-recording"],
  },
  {
    id: "vision",
    label: "Vision",
    description: "Screen capture and visual analysis",
    requiredPermissions: ["screen-recording"],
  },
  {
    id: "coding-agent",
    label: "Coding Agent Swarms",
    description:
      "Orchestrate CLI coding agents (Claude Code, Gemini, Codex, Aider, Pi)",
    requiredPermissions: [],
  },
];

const PERMISSION_BADGE_LABELS: Record<
  PermissionStatus,
  { tone: "success" | "danger" | "warning" | "muted"; label: string }
> = {
  granted: { tone: "success", label: "Granted" },
  denied: { tone: "danger", label: "Denied" },
  "not-determined": { tone: "warning", label: "Not Set" },
  restricted: { tone: "muted", label: "Restricted" },
  "not-applicable": { tone: "muted", label: "N/A" },
};

function translateWithFallback(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return !value || value === key ? fallback : value;
}

function getPermissionAction(
  t: (key: string) => string,
  id: SystemPermissionId,
  status: PermissionStatus,
  canRequest: boolean,
): {
  ariaLabelPrefix: string;
  label: string;
  type: "request" | "settings";
} | null {
  if (status === "granted" || status === "not-applicable") {
    return null;
  }

  if (status === "not-determined" && canRequest) {
    const label =
      id === "camera"
        ? translateWithFallback(
            t,
            "permissionssection.CheckAccess",
            "Check Access",
          )
        : translateWithFallback(t, "permissionssection.Grant", "Grant");
    return {
      ariaLabelPrefix: label,
      label,
      type: "request",
    };
  }

  const label = translateWithFallback(
    t,
    "permissionssection.OpenSettings",
    "Open Settings",
  );
  return {
    ariaLabelPrefix: label,
    label,
    type: "settings",
  };
}

type DesktopMediaPermissionId = Extract<
  SystemPermissionId,
  "camera" | "microphone"
>;

function isDesktopMediaPermission(
  id: SystemPermissionId,
): id is DesktopMediaPermissionId {
  return id === "camera" || id === "microphone";
}

function mapRendererMediaPermissionState(
  state: "granted" | "denied" | "prompt" | undefined,
): PermissionStatus | null {
  if (state === "granted") {
    return "granted";
  }
  if (state === "denied") {
    return "denied";
  }
  if (state === "prompt") {
    return "not-determined";
  }
  return null;
}

function getRendererMediaConstraints(
  id: DesktopMediaPermissionId,
): MediaStreamConstraints {
  return id === "camera" ? { video: true } : { audio: true };
}

async function queryRendererMediaPermission(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return null;
  }

  try {
    const result = await navigator.permissions.query({
      name: id as PermissionName,
    });
    return mapRendererMediaPermissionState(result?.state);
  } catch {
    return null;
  }
}

async function inferRendererMediaPermissionFromDevices(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return null;
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!Array.isArray(devices)) {
      return null;
    }

    const kind = id === "camera" ? "videoinput" : "audioinput";
    return devices.some(
      (device) => device.kind === kind && Boolean(device.label?.trim()),
    )
      ? "granted"
      : null;
  } catch {
    return null;
  }
}

async function probeRendererMediaPermission(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  const queriedStatus = await queryRendererMediaPermission(id);
  if (queriedStatus === "granted" || queriedStatus === "denied") {
    return queriedStatus;
  }

  const inferredStatus = await inferRendererMediaPermissionFromDevices(id);
  if (inferredStatus) {
    return inferredStatus;
  }

  return queriedStatus;
}

async function requestRendererMediaPermission(
  id: DesktopMediaPermissionId,
): Promise<PermissionStatus | null> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return null;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      getRendererMediaConstraints(id),
    );
    stream.getTracks().forEach((track) => {
      track.stop();
    });
    return "granted";
  } catch {
    return probeRendererMediaPermission(id);
  }
}

async function reconcileRendererMediaPermissions(
  snapshot: DesktopPermissionsSnapshot,
): Promise<DesktopPermissionsSnapshot> {
  let nextPermissions = snapshot.permissions;
  let changed = false;

  for (const id of ["camera", "microphone"] as const) {
    const current = snapshot.permissions[id];
    if (!current || current.status === "restricted") {
      continue;
    }

    const rendererStatus = await probeRendererMediaPermission(id);
    if (!rendererStatus) {
      continue;
    }

    const nextCanRequest = rendererStatus === "not-determined";
    if (
      current.status === rendererStatus &&
      current.canRequest === nextCanRequest
    ) {
      continue;
    }

    if (!changed) {
      nextPermissions = { ...snapshot.permissions };
      changed = true;
    }

    nextPermissions[id] = {
      ...current,
      status: rendererStatus,
      canRequest: nextCanRequest,
      lastChecked: Date.now(),
    };
  }

  return changed
    ? {
        ...snapshot,
        permissions: nextPermissions,
      }
    : snapshot;
}

/** Individual permission row. */
function PermissionRow({
  def,
  status,
  canRequest,
  onRequest,
  onOpenSettings,
  isShell,
  shellEnabled,
  onToggleShell,
}: {
  def: PermissionDef;
  status: PermissionStatus;
  canRequest: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  isShell: boolean;
  shellEnabled: boolean;
  onToggleShell?: (enabled: boolean) => void;
}) {
  const { t } = useApp();
  const action = getPermissionAction(t, def.id, status, canRequest);

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 border-b border-[var(--border)] last:border-b-0">
      <PermissionIcon icon={def.icon} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[13px]">{def.name}</span>
          <StatusBadge
            label={PERMISSION_BADGE_LABELS[status].label}
            tone={PERMISSION_BADGE_LABELS[status].tone}
            withDot
            className="rounded-full font-semibold"
          />
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-0.5 truncate">
          {def.description}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {isShell && onToggleShell && status !== "not-applicable" && (
          <Switch
            checked={shellEnabled}
            onChange={onToggleShell}
            title={
              shellEnabled ? "Disable shell access" : "Enable shell access"
            }
            trackOnClass="bg-[var(--accent)]"
            trackOffClass="bg-[var(--border)]"
          />
        )}
        {!isShell && action && (
          <Button
            variant="default"
            size="sm"
            className="h-auto text-[11px] py-1 px-2.5"
            onClick={action.type === "request" ? onRequest : onOpenSettings}
            aria-label={`${action.ariaLabelPrefix} ${def.name}`}
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Capability toggle button. */
function CapabilityToggle({
  cap,
  plugin,
  permissionsGranted,
  onToggle,
}: {
  cap: CapabilityDef;
  plugin: PluginInfo | null;
  permissionsGranted: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const { t } = useApp();
  const enabled = plugin?.enabled ?? false;
  const available = plugin !== null;
  const canEnable = permissionsGranted && available;

  return (
    <div
      className={`flex items-center gap-3 p-3 border border-[var(--border)] ${
        enabled ? "bg-[var(--accent)]/10" : "bg-[var(--card)]"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[13px]">{cap.label}</span>
          {!permissionsGranted && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--warning)]/20 text-[var(--warning)]">
              {t("permissionssection.MissingPermissions")}
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-0.5">
          {cap.description}
        </div>
      </div>
      <Switch
        checked={enabled}
        onChange={onToggle}
        disabled={!canEnable}
        disabledClassName="opacity-50 cursor-not-allowed"
        trackOnClass="bg-[var(--accent)]"
        trackOffClass="bg-[var(--border)]"
        title={
          !available
            ? "Plugin not available"
            : !permissionsGranted
              ? "Grant required permissions first"
              : enabled
                ? "Disable"
                : "Enable"
        }
      />
    </div>
  );
}

interface DesktopPermissionsSnapshot {
  permissions: AllPermissionsState;
  platform: string;
  shellEnabled: boolean;
}

function useDesktopPermissionsState() {
  const [permissions, setPermissions] = useState<AllPermissionsState | null>(
    null,
  );
  const [platform, setPlatform] = useState<string>("unknown");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shellEnabled, setShellEnabled] = useState(true);

  const applySnapshot = useCallback((snapshot: DesktopPermissionsSnapshot) => {
    setPermissions(snapshot.permissions);
    setPlatform(snapshot.platform);
    setShellEnabled(snapshot.shellEnabled);
  }, []);

  const loadPermissionsSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const [bridgedPermissions, bridgedShellEnabled, bridgedPlatform] =
        await Promise.all([
          invokeDesktopBridgeRequest<AllPermissionsState>({
            rpcMethod: "permissionsGetAll",
            ipcChannel: "permissions:getAll",
            params: forceRefresh ? { forceRefresh: true } : undefined,
          }),
          invokeDesktopBridgeRequest<boolean>({
            rpcMethod: "permissionsIsShellEnabled",
            ipcChannel: "permissions:isShellEnabled",
          }),
          invokeDesktopBridgeRequest<string>({
            rpcMethod: "permissionsGetPlatform",
            ipcChannel: "permissions:getPlatform",
          }),
        ]);

      if (forceRefresh && bridgedPermissions === null) {
        await client.refreshPermissions();
      }

      const permissions = bridgedPermissions ?? (await client.getPermissions());
      const shellEnabled =
        bridgedShellEnabled === null
          ? await client.isShellEnabled()
          : bridgedShellEnabled;

      const snapshot = {
        permissions,
        platform: bridgedPlatform ?? "unknown",
        shellEnabled,
      };
      return reconcileRendererMediaPermissions(snapshot);
    },
    [],
  );

  const replaceSnapshot = useCallback(
    async (forceRefresh = false): Promise<DesktopPermissionsSnapshot> => {
      const snapshot = await loadPermissionsSnapshot(forceRefresh);
      applySnapshot(snapshot);
      return snapshot;
    },
    [applySnapshot, loadPermissionsSnapshot],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const snapshot = await loadPermissionsSnapshot();
        if (!cancelled) {
          applySnapshot(snapshot);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load permissions:", err);
          setPermissions(null);
          setPlatform("unknown");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot, loadPermissionsSnapshot]);

  useEffect(() => {
    return subscribeDesktopBridgeEvent({
      rpcMessage: "permissionsChanged",
      ipcChannel: "permissions:changed",
      listener: () => {
        void replaceSnapshot(true);
      },
    });
  }, [replaceSnapshot]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void replaceSnapshot(true);
    };

    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);
    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
    };
  }, [replaceSnapshot]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await replaceSnapshot(true);
    } catch (err) {
      console.error("Failed to refresh permissions:", err);
    } finally {
      setRefreshing(false);
    }
  }, [replaceSnapshot]);

  const handleRequest = useCallback(
    async (id: SystemPermissionId) => {
      try {
        if (isDesktopMediaPermission(id)) {
          const rendererStatus = await requestRendererMediaPermission(id);
          if (rendererStatus === "granted") {
            await replaceSnapshot(true);
            return;
          }
        }

        const bridged = await invokeDesktopBridgeRequest<PermissionState>({
          rpcMethod: "permissionsRequest",
          ipcChannel: "permissions:request",
          params: { id },
        });
        if (bridged === null) {
          await client.requestPermission(id);
        }
        await replaceSnapshot(true);
      } catch (err) {
        console.error("Failed to request permission:", err);
      }
    },
    [replaceSnapshot],
  );

  const handleOpenSettings = useCallback(
    async (id: SystemPermissionId) => {
      try {
        const opened = await invokeDesktopBridgeRequest({
          rpcMethod: "permissionsOpenSettings",
          ipcChannel: "permissions:openSettings",
          params: { id },
        });
        if (opened === null) {
          await client.openPermissionSettings(id);
        }
        await replaceSnapshot(true);
      } catch (err) {
        console.error("Failed to open settings:", err);
      }
    },
    [replaceSnapshot],
  );

  const handleToggleShell = useCallback(
    async (enabled: boolean) => {
      try {
        const bridgeToggle = invokeDesktopBridgeRequest<PermissionState>({
          rpcMethod: "permissionsSetShellEnabled",
          ipcChannel: "permissions:setShellEnabled",
          params: { enabled },
        });
        await Promise.allSettled([
          bridgeToggle,
          client.setShellEnabled(enabled),
        ]);
        await replaceSnapshot(true);
      } catch (err) {
        console.error("Failed to toggle shell:", err);
      }
    },
    [replaceSnapshot],
  );

  return {
    handleOpenSettings,
    handleRefresh,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
    refreshing,
    shellEnabled,
  };
}

/** Mobile (Capacitor) permission UI for streaming to cloud sandbox. */
function MobilePermissionsView() {
  const { t } = useApp();
  return (
    <StreamingPermissionsSettingsView
      mode="mobile"
      testId="mobile-permissions"
      title={translateWithFallback(
        t,
        "permissionssection.StreamingPermissions",
        "Streaming Permissions",
      )}
      description={translateWithFallback(
        t,
        "permissionssection.MobileStreamingDesc",
        "Your device streams camera, microphone, and screen to your Eliza Cloud agent for processing.",
      )}
    />
  );
}

/** Web browser permission UI — uses getUserMedia. */
function WebPermissionsView() {
  const { t } = useApp();
  return (
    <StreamingPermissionsSettingsView
      mode="web"
      testId="web-permissions-info"
      title={translateWithFallback(
        t,
        "permissionssection.BrowserPermissions",
        "Browser Permissions",
      )}
      description={translateWithFallback(
        t,
        "permissionssection.WebStreamingDesc",
        "Grant browser access to your camera, microphone, and screen to stream to your agent.",
      )}
    />
  );
}

function DesktopPermissionsView() {
  const { t } = useApp();
  const { plugins, handlePluginToggle } = useApp();
  const {
    handleOpenSettings,
    handleRefresh,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
    refreshing,
    shellEnabled,
  } = useDesktopPermissionsState();

  /** Check if all required permissions for a capability are granted. */
  const arePermissionsGranted = useCallback(
    (requiredPerms: SystemPermissionId[]): boolean => {
      if (!permissions) return false;
      return requiredPerms.every((id) => {
        const state = permissions[id];
        return (
          state?.status === "granted" || state?.status === "not-applicable"
        );
      });
    },
    [permissions],
  );

  /** Filter permissions applicable to current platform. */
  const applicablePermissions = SYSTEM_PERMISSIONS.filter((def) => {
    if (!permissions) return true;
    const state = permissions[def.id];
    return state?.status !== "not-applicable";
  });

  if (loading) {
    return (
      <div className="text-center py-6 text-[var(--muted)] text-xs">
        {translateWithFallback(
          t,
          "permissionssection.LoadingPermissions",
          "Loading permissions...",
        )}
      </div>
    );
  }

  if (!permissions) {
    return (
      <div className="text-center py-6 text-[var(--muted)] text-xs">
        {translateWithFallback(
          t,
          "permissionssection.UnableToLoadPermi",
          "Unable to load permissions.",
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* System Permissions */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <div className="font-bold text-sm">
            {translateWithFallback(
              t,
              "permissionssection.SystemPermissions",
              "System Permissions",
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="default"
              size="sm"
              className="h-auto text-[11px] py-1 px-2.5"
              onClick={async () => {
                for (const def of applicablePermissions) {
                  if (def.id === "shell") continue;
                  const state = permissions[def.id];
                  if (state?.status === "granted") continue;
                  if (state?.canRequest) {
                    await handleRequest(def.id);
                  } else {
                    await handleOpenSettings(def.id);
                  }
                }
              }}
            >
              {translateWithFallback(
                t,
                "permissionssection.AllowAll",
                "Allow All",
              )}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-auto text-[11px] py-1 px-2.5"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>
        <div className="border border-[var(--border)] bg-[var(--card)]">
          {applicablePermissions.map((def) => {
            const state = permissions[def.id];
            return (
              <PermissionRow
                key={def.id}
                def={def}
                status={state?.status ?? "not-determined"}
                canRequest={state?.canRequest ?? false}
                onRequest={() => handleRequest(def.id)}
                onOpenSettings={() => handleOpenSettings(def.id)}
                isShell={def.id === "shell"}
                shellEnabled={shellEnabled}
                onToggleShell={
                  def.id === "shell" ? handleToggleShell : undefined
                }
              />
            );
          })}
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-2">
          {platform === "darwin" ? (
            <>
              macOS requires Accessibility permission for computer control. Open
              System Settings → Privacy &amp; Security to grant access.
            </>
          ) : (
            <>
              Grant permissions to enable features like voice input and computer
              control.
            </>
          )}
        </div>
      </div>

      {/* Capability Toggles */}
      <div>
        <div className="font-bold text-sm mb-3">
          {t("appsview.Capabilities")}
        </div>
        <div className="space-y-2">
          {CAPABILITIES.map((cap) => {
            const plugin = plugins.find((p) => p.id === cap.id) ?? null;
            const permissionsGranted = arePermissionsGranted(
              cap.requiredPermissions,
            );
            return (
              <CapabilityToggle
                key={cap.id}
                cap={cap}
                plugin={plugin}
                permissionsGranted={permissionsGranted}
                onToggle={(enabled) => {
                  if (plugin) void handlePluginToggle(cap.id, enabled);
                }}
              />
            );
          })}
        </div>
        <div className="text-[11px] text-[var(--muted)] mt-2">
          {translateWithFallback(
            t,
            "permissionssection.CapabilitiesRequire",
            "Capabilities require the system permissions listed above.",
          )}
        </div>
      </div>
    </div>
  );
}

export function PermissionsSection() {
  if (isWebPlatform()) {
    return <WebPermissionsView />;
  }

  if (isNative && !isDesktopPlatform()) {
    return <MobilePermissionsView />;
  }

  return <DesktopPermissionsView />;
}

/**
 * PermissionsOnboardingSection — Simplified view for onboarding wizard.
 *
 * Shows only essential permissions with clear CTAs.
 */
/** Onboarding section for mobile — streaming permissions to cloud sandbox. */
function MobileOnboardingPermissions({
  onContinue,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
}) {
  const { t } = useApp();
  return (
    <StreamingPermissionsOnboardingView
      mode="mobile"
      onContinue={onContinue}
      testId="mobile-onboarding-permissions"
      title={translateWithFallback(
        t,
        "permissionssection.StreamingPermissions",
        "Streaming Permissions",
      )}
      description={translateWithFallback(
        t,
        "permissionssection.MobileOnboardingDesc",
        "Allow access so your device can stream to your cloud agent.",
      )}
    />
  );
}

/** Web onboarding — browser media permissions. */
function WebOnboardingPermissions({
  onContinue,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
}) {
  const { t } = useApp();
  return (
    <StreamingPermissionsOnboardingView
      mode="web"
      onContinue={onContinue}
      testId="web-onboarding-permissions"
      title={translateWithFallback(
        t,
        "permissionssection.BrowserPermissions",
        "Browser Permissions",
      )}
      description={translateWithFallback(
        t,
        "permissionssection.WebOnboardingDesc",
        "Allow browser access so your camera, mic, and screen can stream to your agent.",
      )}
    />
  );
}

export function PermissionsOnboardingSection({
  onContinue,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
}) {
  // Web: no permissions needed
  if (isWebPlatform()) {
    return <WebOnboardingPermissions onContinue={onContinue} />;
  }

  // Mobile (Capacitor): streaming permissions
  if (isNative && !isDesktopPlatform()) {
    return <MobileOnboardingPermissions onContinue={onContinue} />;
  }

  // Desktop shell: existing permission flow
  return <DesktopOnboardingPermissions onContinue={onContinue} />;
}

function DesktopOnboardingPermissions({
  onContinue,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
}) {
  const { t } = useApp();
  const { handleOpenSettings, handleRequest, loading, permissions } =
    useDesktopPermissionsState();

  /** Check if all critical permissions are granted (or not applicable). */
  const allGranted = hasRequiredOnboardingPermissions(permissions);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-[var(--muted)] text-sm">
          {translateWithFallback(
            t,
            "permissionssection.CheckingPermissions",
            "Checking permissions...",
          )}
        </div>
      </div>
    );
  }

  if (!permissions) {
    return (
      <div className="text-center py-8">
        <div className="text-[var(--muted)] text-sm mb-4">
          {translateWithFallback(
            t,
            "permissionssection.UnableToCheckPerm",
            "Unable to check permissions.",
          )}
        </div>
        <Button
          variant="default"
          onClick={() => onContinue({ allowPermissionBypass: true })}
        >
          {translateWithFallback(t, "permissionssection.Continue", "Continue")}
        </Button>
      </div>
    );
  }

  const essentialPermissions = SYSTEM_PERMISSIONS.filter((def) => {
    const state = permissions[def.id];
    return state?.status !== "not-applicable" && def.id !== "shell";
  });

  return (
    <div>
      <div className="text-center mb-6">
        <div className="text-xl font-bold mb-2">
          {translateWithFallback(
            t,
            "permissionssection.SystemPermissions",
            "System Permissions",
          )}
        </div>
        <div className="text-[var(--muted)] text-sm">
          {translateWithFallback(
            t,
            "permissionssection.GrantPermissionsTo",
            "Grant permissions to unlock desktop features.",
          )}
        </div>
      </div>

      <div className="space-y-3 mb-6">
        {essentialPermissions.map((def) => {
          const state = permissions[def.id];
          const status = state?.status ?? "not-determined";
          const isGranted = status === "granted";
          const action = getPermissionAction(
            t,
            def.id,
            status,
            state?.canRequest ?? false,
          );

          return (
            <div
              key={def.id}
              data-permission-id={def.id}
              className={`flex items-center gap-4 p-4 border ${
                isGranted
                  ? "border-[var(--ok)] bg-[var(--ok)]/10"
                  : "border-[var(--border)] bg-[var(--card)]"
              }`}
            >
              <PermissionIcon icon={def.icon} />
              <div className="flex-1">
                <div className="font-semibold text-sm">{def.name}</div>
                <div className="text-[11px] text-[var(--muted)]">
                  {def.description}
                </div>
              </div>
              {isGranted ? (
                <Check className="w-4 h-4 text-[var(--ok)]" />
              ) : action ? (
                <Button
                  variant="default"
                  size="sm"
                  className="h-auto text-xs py-1.5 px-3"
                  onClick={() =>
                    action.type === "request"
                      ? handleRequest(def.id)
                      : handleOpenSettings(def.id)
                  }
                  aria-label={`${action.ariaLabelPrefix} ${def.name}`}
                >
                  {action.label}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      {!allGranted && (
        <div className="flex justify-center mb-4">
          <Button
            variant="default"
            size="sm"
            className="h-auto text-xs py-2 px-6 w-full max-w-xs bg-accent border-accent text-accent-foreground"
            onClick={async () => {
              for (const def of essentialPermissions) {
                const state = permissions[def.id];
                if (state?.status === "granted") continue;
                if (state?.status === "not-determined" && state.canRequest) {
                  await handleRequest(def.id);
                  continue;
                }
                await handleOpenSettings(def.id);
              }
            }}
          >
            {translateWithFallback(
              t,
              "permissionssection.AllowAllPermission",
              "Allow All Permissions",
            )}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap justify-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-auto min-w-[8.5rem] px-4 py-2 text-[11px] leading-tight opacity-70"
          onClick={() => onContinue({ allowPermissionBypass: true })}
        >
          {translateWithFallback(
            t,
            "permissionssection.SkipForNow",
            "Skip for Now",
          )}
        </Button>
        {allGranted && (
          <Button
            variant="default"
            size="sm"
            className="h-auto min-w-[8.5rem] bg-accent border-accent px-4 py-2 text-[11px] leading-tight text-accent-foreground"
            onClick={() => onContinue()}
          >
            {translateWithFallback(
              t,
              "permissionssection.Continue",
              "Continue",
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
