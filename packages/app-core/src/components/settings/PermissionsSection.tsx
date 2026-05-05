import { Button } from "@elizaos/ui";
import { Check } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { SystemPermissionId } from "../../api";
import { useBootConfig } from "../../config/boot-config-react";
import {
  hasRequiredOnboardingPermissions,
  isDesktopPlatform,
  isNative,
  isWebPlatform,
} from "../../platform";
import { useApp } from "../../state";
import { PermissionIcon } from "../permissions/PermissionIcon";
import {
  StreamingPermissionsOnboardingView,
  StreamingPermissionsSettingsView,
} from "../permissions/StreamingPermissions";
import {
  CapabilityToggle,
  PermissionRow,
  useDesktopPermissionsState,
} from "./permission-controls";
import {
  CAPABILITIES,
  getPermissionAction,
  SYSTEM_PERMISSIONS,
} from "./permission-types";

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
  permissionReady: { key: string; defaultValue: string };
  grantSubNote: { key: string; defaultValue: string };
  onboardingIntro: { key: string; defaultValue: string };
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
    permissionReady: {
      key: "permissionssection.PermissionReadyNote",
      defaultValue:
        "All required permissions are ready. Continue when you're ready.",
    },
    grantSubNote: {
      key: "permissionssection.PermissionGrantNote",
      defaultValue:
        "Granting now will request what can be approved immediately and open Settings for anything that must be enabled there.",
    },
    onboardingIntro: {
      key: "permissionssection.GrantPermissionsTo",
      defaultValue: "Grant permissions to unlock desktop features.",
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
    permissionReady: {
      key: "permissionssection.WindowsPermissionReadyNote",
      defaultValue:
        "Windows privacy settings are advisory here. Continue, then verify microphone and camera directly in the app.",
    },
    grantSubNote: {
      key: "permissionssection.WindowsPermissionGrantNote",
      defaultValue:
        "This opens Windows privacy settings for microphone and camera. The app may not appear as a named app there; the real check is whether capture works back in the app.",
    },
    onboardingIntro: {
      key: "permissionssection.WindowsGrantPermissionsTo",
      defaultValue:
        "Open Windows privacy settings to prepare microphone and camera access for desktop features.",
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
    permissionReady: {
      key: "permissionssection.PermissionReadyNote",
      defaultValue:
        "All required permissions are ready. Continue when you're ready.",
    },
    grantSubNote: {
      key: "permissionssection.PermissionGrantNote",
      defaultValue:
        "Granting now will request what can be approved immediately and open Settings for anything that must be enabled there.",
    },
    onboardingIntro: {
      key: "permissionssection.GrantPermissionsTo",
      defaultValue: "Grant permissions to unlock desktop features.",
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

/* ── Onboarding permission views ────────────────────────────────── */

function MobileOnboardingPermissions({
  onContinue,
  onBack,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
}) {
  const { t } = useApp();
  return (
    <StreamingPermissionsOnboardingView
      mode="mobile"
      onContinue={onContinue}
      onBack={onBack}
      testId="mobile-onboarding-permissions"
      title={t("permissionssection.StreamingPermissions", {
        defaultValue: "Streaming Permissions",
      })}
      description={t("permissionssection.MobileOnboardingDesc", {
        defaultValue:
          "Allow access so your device can stream to your cloud agent.",
      })}
    />
  );
}

function WebOnboardingPermissions({
  onContinue,
  onBack,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
}) {
  const { t } = useApp();
  return (
    <StreamingPermissionsOnboardingView
      mode="web"
      onContinue={onContinue}
      onBack={onBack}
      testId="web-onboarding-permissions"
      title={t("permissionssection.BrowserPermissions", {
        defaultValue: "Browser Permissions",
      })}
      description={t("permissionssection.WebOnboardingDesc", {
        defaultValue:
          "Allow browser access so your camera, mic, and screen can stream to your agent.",
      })}
    />
  );
}

export function PermissionsOnboardingSection({
  onContinue,
  onBack,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
}) {
  if (isWebPlatform()) {
    return <WebOnboardingPermissions onContinue={onContinue} onBack={onBack} />;
  }
  if (isNative && !isDesktopPlatform()) {
    return (
      <MobileOnboardingPermissions onContinue={onContinue} onBack={onBack} />
    );
  }
  return (
    <DesktopOnboardingPermissions onContinue={onContinue} onBack={onBack} />
  );
}

function DesktopOnboardingPermissions({
  onContinue,
  onBack,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
}) {
  const { t } = useApp();
  const {
    handleOpenSettings,
    handleRequest,
    handleRefresh,
    loading,
    permissions,
    platform,
  } = useDesktopPermissionsState();
  const [grantingPermissions, setGrantingPermissions] = useState(false);
  const usesWindowsPrivacyFlow = platform === "win32";
  const copy = platformCopy(platform);

  const allGranted = hasRequiredOnboardingPermissions(permissions);
  const canProceed = allGranted || usesWindowsPrivacyFlow;
  const essentialPermissions = SYSTEM_PERMISSIONS.filter((def) => {
    const state = permissions?.[def.id];
    return state?.status !== "not-applicable" && def.id !== "shell";
  });
  const footerStatusMessage = canProceed
    ? t(copy.permissionReady.key, {
        defaultValue: copy.permissionReady.defaultValue,
      })
    : t("permissionssection.PermissionSkipNote", {
        defaultValue:
          "Skipping keeps desktop features locked until you grant the missing permissions in Settings.",
      });

  const handleGrantPermissions = useCallback(async () => {
    if (grantingPermissions) return;
    setGrantingPermissions(true);
    try {
      for (const def of essentialPermissions) {
        const state = permissions?.[def.id];
        if (state?.status === "granted") continue;
        if (state?.status === "not-determined" && state.canRequest) {
          await handleRequest(def.id);
          continue;
        }
        await handleOpenSettings(def.id);
      }

      const refreshed = await handleRefresh();
      if (
        refreshed &&
        (usesWindowsPrivacyFlow ||
          hasRequiredOnboardingPermissions(refreshed.permissions))
      ) {
        onContinue();
      }
    } finally {
      setGrantingPermissions(false);
    }
  }, [
    grantingPermissions,
    essentialPermissions,
    handleOpenSettings,
    handleRefresh,
    handleRequest,
    onContinue,
    permissions,
    usesWindowsPrivacyFlow,
  ]);

  if (loading) {
    return (
      <p className="py-8 text-center text-sm text-muted">
        {t("permissionssection.CheckingPermissions", {
          defaultValue: "Checking permissions...",
        })}
      </p>
    );
  }

  if (!permissions) {
    return (
      <div className="py-8 text-center">
        <p className="mb-4 text-sm text-muted">
          {t("permissionssection.UnableToCheckPerm", {
            defaultValue: "Unable to check permissions.",
          })}
        </p>
        <Button
          type="button"
          variant="default"
          data-testid="permissions-onboarding-continue"
          onClick={() => onContinue()}
        >
          {t("common.continue", { defaultValue: "Continue" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="text-center">
        <h2 className="mb-1 text-xl font-bold text-txt">
          {t("permissionssection.SystemPermissions", {
            defaultValue: "System Permissions",
          })}
        </h2>
        <p className="text-sm text-muted">
          {t(copy.onboardingIntro.key, {
            defaultValue: copy.onboardingIntro.defaultValue,
          })}
        </p>
      </header>

      <div className="space-y-2">
        {essentialPermissions.map((def) => {
          const state = permissions[def.id];
          const status = state?.status ?? "not-determined";
          const isGranted = status === "granted";
          const action = getPermissionAction(
            t,
            def.id,
            status,
            state?.canRequest ?? false,
            platform,
          );

          return (
            <div
              key={def.id}
              data-permission-id={def.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                isGranted
                  ? "border-ok/30 bg-ok/5"
                  : "border-border/50 bg-card/60"
              }`}
            >
              <PermissionIcon icon={def.icon} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-txt">{def.name}</div>
                <div className="text-xs-tight leading-5 text-muted">
                  {def.description}
                </div>
              </div>
              {isGranted ? (
                <Check className="h-4 w-4 shrink-0 text-ok" />
              ) : action ? (
                <Button
                  variant="default"
                  size="sm"
                  className="h-9 rounded-lg px-3 text-xs font-semibold"
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

      <div className="space-y-3 border-t border-border/40 pt-4">
        <div className="space-y-1 text-xs-tight leading-5 text-muted">
          <p>{footerStatusMessage}</p>
          {!canProceed && (
            <p>
              {t(copy.grantSubNote.key, {
                defaultValue: copy.grantSubNote.defaultValue,
              })}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {onBack ? (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start p-0 text-2xs uppercase tracking-[0.15em] text-muted hover:text-txt"
              onClick={() => onBack()}
              type="button"
            >
              {t("onboarding.back", { defaultValue: "Back" })}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {!canProceed && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 rounded-lg px-4 text-xs font-semibold"
                disabled={grantingPermissions}
                onClick={() => onContinue({ allowPermissionBypass: true })}
              >
                {t("onboarding.rpcSkip", { defaultValue: "Skip for now" })}
              </Button>
            )}
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="permissions-onboarding-continue"
              className="h-10 min-w-[8.5rem] rounded-lg px-4 text-xs font-semibold"
              disabled={grantingPermissions}
              onClick={canProceed ? () => onContinue() : handleGrantPermissions}
            >
              {canProceed
                ? t("common.continue", { defaultValue: "Continue" })
                : grantingPermissions
                  ? t("permissionssection.GrantingPermissions", {
                      defaultValue: "Granting...",
                    })
                  : t("permissionssection.GrantPermissions", {
                      defaultValue: "Grant Permissions",
                    })}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
