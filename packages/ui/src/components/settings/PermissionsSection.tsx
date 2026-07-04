import { useCallback, useEffect, useMemo, useState } from "react";
import type { PermissionId, PermissionState } from "../../api";
import {
  getMobileSignalsPlugin,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSetupAction,
} from "../../bridge/native-plugins";
import { useBootConfig } from "../../config/boot-config-react.hooks";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  isDesktopPlatform,
  isNative,
  isWebPlatform,
  platform as runtimePlatform,
} from "../../platform";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { useAppSelector } from "../../state";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { resolvePrimingSet } from "../permissions/permission-priming";
import { StreamingPermissionsSettingsView } from "../permissions/StreamingPermissions";
import { CapabilityToggle, PermissionRow } from "./permission-controls";
import { useDesktopPermissionsState } from "./permission-controls.hooks";
import { CAPABILITIES, SYSTEM_PERMISSIONS } from "./permission-types";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

type WebsiteBlockerSettingsCardComponent = NonNullable<
  ReturnType<typeof useBootConfig>["websiteBlockerSettingsCard"]
>;

// Per-platform description / grant-note strings, keyed by platform.
type DesktopPlatform = "darwin" | "win32" | "linux";

interface PlatformCopy {
  grantNote: { key: string; defaultValue: string };
}

const PLATFORM_COPY: Record<DesktopPlatform, PlatformCopy> = {
  darwin: {
    grantNote: {
      key: "permissionssection.MacGrantAccessNote",
      defaultValue:
        "macOS requires Accessibility permission for computer control. Open System Settings → Privacy & Security to grant access.",
    },
  },
  win32: {
    grantNote: {
      key: "permissionssection.WindowsGrantPermissionsNote",
      defaultValue:
        "Windows may not list this app by name here. Use Privacy settings to enable microphone and camera access, then test them in the app.",
    },
  },
  linux: {
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
  const t = useAppSelector((s) => s.t);
  const {
    appBlockerSettingsCard: AppBlockerSettingsCard,
    websiteBlockerSettingsCard: WebsiteBlockerSettingsCard,
  } = useBootConfig();
  return (
    <SettingsStack>
      <StreamingPermissionsSettingsView
        mode="mobile"
        testId="mobile-permissions"
        title={t("permissionssection.StreamingPermissions", {
          defaultValue: "Streaming Permissions",
        })}
      />
      <MobileSystemPermissionsPanel />
      <MobileSignalsPermissionsPanel />
      {AppBlockerSettingsCard ? <AppBlockerSettingsCard mode="mobile" /> : null}
      {WebsiteBlockerSettingsCard ? (
        <WebsiteBlockerSettingsCard mode="mobile" />
      ) : null}
    </SettingsStack>
  );
}

function mobileSettingsPlatform(): "ios" | "android" | "web" {
  if (runtimePlatform === "ios" || runtimePlatform === "android") {
    return runtimePlatform;
  }
  return "web";
}

function MobileSystemPermissionsPanel() {
  const t = useAppSelector((s) => s.t);
  const branding = useBranding();
  const mobilePlatform = mobileSettingsPlatform();
  const registry = useMemo(() => createMobileSignalsPermissionsRegistry(), []);
  const permissionDefs = useMemo(
    () =>
      SYSTEM_PERMISSIONS.filter((def) =>
        def.platforms.includes(mobilePlatform),
      ),
    [mobilePlatform],
  );
  const [states, setStates] = useState<
    Partial<Record<PermissionId, PermissionState>>
  >({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<PermissionId | null>(null);

  const refresh = useCallback(
    async (showSpinner = false) => {
      if (showSpinner) setRefreshing(true);
      try {
        const entries = await Promise.all(
          permissionDefs.map(async (def) => {
            try {
              return [def.id, await registry.check(def.id)] as const;
            } catch {
              return [def.id, registry.get(def.id)] as const;
            }
          }),
        );
        setStates(Object.fromEntries(entries));
      } finally {
        if (showSpinner) setRefreshing(false);
      }
    },
    [permissionDefs, registry],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const entries = await Promise.all(
          permissionDefs.map(async (def) => {
            try {
              return [def.id, await registry.check(def.id)] as const;
            } catch {
              return [def.id, registry.get(def.id)] as const;
            }
          }),
        );
        if (!cancelled) setStates(Object.fromEntries(entries));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [permissionDefs, registry]);

  const requestPermission = useCallback(
    async (id: PermissionId) => {
      setBusyId(id);
      try {
        await registry.request(id, {
          reason: "Enable this permission from Settings.",
          feature: { app: "settings", action: `permissions.${id}` },
        });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh, registry],
  );

  const openSettings = useCallback(
    async (id: PermissionId) => {
      setBusyId(id);
      try {
        await openMobilePermissionSettings(id);
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  if (permissionDefs.length === 0) return null;

  if (loading) {
    return (
      <p className="py-4 text-center text-xs text-muted">
        {t("permissionssection.LoadingPermissions", {
          defaultValue: "Loading permissions...",
        })}
      </p>
    );
  }

  return (
    <SettingsGroup
      title={t("permissionssection.SystemPermissions", {
        defaultValue: "System Permissions",
      })}
      action={
        <SettingsActionButton
          agentId="perm-mobile-system-refresh"
          agentLabel="Refresh mobile system permissions"
          agentGroup="permissions"
          agentStatus={refreshing ? "loading" : undefined}
          variant="outline"
          size="sm"
          className="h-9 rounded-sm px-3 text-xs font-semibold"
          onClick={() => void refresh(true)}
          disabled={refreshing}
        >
          {refreshing
            ? t("common.refreshing", { defaultValue: "Refreshing..." })
            : t("common.refresh", { defaultValue: "Refresh" })}
        </SettingsActionButton>
      }
      footer={t("permissionssection.MobilePermissionGrantNote", {
        defaultValue:
          "If a permission was denied, open Settings and enable it for {{appName}}, then return here and refresh.",
        ...appNameInterpolationVars(branding),
      })}
    >
      {permissionDefs.map((def) => {
        const state = states[def.id] ?? registry.get(def.id);
        return (
          <PermissionRow
            key={def.id}
            def={def}
            status={state.status}
            reason={busyId === def.id ? "Updating..." : state.reason}
            platform={mobilePlatform}
            canRequest={state.canRequest}
            onRequest={() => void requestPermission(def.id)}
            onOpenSettings={() => void openSettings(def.id)}
            isShell={false}
            shellEnabled
          />
        );
      })}
    </SettingsGroup>
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
    return { label: "Ready", className: "border-ok/30 text-ok" };
  }
  if (action.status === "unavailable") {
    return { label: "Unavailable", className: "border-border/50 text-muted" };
  }
  return { label: "Needs action", className: "border-warn/30 text-warn" };
}

function MobileSignalsPermissionsPanel() {
  const t = useAppSelector((s) => s.t);
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
    <SettingsGroup
      title={t("permissionssection.LifeOpsSignals", {
        defaultValue: "LifeOps Signals",
      })}
      action={
        <SettingsActionButton
          agentId="perm-mobile-signals-refresh"
          agentLabel="Refresh mobile signals"
          agentGroup="permissions"
          variant="outline"
          size="sm"
          className="h-9 rounded-sm px-3 text-xs font-semibold"
          onClick={refresh}
        >
          {t("common.refresh", { defaultValue: "Refresh" })}
        </SettingsActionButton>
      }
    >
      {status.setupActions.map((action) => (
        <MobileSetupActionRow
          key={action.id}
          action={action}
          busy={busyAction === action.id}
          onAct={() => void handleAction(action)}
        />
      ))}
    </SettingsGroup>
  );
}

function MobileSetupActionRow({
  action,
  busy,
  onAct,
}: {
  action: MobileSignalsSetupAction;
  busy: boolean;
  onAct: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const badge = mobileSetupActionBadge(action);
  const canAct =
    action.status !== "ready" && (action.canRequest || action.canOpenSettings);
  const actionLabel = action.canRequest
    ? t("permissionssection.Grant", { defaultValue: "Grant" })
    : t("permissionssection.OpenSettings", { defaultValue: "Open Settings" });
  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          {action.label}
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
          >
            {badge.label}
          </span>
        </span>
      }
      description={action.reason ?? undefined}
      control={
        canAct ? (
          <SettingsActionButton
            agentId={`perm-mobile-action-${action.id}`}
            agentLabel={`${actionLabel} ${action.label}`}
            agentGroup="permissions"
            variant="default"
            size="sm"
            className="min-h-11 rounded-sm px-3 text-xs font-semibold"
            disabled={busy}
            onClick={onAct}
          >
            {busy
              ? t("common.loading", { defaultValue: "Loading..." })
              : actionLabel}
          </SettingsActionButton>
        ) : undefined
      }
    />
  );
}

function WebPermissionsView() {
  const t = useAppSelector((s) => s.t);
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  return (
    <SettingsStack>
      <StreamingPermissionsSettingsView
        mode="web"
        testId="web-permissions-info"
        title={t("permissionssection.BrowserPermissions", {
          defaultValue: "Browser Permissions",
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
    </SettingsStack>
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
  const t = useAppSelector((s) => s.t);
  const plugins = useAppSelector((s) => s.plugins);
  const handlePluginToggle = useAppSelector((s) => s.handlePluginToggle);
  const { websiteBlockerSettingsCard: WebsiteBlockerSettingsCard } =
    useBootConfig();
  const {
    handleOpenSettings,
    handleRequest,
    handleToggleShell,
    loading,
    permissions,
    platform,
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
    <SettingsStack>
      <SettingsGroup
        title={t("permissionssection.SystemPermissions", {
          defaultValue: "System Permissions",
        })}
        footer={t(copy.grantNote.key, {
          defaultValue: copy.grantNote.defaultValue,
        })}
      >
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
              onToggleShell={def.id === "shell" ? handleToggleShell : undefined}
            />
          );
        })}
      </SettingsGroup>

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

      <SettingsGroup title={t("common.capabilities")}>
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
      </SettingsGroup>
    </SettingsStack>
  );
}

/**
 * Re-trigger for the onboarding permission-priming modal. Lets a user who
 * declined or mis-tapped a permission during onboarding re-run the guided
 * soft-ask flow at any time. Renders nothing on platforms with no priming set
 * (web), where every permission is requested just-in-time instead.
 */
function PermissionPrimingSettingsCard() {
  const t = useAppSelector((s) => s.t);
  const branding = useBranding();
  const ids = useMemo(() => resolvePrimingSet(), []);
  const [open, setOpen] = useState(false);

  if (ids.length === 0) return null;

  return (
    <SettingsGroup
      title={t("permissionssection.QuickSetup", {
        defaultValue: "Quick setup",
      })}
      footer={t("permissionssection.QuickSetupNote", {
        defaultValue:
          "Walk through the key permissions ({{appName}} voice, location, notifications) with an explanation for each.",
        ...appNameInterpolationVars(branding),
      })}
    >
      <SettingsRow
        label={t("permissionssection.SetUpPermissions", {
          defaultValue: "Set up permissions",
        })}
        description={t("permissionssection.SetUpPermissionsDesc", {
          defaultValue:
            "Re-run the guided permission prompts, including any you previously declined.",
        })}
        control={
          <SettingsActionButton
            agentId="perm-priming-open"
            agentLabel="Set up permissions"
            agentGroup="permissions"
            variant="default"
            size="sm"
            className="min-h-11 rounded-sm px-3 text-xs font-semibold"
            onClick={() => setOpen(true)}
          >
            {t("permissionssection.Review", { defaultValue: "Review" })}
          </SettingsActionButton>
        }
      />
      {open ? (
        <PermissionPrimingModal
          ids={ids}
          open={open}
          onComplete={() => setOpen(false)}
        />
      ) : null}
    </SettingsGroup>
  );
}

function PermissionsSectionBody() {
  if (isWebPlatform()) return <WebPermissionsView />;
  if (isNative && !isDesktopPlatform()) return <MobilePermissionsView />;
  return <DesktopPermissionsView />;
}

export function PermissionsSection() {
  return (
    <SettingsStack>
      <PermissionPrimingSettingsCard />
      <PermissionsSectionBody />
    </SettingsStack>
  );
}
