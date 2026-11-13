/**
 * Settings → Permissions section (the `permissions` section id). Lists the OS-
 * level permissions the agent depends on (from SYSTEM_PERMISSIONS/CAPABILITIES),
 * shows each one's granted/denied status, and requests or reconciles them across
 * platforms — mobile via the native mobile-signals plugin, web via the
 * browser Permissions API. Also hosts the permission-priming card.
 */

import type { PermissionId, PermissionState } from "@elizaos/core/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMobileSignalsPlugin,
  type MobileSignalsPermissionStatus,
  type MobileSignalsSetupAction,
} from "../../bridge/native-plugins";
import { useBootConfig } from "../../config/boot-config-react.hooks";
import { appNameInterpolationVars } from "../../config/branding-base";
import { useBranding } from "../../config/branding-react.hooks";
import { isWebPlatform, platform as runtimePlatform } from "../../platform/init";
import {
  createMobileSignalsPermissionsRegistry,
  openMobilePermissionSettings,
} from "../../platform/mobile-permissions-client";
import { useAppSelector } from "../../state/app-store";
import { PermissionPrimingModal } from "../permissions/PermissionPrimingModal";
import { resolvePrimingSet } from "../permissions/permission-priming";
import { StreamingPermissionsSettingsView } from "../permissions/StreamingPermissions";
import { PermissionRow } from "./permission-controls";
import { useDesktopPermissionsState } from "./permission-controls.hooks";
import { SYSTEM_PERMISSIONS } from "./permission-types";
import { SettingsActionButton } from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

type WebsiteBlockerSettingsCardComponent = NonNullable<
  ReturnType<typeof useBootConfig>["websiteBlockerSettingsCard"]
>;

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

// Exported for tests: the error-vs-designed-hidden distinction below is a
// three-state-rule guard (#12784) and needs direct render coverage.
export function MobileSignalsPermissionsPanel() {
  const t = useAppSelector((s) => s.t);
  const [status, setStatus] = useState<MobileSignalsPermissionStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  // A thrown checkPermissions (plugin present but broken) must render as an
  // error, not vanish like the designed "plugin not on this platform" degrade
  // (three-state rule: error vs designed-hidden must be distinguishable).
  const [error, setError] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const plugin = getMobileSignalsPlugin();
    if (typeof plugin.checkPermissions !== "function") {
      setStatus(null);
      return;
    }
    try {
      setStatus(await plugin.checkPermissions());
      setError(false);
    } catch {
      // error-policy:J4 bridge call failed — surface the explicit error row
      // below instead of silently hiding the whole panel.
      setStatus(null);
      setError(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const plugin = getMobileSignalsPlugin();
        if (typeof plugin.checkPermissions !== "function") {
          // Designed degrade: the mobile-signals plugin isn't part of this
          // build (web/desktop), so the panel intentionally renders nothing.
          if (!cancelled) setStatus(null);
          return;
        }
        const next = await plugin.checkPermissions();
        if (!cancelled) {
          setStatus(next);
          setError(false);
        }
      } catch {
        // error-policy:J4 plugin exists but the permissions probe failed —
        // render the explicit error row, not the designed-hidden state.
        if (!cancelled) {
          setStatus(null);
          setError(true);
        }
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
    if (error) {
      return (
        <p
          data-testid="mobile-signals-permissions-error"
          className="py-4 text-center text-xs text-danger"
        >
          {t("permissionssection.PermissionsError", {
            defaultValue: "Could not read device permissions.",
          })}
        </p>
      );
    }
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
        Loading website blocking…
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
  return <MobilePermissionsView />;
}

export function PermissionsSection() {
  return (
    <SettingsStack>
      <PermissionPrimingSettingsCard />
      <PermissionsSectionBody />
    </SettingsStack>
  );
}
