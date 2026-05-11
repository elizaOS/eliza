import { Button } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PermissionId } from "../../api";
import {
  getMobileSignalsPlugin,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSetupAction,
} from "../../bridge/native-plugins";
import { useBootConfig } from "../../config/boot-config-react";
import { isDesktopPlatform, isNative, isWebPlatform } from "../../platform";
import { useApp } from "../../state";
import { StreamingPermissionsSettingsView } from "../permissions/StreamingPermissions";
import {
  CapabilityToggle,
  PermissionRow,
  useDesktopPermissionsState,
} from "./permission-controls";
import { CAPABILITIES, SYSTEM_PERMISSIONS } from "./permission-types";

type WebsiteBlockerSettingsCardComponent = NonNullable<
  ReturnType<typeof useBootConfig>["websiteBlockerSettingsCard"]
>;

/* ── Platform copy keys ─────────────────────────────────────────── */
//
// Each platform has its own description / note string. Encoding them as a
// map removes the chains of nested ternaries that used to repeat across
// the file.

type DesktopPlatform = "darwin" | "win32" | "linux";

interface PlatformCopy {
  systemDescription: { key: string; defaultValue: string };
  grantNote: { key: string; defaultValue: string };
}

const PLATFORM_COPY: Record<DesktopPlatform, PlatformCopy> = {
  darwin: {
    systemDescription: {
      key: "permissionssection.MacSystemPermissionsDescription",
      defaultValue:
        "Review the native permissions the app needs for desktop control, voice input, and visual analysis. macOS changes may require opening System Settings.",
    },
    grantNote: {
      key: "permissionssection.MacGrantAccessNote",
      defaultValue:
        "macOS requires Accessibility permission for computer control. Open System Settings → Privacy & Security to grant access.",
    },
  },
  win32: {
    systemDescription: {
      key: "permissionssection.WindowsSystemPermissionsDescription",
      defaultValue:
        "Open Windows privacy settings for microphone and camera, then verify access by using those features in the app.",
    },
    grantNote: {
      key: "permissionssection.WindowsGrantPermissionsNote",
      defaultValue:
        "Windows may not list the app as a named app here. Use Privacy settings to enable microphone and camera access, then test them in the app.",
    },
  },
  linux: {
    systemDescription: {
      key: "permissionssection.SystemPermissionsDescription",
      defaultValue:
        "Grant the runtime access it needs for voice input, camera capture, shell tasks, and desktop automation features.",
    },
    grantNote: {
      key: "permissionssection.GrantPermissionsNote",
      defaultValue:
        "Grant permissions to enable features like voice input and computer control.",
    },
  },
};

function platformCopy(platform: string | null | undefined): PlatformCopy {
  if (platform === "darwin") return PLATFORM_COPY.darwin;
  if (platform === "win32") return PLATFORM_COPY.win32;
  return PLATFORM_COPY.linux;
}

/* ── Streaming permission views (mobile / web) ──────────────────── */

function MobilePermissionsView() {
  const { t } = useApp();
  const {
    appBlockerSettingsCard: AppBlockerSettingsCard,
    websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
  } = useBootConfig();
  return (
    <div className="space-y-6">
      <StreamingPermissionsSettingsView
        mode="mobile"
        testId="mobile-permissions"
        title={t("permissionssection.StreamingPermissions", {
          defaultValue: "Streaming Permissions",
        })}
        description={t("permissionssection.MobileStreamingDesc", {
          defaultValue:
            "Your device streams camera, microphone, and screen to your Eliza Cloud agent for processing.",
        })}
      />
      <MobileSignalsPermissionsPanel />
      {AppBlockerSettingsCard ? <AppBlockerSettingsCard mode="mobile" /> : null}
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="mobile" />
      ) : null}
    </div>
  );
}

function mobileSetupActionTarget(action: MobileSignalsSetupAction) {
  if (action.settingsTarget) return action.settingsTarget;
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screenTime";
  if (action.id === "android_usage_access") return "usageAccess";
  if (action.id === "notification_settings") return "notification";
  if (action.id === "battery_optimization") return "batteryOptimization";
  if (action.id === "local_network") return "localNetwork";
  return "app";
}

function mobileSetupRequestTarget(action: MobileSignalsSetupAction) {
  if (action.id === "health_permissions") return "health";
  if (action.id === "screen_time_authorization") return "screenTime";
  if (action.id === "notification_settings") return "notifications";
  return "all";
}

function mobileSetupActionBadge(action: MobileSignalsSetupAction) {
  if (action.status === "ready") {
    return { label: "Ready", className: "border-success/30 text-success" };
  }
  if (action.status === "unavailable") {
    return { label: "Unavailable", className: "border-border/50 text-muted" };
  }
  return { label: "Needs action", className: "border-warn/30 text-warn" };
}

function MobileSignalsPermissionsPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<MobileSignalsPermissionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const plugin = getMobileSignalsPlugin();
    if (typeof plugin.checkPermissions !== "function") {
      setStatus(null);
      return;
    }
    setStatus(await plugin.checkPermissions());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const plugin = getMobileSignalsPlugin();
        if (typeof plugin.checkPermissions !== "function") {
          if (!cancelled) setStatus(null);
          return;
        }
        const next = await plugin.checkPermissions();
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAction = useCallback(
    async (action: MobileSignalsSetupAction) => {
      const plugin = getMobileSignalsPlugin();
      setBusyAction(action.id);
      try {
        if (
          action.canRequest &&
          (action.id === "health_permissions" ||
            action.id === "screen_time_authorization" ||
            action.id === "notification_settings") &&
          typeof plugin.requestPermissions === "function"
        ) {
          await plugin.requestPermissions({
            target: mobileSetupRequestTarget(action),
          });
        } else if (
          action.canOpenSettings &&
          typeof plugin.openSettings === "function"
        ) {
          await plugin.openSettings({
            target: mobileSetupActionTarget(action),
          });
        }
        await refresh();
      } finally {
        setBusyAction(null);
      }
    },
    [refresh],
  );

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  if (!status) {
    return null;
  }

  return (
    <section className="space-y-2">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-txt">
            {t("permissionssection.LifeOpsSignals", {
              defaultValue: "LifeOps Signals",
            })}
          </h3>
          <p className="max-w-2xl text-xs-tight leading-5 text-muted">
            {t("permissionssection.MobileSignalsDesc", {
              defaultValue:
                "Review Health, sleep, Screen Time, notification, and device signal access used by LifeOps.",
            })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-lg px-3 text-xs font-semibold"
          onClick={refresh}
        >
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      </header>
      <div className="divide-y divide-border/40 rounded-lg border border-border/40">
        {status.setupActions.map((action) => {
          const badge = mobileSetupActionBadge(action);
          const canAct =
            action.status !== "ready" &&
            (action.canRequest || action.canOpenSettings);
          return (
            <div
              key={action.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm text-txt">
                    {action.label}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-2xs font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
                {action.reason ? (
                  <div className="mt-1 text-xs-tight leading-5 text-muted">
                    {action.reason}
                  </div>
                ) : null}
              </div>
              {canAct ? (
                <Button
                  variant="default"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                  disabled={busyAction === action.id}
                  onClick={() => void handleAction(action)}
                >
                  {busyAction === action.id
                    ? t("common.loading", { defaultValue: "Loading..." })
                    : action.canRequest
                      ? t("permissionssection.Grant", {
                          defaultValue: "Grant",
                        })
                      : t("permissionssection.OpenSettings", {
                          defaultValue: "Open Settings",
                        })}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WebPermissionsView() {
  const { t } = useApp();
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  return (
    <div className="space-y-6">
      <StreamingPermissionsSettingsView
        mode="web"
        testId="web-permissions-info"
        title={t("permissionssection.BrowserPermissions", {
          defaultValue: "Browser Permissions",
        })}
        description={t("permissionssection.WebStreamingDesc", {
          defaultValue:
            "Grant browser access to your camera, microphone, and screen to stream to your agent.",
        })}
      />
      {WebsiteBlockerSettingsCard ? (
        isLocalBrowserRuntime() ? (
          <LocalWebsiteBlockingCard
            WebsiteBlockerSettingsCard={WebsiteBlockerSettingsCard}
          />
        ) : (
          <WebsiteBlockerSettingsCard mode="web" />
        )
      ) : null}
    </div>
  );
}

function isLocalBrowserRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const hostname = window.location.hostname.toLowerCase();
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function LocalWebsiteBlockingCard({
  WebsiteBlockerSettingsCard,
}: {
  WebsiteBlockerSettingsCard: WebsiteBlockerSettingsCardComponent;
}) {
  const { handleOpenSettings, handleRequest, loading, permissions, platform } =
    useDesktopPermissionsState();

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        Loading website blocking...
      </p>
    );
  }

  if (!permissions) {
    return <WebsiteBlockerSettingsCard mode="web" />;
  }

  return (
    <WebsiteBlockerSettingsCard
      mode="desktop"
      permission={permissions["website-blocking"]}
      platform={platform}
      onRequestPermission={() => handleRequest("website-blocking")}
      onOpenPermissionSettings={() => handleOpenSettings("website-blocking")}
    />
  );
}

/* ── Desktop permission view ────────────────────────────────────── */

function DesktopPermissionsView() {
  const { t, plugins, handlePluginToggle } = useApp();
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
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

  const arePermissionsGranted = useCallback(
    (requiredPerms: PermissionId[]): boolean => {
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

  const applicablePermissions = useMemo(
    () =>
      SYSTEM_PERMISSIONS.filter((def) => {
        if (!permissions) return true;
        const state = permissions[def.id];
        return state?.status !== "not-applicable";
      }),
    [permissions],
  );

  if (loading) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  if (!permissions) {
    return (
      <p className="py-6 text-center text-xs text-muted">
        {t("permissionssection.UnableToLoadPermi", {
          defaultValue: "Unable to load permissions.",
        })}
      </p>
    );
  }

  const copy = platformCopy(platform);

  return (
    <div className="space-y-6">
      {/* System Permissions */}
      <section className="space-y-2">
        <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold text-txt">
              {t("permissionssection.SystemPermissions", {
                defaultValue: "System Permissions",
              })}
            </h3>
            <p className="max-w-2xl text-xs-tight leading-5 text-muted">
              {t(copy.systemDescription.key, {
                defaultValue: copy.systemDescription.defaultValue,
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              data-testid="permissions-refresh-button"
              className="h-9 rounded-lg px-3 text-xs font-semibold"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing
                ? t("common.refreshing", {
                    defaultValue: "Refreshing...",
                  })
                : t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
          </div>
        </header>

        <div className="divide-y divide-border/40 rounded-lg border border-border/40">
          {applicablePermissions.map((def) => {
            const state = permissions[def.id];
            return (
              <PermissionRow
                key={def.id}
                def={def}
                status={state?.status ?? "not-determined"}
                reason={state?.reason}
                platform={platform}
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
        <p className="text-xs-tight leading-5 text-muted">
          {t(copy.grantNote.key, { defaultValue: copy.grantNote.defaultValue })}
        </p>
      </section>

      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard
          mode="desktop"
          permission={permissions["website-blocking"]}
          platform={platform}
          onRequestPermission={() => handleRequest("website-blocking")}
          onOpenPermissionSettings={() =>
            handleOpenSettings("website-blocking")
          }
        />
      ) : null}

      {/* Capability Toggles */}
      <section className="space-y-2 border-t border-border/40 pt-5">
        <header className="space-y-0.5">
          <h3 className="text-sm font-semibold text-txt">
            {t("common.capabilities")}
          </h3>
          <p className="max-w-2xl text-xs-tight leading-5 text-muted">
            {t("permissionssection.CapabilitiesDescription", {
              defaultValue:
                "Turn higher-level capabilities on only after the required runtime permissions are available.",
            })}
          </p>
        </header>
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
      </section>
    </div>
  );
}

export function PermissionsSection() {
  if (isWebPlatform()) return <WebPermissionsView />;
  if (isNative && !isDesktopPlatform()) return <MobilePermissionsView />;
  return <DesktopPermissionsView />;
}
