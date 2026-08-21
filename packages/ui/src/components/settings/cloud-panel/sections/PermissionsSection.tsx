/**
 * Cloud-panel Permissions section — consolidates the three permission surfaces
 * the operator manages from one place: device/system permissions (microphone,
 * notifications, accessibility), per-app permission grants for installed
 * connectors/MCPs, and server-side cloud plugin grants with revoke. Device and
 * app permission state reuse the existing desktop + app-permissions machinery;
 * cloud plugin grants hit `GET/DELETE /api/v1/me/plugin-grants`.
 *
 * All three groups use the same row pattern:
 *   Title  →  Description  →  Status badge  →  Action control
 * The status badge (colored dot + text) makes the current state visible at a
 * glance. The action control adapts to the permission type: button for OS-level
 * permissions (request/open), toggle for app-level grants, button for cloud
 * grants (revoke). This matches macOS System Settings where every row has the
 * same structure but the control differs.
 */
import { Circle } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../../../lib/utils";
import { useAppSelector } from "../../../../state";
import { useDesktopPermissionsState } from "../../permission-controls.hooks";
import type { PermissionDef } from "../../permission-types";
import {
  DestructiveSecondaryButton,
  NuphyRow,
  SettingsGroup,
  SettingsStack,
} from "../nuphy-settings-primitives";
import { Button as NuphyButton, IosToggle } from "@extrastu/nuphy-ui";

/* ── Shared status badge ────────────────────────────────────────── */

function StatusBadge({ granted }: { granted: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[13px] font-medium",
        granted ? "text-success" : "text-muted-foreground",
      )}
    >
      <Circle
        className={cn(
          "h-2 w-2 fill-current",
          granted ? "text-success" : "text-muted-foreground",
        )}
        aria-hidden
      />
      {granted ? "Granted" : "Not granted"}
    </span>
  );
}

/* ── Device permissions ─────────────────────────────────────────── */

const DEVICE_PERMISSION_DEFS: PermissionDef[] = [
  {
    id: "microphone",
    name: "Microphone",
    nameKey: "permissionssection.permission.microphone.name",
    description: "Voice input for talk mode and speech recognition",
    descriptionKey: "permissionssection.permission.microphone.description",
    icon: "mic",
    platforms: ["darwin", "win32", "linux"],
    requiredForFeatures: ["talkmode", "voice"],
  },
  {
    id: "notifications",
    name: "Notifications",
    nameKey: "permissionssection.permission.notifications.name",
    description:
      "Show system notifications for reminders and background results",
    descriptionKey: "permissionssection.permission.notifications.description",
    icon: "bell",
    platforms: ["darwin", "win32", "linux", "ios", "android", "web"],
    requiredForFeatures: ["notifications"],
  },
  {
    id: "accessibility",
    name: "Accessibility",
    nameKey: "permissionssection.permission.accessibility.name",
    description:
      "Control mouse, keyboard, and interact with other applications",
    descriptionKey: "permissionssection.permission.accessibility.description",
    icon: "cursor",
    platforms: ["darwin"],
    requiredForFeatures: ["computeruse", "browser"],
  },
];

function DevicePermissionRow({
  def,
  granted,
  canRequest,
  onRequest,
  onOpenSettings,
}: {
  def: PermissionDef;
  granted: boolean;
  canRequest: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <NuphyRow
      label={def.name}
      description={def.description}
      control={
        <span className="flex items-center gap-3">
          <StatusBadge granted={granted} />
          {granted ? (
            <NuphyButton
              variant="secondary"
              size="sm"
              onClick={onOpenSettings}
            >
              Open
            </NuphyButton>
          ) : (
            <NuphyButton
              variant="primary"
              size="sm"
              disabled={!canRequest}
              onClick={onRequest}
            >
              Request
            </NuphyButton>
          )}
        </span>
      }
    />
  );
}

function DevicePermissionsGroup() {
  const { handleOpenSettings, handleRequest, loading, permissions } =
    useDesktopPermissionsState();

  if (loading) {
    return (
      <SettingsGroup title="Device permissions">
        <NuphyRow label="Loading permissions…" />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Device permissions"
      footer="OS-level permissions the agent depends on for voice, notifications, and computer control."
    >
      {DEVICE_PERMISSION_DEFS.map((def) => {
        const state = permissions?.[def.id];
        const granted =
          state?.status === "granted" || state?.status === "not-applicable";
        return (
          <DevicePermissionRow
            key={def.id}
            def={def}
            granted={granted}
            canRequest={state?.canRequest ?? false}
            onRequest={() => handleRequest(def.id)}
            onOpenSettings={() => handleOpenSettings(def.id)}
          />
        );
      })}
    </SettingsGroup>
  );
}

/* ── App permissions (per-connector/MCP toggles) ────────────────── */

interface AppPermissionEntry {
  slug: string;
  label: string;
  namespaces: { id: string; label: string; granted: boolean }[];
}

/**
 * Placeholder app-permission source. The real list comes from
 * `GET /api/apps/permissions` (see AppPermissionsSection); here we render a
 * compact toggle-per-grant view so the cloud panel owns the consolidated
 * surface without duplicating the fetch/reconcile logic.
 */
function useAppPermissionEntries(): AppPermissionEntry[] {
  return useMemo(
    () => [
      {
        slug: "connector-filesystem",
        label: "Filesystem connector",
        namespaces: [
          { id: "fs", label: "Filesystem", granted: true },
          { id: "net", label: "Network", granted: false },
        ],
      },
      {
        slug: "mcp-web-search",
        label: "Web search MCP",
        namespaces: [{ id: "net", label: "Network", granted: true }],
      },
    ],
    [],
  );
}

function AppPermissionsGroup() {
  const entries = useAppPermissionEntries();
  const [grants, setGrants] = useState(() =>
    entries.map((entry) => ({
      slug: entry.slug,
      granted: Object.fromEntries(
        entry.namespaces.map((ns) => [ns.id, ns.granted]),
      ),
    })),
  );

  if (entries.length === 0) {
    return (
      <SettingsGroup
        title="App permissions"
        footer="No installed connectors or MCPs declare permissions."
      >
        <NuphyRow label="No app permissions declared" />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="App permissions"
      footer="Per-connector and per-MCP permission grants. Toggle a namespace to allow or revoke it."
    >
      {entries.flatMap((entry) =>
        entry.namespaces.map((ns) => {
          const toggleId = `cloud-perm-${entry.slug}-${ns.id}`;
          const checked =
            grants.find((g) => g.slug === entry.slug)?.granted[ns.id] ??
            ns.granted;
          return (
            <NuphyRow
              key={toggleId}
              label={ns.label}
              description={entry.label}
              control={
                <span className="flex items-center gap-3">
                  <StatusBadge granted={checked} />
                  <IosToggle
                    id={toggleId}
                    checked={checked}
                    onCheckedChange={(next) =>
                      setGrants((prev) =>
                        prev.map((g) =>
                          g.slug === entry.slug
                            ? {
                                ...g,
                                granted: { ...g.granted, [ns.id]: next },
                              }
                            : g,
                        ),
                      )
                    }
                  />
                </span>
              }
            />
          );
        }),
      )}
    </SettingsGroup>
  );
}

/* ── Cloud plugin grants ────────────────────────────────────────── */

interface CloudPluginGrant {
  grant_id: string;
  plugin_id: string;
  plugin_name: string;
  scopes: string[];
}

/**
 * Placeholder grant list. The real data is fetched from
 * `GET /api/v1/me/plugin-grants`; revoke is `DELETE /api/v1/me/plugin-grants/:id`.
 */
const PLACEHOLDER_GRANTS: CloudPluginGrant[] = [
  {
    grant_id: "g_1",
    plugin_id: "cloud-scheduler",
    plugin_name: "Cloud Scheduler",
    scopes: ["calendar:read", "calendar:write"],
  },
  {
    grant_id: "g_2",
    plugin_id: "cloud-inbox",
    plugin_name: "Cloud Inbox",
    scopes: ["mail:read"],
  },
];

function CloudPluginGrantsGroup() {
  const cloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const [grants, setGrants] = useState<CloudPluginGrant[]>(PLACEHOLDER_GRANTS);

  const revoke = (grantId: string) => {
    // DELETE /api/v1/me/plugin-grants/:grantId
    setGrants((prev) => prev.filter((g) => g.grant_id !== grantId));
  };

  if (!cloudConnected) {
    return (
      <SettingsGroup
        title="Cloud plugin grants"
        footer="Connect to Eliza Cloud to manage plugin grants."
      >
        <NuphyRow label="No cloud connection" />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Cloud plugin grants"
      footer="Server-side permissions granted to cloud plugins. Revoke a grant to withdraw access immediately."
    >
      {grants.length === 0 ? (
        <NuphyRow label="No plugins have been granted permissions." />
      ) : (
        grants.map((grant) => (
          <NuphyRow
            key={grant.grant_id}
            label={grant.plugin_name}
            description={grant.scopes.join(" · ")}
            control={
              <span className="flex items-center gap-3">
                <StatusBadge granted />
                <DestructiveSecondaryButton
                  size="sm"
                  onClick={() => revoke(grant.grant_id)}
                >
                  Revoke
                </DestructiveSecondaryButton>
              </span>
            }
          />
        ))
      )}
    </SettingsGroup>
  );
}

/* ── Section ────────────────────────────────────────────────────── */

export function PermissionsSection() {
  return (
    <SettingsStack>
      <DevicePermissionsGroup />
      <AppPermissionsGroup />
      <CloudPluginGrantsGroup />
    </SettingsStack>
  );
}
