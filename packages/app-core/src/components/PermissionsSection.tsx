/**
 * PermissionsSection — System permissions and capability toggles for Settings.
 *
 * Displays:
 *   - System permission statuses (accessibility, screen-recording, microphone, camera)
 *   - Shell access toggle (soft disable/enable)
 *   - Capability toggles (browser, computeruse, vision) that depend on permissions
 *
 * Works cross-platform with platform-specific permission requirements:
 *   - Electron (desktop): OS-level permission prompts and system settings links
 *   - Capacitor (mobile): Camera/mic/screen streaming permissions via native plugins
 *   - Web: Informational message only (no OS-level access)
 */

import { Button } from "@elizaos/ui";
import { Check } from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  type AllPermissionsState,
  client,
  type PermissionStatus,
  type PluginInfo,
  type SystemPermissionId,
} from "../api";
import { invokeDesktopBridgeRequest } from "../bridge";
import {
  hasRequiredOnboardingPermissions,
  isElectronPlatform,
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
  const showAction = status !== "granted" && status !== "not-applicable";

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
        {showAction && !isShell && (
          <>
            {canRequest && (
              <Button
                variant="default"
                size="sm"
                className="h-auto text-[11px] py-1 px-2.5"
                onClick={onRequest}
              >
                {t("permissionssection.Request")}
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              className="h-auto text-[11px] py-1 px-2.5 ml-2"
              onClick={onOpenSettings}
            >
              {t("nav.settings")}
            </Button>
          </>
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

function usePermissionActions(
  setPermissions: Dispatch<SetStateAction<AllPermissionsState | null>>,
) {
  const handleRequest = useCallback(
    async (id: SystemPermissionId) => {
      try {
        const state = await client.requestPermission(id);
        setPermissions((prev) => (prev ? { ...prev, [id]: state } : prev));
      } catch (err) {
        console.error("Failed to request permission:", err);
      }
    },
    [setPermissions],
  );

  const handleOpenSettings = useCallback(async (id: SystemPermissionId) => {
    try {
      // The REST endpoint only returns an action code; desktop runtimes need the
      // native bridge to actually open system settings.
      const opened = await invokeDesktopBridgeRequest({
        rpcMethod: "permissionsOpenSettings",
        ipcChannel: "permissions:openSettings",
        params: { id },
      });
      if (opened === null) {
        await client.openPermissionSettings(id);
      }
    } catch (err) {
      console.error("Failed to open settings:", err);
    }
  }, []);

  return { handleRequest, handleOpenSettings };
}

/** Mobile (Capacitor) permission UI for streaming to cloud sandbox. */
function MobilePermissionsView() {
  const { t } = useApp();
  return (
    <StreamingPermissionsSettingsView
      mode="mobile"
      testId="mobile-permissions"
      title={
        t("permissionssection.StreamingPermissions") || "Streaming Permissions"
      }
      description={
        t("permissionssection.MobileStreamingDesc") ||
        "Your device streams camera, microphone, and screen to your Eliza Cloud agent for processing."
      }
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
      title={
        t("permissionssection.BrowserPermissions") || "Browser Permissions"
      }
      description={
        t("permissionssection.WebStreamingDesc") ||
        "Grant browser access to your camera, microphone, and screen to stream to your agent."
      }
    />
  );
}

export function PermissionsSection() {
  const { t } = useApp();
  const { plugins, handlePluginToggle } = useApp();
  const [permissions, setPermissions] = useState<AllPermissionsState | null>(
    null,
  );
  const [platform, setPlatform] = useState<string>("unknown");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [shellEnabled, setShellEnabled] = useState(true);
  const { handleRequest, handleOpenSettings } =
    usePermissionActions(setPermissions);

  // On web, show informational view immediately
  if (isWebPlatform()) {
    return <WebPermissionsView />;
  }

  // On mobile (Capacitor), show streaming permissions
  if (isNative && !isElectronPlatform()) {
    return <MobilePermissionsView />;
  }

  // Electron / desktop: existing permission flow

  /** Load permissions on mount. */
  // biome-ignore lint/correctness/useHookAtTopLevel: conditional early returns above are platform-gated and stable
  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [perms, isShell] = await Promise.all([
          client.getPermissions(),
          client.isShellEnabled(),
        ]);
        setPermissions(perms);
        setShellEnabled(isShell);
        // Detect platform from permissions (accessibility only on darwin)
        if (perms.accessibility?.status !== "not-applicable") {
          setPlatform("darwin");
        } else if (perms.microphone?.status !== "not-applicable") {
          setPlatform("win32"); // or linux, but we can't easily distinguish
        }
      } catch (err) {
        console.error("Failed to load permissions:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** Refresh permissions from OS. */
  // biome-ignore lint/correctness/useHookAtTopLevel: see above
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const perms = await client.refreshPermissions();
      setPermissions(perms);
    } catch (err) {
      console.error("Failed to refresh permissions:", err);
    } finally {
      setRefreshing(false);
    }
  }, []);

  /** Toggle shell access. */
  // biome-ignore lint/correctness/useHookAtTopLevel: see above
  const handleToggleShell = useCallback(async (enabled: boolean) => {
    try {
      const state = await client.setShellEnabled(enabled);
      setShellEnabled(enabled);
      setPermissions((prev) => (prev ? { ...prev, shell: state } : prev));
    } catch (err) {
      console.error("Failed to toggle shell:", err);
    }
  }, []);

  /** Check if all required permissions for a capability are granted. */
  // biome-ignore lint/correctness/useHookAtTopLevel: see above
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
        {t("permissionssection.LoadingPermissions")}
      </div>
    );
  }

  if (!permissions) {
    return (
      <div className="text-center py-6 text-[var(--muted)] text-xs">
        {t("permissionssection.UnableToLoadPermi")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* System Permissions */}
      <div>
        <div className="flex justify-between items-center mb-3">
          <div className="font-bold text-sm">
            {t("permissionssection.SystemPermissions")}
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
              {t("permissionssection.AllowAll")}
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
              System Preferences → Security & Privacy → Privacy to grant access.
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
          {t("permissionssection.CapabilitiesRequire")}
        </div>
      </div>
    </div>
  );
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
      title={
        t("permissionssection.StreamingPermissions") || "Streaming Permissions"
      }
      description={
        t("permissionssection.MobileOnboardingDesc") ||
        "Allow access so your device can stream to your cloud agent."
      }
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
      title={
        t("permissionssection.BrowserPermissions") || "Browser Permissions"
      }
      description={
        t("permissionssection.WebOnboardingDesc") ||
        "Allow browser access so your camera, mic, and screen can stream to your agent."
      }
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
  if (isNative && !isElectronPlatform()) {
    return <MobileOnboardingPermissions onContinue={onContinue} />;
  }

  // Electron / desktop: existing permission flow
  return <DesktopOnboardingPermissions onContinue={onContinue} />;
}

/** Desktop (Electron) onboarding permissions — original implementation. */
function DesktopOnboardingPermissions({
  onContinue,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
}) {
  const { t } = useApp();
  const [permissions, setPermissions] = useState<AllPermissionsState | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const { handleRequest, handleOpenSettings } =
    usePermissionActions(setPermissions);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const perms = await client.getPermissions();
        setPermissions(perms);
      } catch (err) {
        console.error("Failed to load permissions:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  /** Check if all critical permissions are granted (or not applicable). */
  const allGranted = hasRequiredOnboardingPermissions(permissions);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-[var(--muted)] text-sm">
          {t("permissionssection.CheckingPermissions")}
        </div>
      </div>
    );
  }

  if (!permissions) {
    return (
      <div className="text-center py-8">
        <div className="text-[var(--muted)] text-sm mb-4">
          {t("permissionssection.UnableToCheckPerm")}
        </div>
        <Button
          variant="default"
          onClick={() => onContinue({ allowPermissionBypass: true })}
        >
          {t("permissionssection.Continue")}
        </Button>
      </div>
    );
  }

  const essentialPermissions = SYSTEM_PERMISSIONS.filter((def) => {
    const state = permissions[def.id];
    // Show non-applicable permissions and shell toggle
    return state?.status !== "not-applicable" && def.id !== "shell";
  });

  return (
    <div>
      <div className="text-center mb-6">
        <div className="text-xl font-bold mb-2">
          {t("permissionssection.SystemPermissions")}
        </div>
        <div className="text-[var(--muted)] text-sm">
          {t("permissionssection.GrantPermissionsTo")}
        </div>
      </div>

      <div className="space-y-3 mb-6">
        {essentialPermissions.map((def) => {
          const state = permissions[def.id];
          const status = state?.status ?? "not-determined";
          const canRequest = state?.canRequest ?? false;
          const isGranted = status === "granted";

          return (
            <div
              key={def.id}
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
              ) : (
                <div className="flex gap-2">
                  {canRequest && (
                    <Button
                      variant="default"
                      size="sm"
                      className="h-auto text-xs py-1.5 px-3"
                      onClick={() => handleRequest(def.id)}
                    >
                      {t("permissionssection.Grant")}
                    </Button>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    className="h-auto text-xs py-1.5 px-3"
                    onClick={() => handleOpenSettings(def.id)}
                  >
                    {t("permissionssection.OpenSettings")}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Allow All shortcut */}
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
                if (state?.canRequest) {
                  await handleRequest(def.id);
                } else {
                  await handleOpenSettings(def.id);
                }
              }
            }}
          >
            {t("permissionssection.AllowAllPermission")}
          </Button>
        </div>
      )}

      <div className="flex justify-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="h-auto text-xs py-2 px-6 opacity-70"
          onClick={() => onContinue({ allowPermissionBypass: true })}
        >
          {t("permissionssection.SkipForNow")}
        </Button>
        {allGranted && (
          <Button
            variant="default"
            size="sm"
            className="h-auto text-xs py-2 px-6 bg-accent border-accent text-accent-foreground"
            onClick={() => onContinue()}
          >
            {t("permissionssection.Continue")}
          </Button>
        )}
      </div>
    </div>
  );
}
