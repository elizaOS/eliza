import { Button } from "@elizaos/ui";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";
import type { SystemPermissionId } from "../../api";
import { useBootConfig } from "../../config";
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
  translateWithFallback,
} from "./permission-types";

/** Mobile (Capacitor) permission UI for streaming to cloud sandbox. */
function MobilePermissionsView() {
  const { t } = useApp();
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  return (
    <div className="space-y-6">
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
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="mobile" />
      ) : null}
    </div>
  );
}

/** Web browser permission UI — uses getUserMedia. */
function WebPermissionsView() {
  const { t } = useApp();
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  return (
    <div className="space-y-6">
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
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="web" />
      ) : null}
    </div>
  );
}

function DesktopPermissionsView() {
  const { t } = useApp();
  const { plugins, handlePluginToggle } = useApp();
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
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted shadow-sm">
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
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-6 text-center text-xs text-muted shadow-sm">
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
        <div className="rounded-2xl border border-border/60 bg-card/92 shadow-sm">
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <div className="font-bold text-sm text-txt">
                {translateWithFallback(
                  t,
                  "permissionssection.SystemPermissions",
                  "System Permissions",
                )}
              </div>
              <div className="max-w-2xl text-xs-tight leading-5 text-muted">
                {platform === "darwin"
                  ? translateWithFallback(
                      t,
                      "permissionssection.MacSystemPermissionsDescription",
                      "Review the native permissions the app needs for desktop control, voice input, and visual analysis. macOS changes may require opening System Settings.",
                    )
                  : platform === "win32"
                    ? translateWithFallback(
                        t,
                        "permissionssection.WindowsSystemPermissionsDescription",
                        "Open Windows privacy settings for microphone and camera, then verify access by using those features in the app.",
                      )
                    : translateWithFallback(
                        t,
                        "permissionssection.SystemPermissionsDescription",
                        "Grant the runtime access it needs for voice input, camera capture, shell tasks, and desktop automation features.",
                      )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
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
                variant="outline"
                size="sm"
                data-testid="permissions-refresh-button"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                {refreshing
                  ? translateWithFallback(
                      t,
                      "permissionssection.Refreshing",
                      "Refreshing...",
                    )
                  : translateWithFallback(t, "common.refresh", "Refresh")}
              </Button>
            </div>
          </div>
          <div className="divide-y divide-border/50">
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
        </div>
        <div className="mt-2 text-xs-tight leading-5 text-muted">
          {platform === "darwin"
            ? translateWithFallback(
                t,
                "permissionssection.MacGrantAccessNote",
                "macOS requires Accessibility permission for computer control. Open System Settings → Privacy & Security to grant access.",
              )
            : platform === "win32"
              ? translateWithFallback(
                  t,
                  "permissionssection.WindowsGrantPermissionsNote",
                  "Windows may not list the app as a named app here. Use Privacy settings to enable microphone and camera access, then test them in the app.",
                )
              : translateWithFallback(
                  t,
                  "permissionssection.GrantPermissionsNote",
                  "Grant permissions to enable features like voice input and computer control.",
                )}
        </div>
      </div>

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
      <div>
        <div className="rounded-2xl border border-border/60 bg-card/92 shadow-sm">
          <div className="px-4 py-4">
            <div className="font-bold text-sm text-txt">
              {t("appsview.Capabilities")}
            </div>
            <div className="mt-1 text-xs-tight leading-5 text-muted">
              {translateWithFallback(
                t,
                "permissionssection.CapabilitiesDescription",
                "Turn higher-level capabilities on only after the required runtime permissions are available.",
              )}
            </div>
          </div>
          <div className="space-y-2 px-4 py-4">
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
        </div>
        <div className="mt-2 text-xs-tight leading-5 text-muted">
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
 * Onboarding **senses** step: system / streaming permissions with explicit grant
 * and skip actions. Per-permission status stays visible on each row, while the footer
 * makes the outcome of skipping clear. **`onContinue()`** still advances the wizard;
 * `allowPermissionBypass` is used for the explicit skip path.
 */
/** Onboarding section for mobile — streaming permissions to cloud sandbox. */
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
  onBack,
}: {
  onContinue: (options?: { allowPermissionBypass?: boolean }) => void;
  onBack?: () => void;
}) {
  // Web: no permissions needed
  if (isWebPlatform()) {
    return <WebOnboardingPermissions onContinue={onContinue} onBack={onBack} />;
  }

  // Mobile (Capacitor): streaming permissions
  if (isNative && !isDesktopPlatform()) {
    return (
      <MobileOnboardingPermissions onContinue={onContinue} onBack={onBack} />
    );
  }

  // Desktop shell: existing permission flow
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

  /** Check if all critical permissions are granted (or not applicable). */
  const allGranted = hasRequiredOnboardingPermissions(permissions);
  const canProceed = allGranted || usesWindowsPrivacyFlow;
  const essentialPermissions = SYSTEM_PERMISSIONS.filter((def) => {
    const state = permissions?.[def.id];
    return state?.status !== "not-applicable" && def.id !== "shell";
  });
  const footerStatusMessage = canProceed
    ? translateWithFallback(
        t,
        usesWindowsPrivacyFlow
          ? "permissionssection.WindowsPermissionReadyNote"
          : "permissionssection.PermissionReadyNote",
        usesWindowsPrivacyFlow
          ? "Windows privacy settings are advisory here. Continue, then verify microphone and camera directly in the app."
          : "All required permissions are ready. Continue when you're ready.",
      )
    : translateWithFallback(
        t,
        "permissionssection.PermissionSkipNote",
        "Skipping keeps desktop features locked until you grant the missing permissions in Settings.",
      );

  const handleGrantPermissions = useCallback(async () => {
    if (grantingPermissions) {
      return;
    }

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

  const handleSkipForNow = useCallback(() => {
    onContinue({ allowPermissionBypass: true });
  }, [onContinue]);

  if (loading) {
    return (
      <div className="text-center py-8">
        <div className="text-muted text-sm">
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
        <div className="text-muted text-sm mb-4">
          {translateWithFallback(
            t,
            "permissionssection.UnableToCheckPerm",
            "Unable to check permissions.",
          )}
        </div>
        <Button
          type="button"
          variant="default"
          data-testid="permissions-onboarding-continue"
          onClick={() => onContinue()}
        >
          {translateWithFallback(t, "onboarding.savedMyKeys", "Continue")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="text-center mb-6">
        <div className="text-xl font-bold mb-2">
          {translateWithFallback(
            t,
            "permissionssection.SystemPermissions",
            "System Permissions",
          )}
        </div>
        <div className="text-muted text-sm">
          {platform === "win32"
            ? translateWithFallback(
                t,
                "permissionssection.WindowsGrantPermissionsTo",
                "Open Windows privacy settings to prepare microphone and camera access for desktop features.",
              )
            : translateWithFallback(
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
            platform,
          );

          return (
            <div
              key={def.id}
              data-permission-id={def.id}
              className={`flex flex-col gap-3 rounded-2xl border p-4 shadow-sm sm:flex-row sm:items-center ${
                isGranted
                  ? "border-ok/35 bg-ok/10"
                  : "border-border/60 bg-card/92"
              }`}
            >
              <div className="flex min-w-0 flex-1 items-start gap-4">
                <PermissionIcon icon={def.icon} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-txt">
                    {def.name}
                  </div>
                  <div className="text-xs-tight leading-5 text-muted">
                    {def.description}
                  </div>
                </div>
              </div>
              {isGranted ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-ok/30 bg-ok/10">
                  <Check className="h-4 w-4 text-ok" />
                </div>
              ) : action ? (
                <Button
                  variant="default"
                  size="sm"
                  className="min-h-10 rounded-xl px-3 text-xs font-semibold text-txt-strong hover:text-txt-strong sm:self-center"
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

      <div className="mt-[18px] pt-3.5">
        <div className="mb-4 space-y-1 text-xs-tight leading-5 text-muted">
          <p>{footerStatusMessage}</p>
          {!canProceed ? (
            <p>
              {translateWithFallback(
                t,
                platform === "win32"
                  ? "permissionssection.WindowsPermissionGrantNote"
                  : "permissionssection.PermissionGrantNote",
                platform === "win32"
                  ? "This opens Windows privacy settings for microphone and camera. The app may not appear as a named app there; the real check is whether capture works back in the app."
                  : "Granting now will request what can be approved immediately and open Settings for anything that must be enabled there.",
              )}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          {onBack ? (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start p-0 text-2xs uppercase tracking-[0.15em] text-muted-strong hover:text-txt"
              onClick={() => onBack()}
              type="button"
            >
              {translateWithFallback(t, "onboarding.back", "Back")}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            {!canProceed ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-xl px-4 py-2 text-xs-tight font-semibold"
                disabled={grantingPermissions}
                onClick={handleSkipForNow}
              >
                {translateWithFallback(t, "onboarding.rpcSkip", "Skip for now")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="default"
              size="sm"
              data-testid="permissions-onboarding-continue"
              className="min-h-11 min-w-[8.5rem] rounded-xl px-4 py-2 text-xs-tight font-semibold leading-tight text-txt-strong hover:text-txt-strong"
              disabled={grantingPermissions}
              onClick={canProceed ? () => onContinue() : handleGrantPermissions}
            >
              {canProceed
                ? translateWithFallback(t, "onboarding.savedMyKeys", "Continue")
                : grantingPermissions
                  ? translateWithFallback(
                      t,
                      "permissionssection.GrantingPermissions",
                      "Granting...",
                    )
                  : translateWithFallback(
                      t,
                      "permissionssection.GrantPermissions",
                      "Grant Permissions",
                    )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
