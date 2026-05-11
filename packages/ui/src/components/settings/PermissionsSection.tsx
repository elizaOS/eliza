import { Button } from "@elizaos/ui";
import { useCallback, useMemo } from "react";
import type { PermissionId } from "../../api";
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
      {AppBlockerSettingsCard ? <AppBlockerSettingsCard mode="mobile" /> : null}
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="mobile" />
      ) : null}
    </div>
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
              variant="default"
              size="sm"
              className="h-9 rounded-lg px-3 text-xs font-semibold"
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
              {t("permissionssection.AllowAll", { defaultValue: "Allow All" })}
            </Button>
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
