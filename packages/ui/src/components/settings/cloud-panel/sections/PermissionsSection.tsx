/**
 * Cloud-panel Permissions section — consolidates the three permission surfaces
 * the operator manages from one place: device/system permissions (microphone,
 * notifications, accessibility) and server-side cloud plugin grants with
 * revoke. Cloud-only desktop does not host local apps, so local app permission
 * grants are deliberately absent. Cloud plugin grants hit
 * `GET/DELETE /api/v1/me/plugin-grants`.
 *
 * All three groups use the same row pattern:
 *   Title  →  Description  →  Status badge  →  Action control
 * The status badge (colored dot + text) makes the current state visible at a
 * glance. The action control adapts to the permission type: button for OS-level
 * permissions (request/open), toggle for app-level grants, button for cloud
 * grants (revoke). This matches macOS System Settings where every row has the
 * same structure but the control differs.
 */

import type { PermissionId } from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, apiFetch } from "../../../../cloud/lib/api-client";
import { useAppSelector } from "../../../../state";
import { Button } from "../../../ui/button";
import { useDesktopPermissionsState } from "../../permission-controls.hooks";
import { type PermissionDef, SYSTEM_PERMISSIONS } from "../../permission-types";
import { hasCloudManagementCredential } from "../cloud-management-auth";
import {
  CloudRow,
  DestructiveSecondaryButton,
  SettingsGroup,
  SettingsStack,
} from "../cloud-settings-primitives";
import { PermissionStatusBadge } from "./permission-status-badge";

/* ── Device permissions ─────────────────────────────────────────── */

const DEVICE_PERMISSION_IDS: ReadonlySet<PermissionId> = new Set([
  "microphone",
  "notifications",
  "accessibility",
]);
const DEVICE_PERMISSION_DEFS: readonly PermissionDef[] =
  SYSTEM_PERMISSIONS.filter((definition) =>
    DEVICE_PERMISSION_IDS.has(definition.id),
  );

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
    <CloudRow
      label={def.name}
      description={def.description}
      control={
        <span className="flex items-center gap-3">
          <PermissionStatusBadge granted={granted} />
          {granted ? (
            <Button variant="outline" size="sm" onClick={onOpenSettings}>
              Open
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              disabled={!canRequest}
              onClick={onRequest}
            >
              Request
            </Button>
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
        <CloudRow label="Loading permissions…" />
      </SettingsGroup>
    );
  }

  if (!permissions) {
    return (
      <SettingsGroup
        title="Device permissions"
        footer="This cloud-only build could not read the macOS permission service."
      >
        <CloudRow
          label="Permission status unavailable"
          description="No permission was reported as denied or granted."
        />
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

/* ── Cloud plugin grants ────────────────────────────────────────── */

interface CloudPluginGrant {
  grant_id: string;
  plugin_id: string;
  plugin_name?: string | null;
  permission: string;
  scope?: string | null;
}

type CloudGrantsState =
  | { kind: "loading" }
  | { kind: "ready"; grants: CloudPluginGrant[] }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function CloudPluginGrantsGroup() {
  const cloudConnected = useAppSelector((s) => s.elizaCloudConnected);
  const hasCloudCredential = hasCloudManagementCredential();
  const [state, setState] = useState<CloudGrantsState>({ kind: "loading" });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await api<{ grants?: CloudPluginGrant[] }>(
        "/api/v1/me/plugin-grants",
      );
      setState({ kind: "ready", grants: result.grants ?? [] });
    } catch (error) {
      // error-policy:J4 404 renders the designed missing state; other
      // failures render the visible error state.
      if (error instanceof ApiError && error.status === 404) {
        setState({ kind: "missing" });
        return;
      }
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not load grants",
      });
    }
  }, []);

  useEffect(() => {
    if (cloudConnected || hasCloudCredential) void load();
  }, [cloudConnected, hasCloudCredential, load]);

  const revoke = async (grantId: string) => {
    setRevoking(grantId);
    try {
      await apiFetch(
        `/api/v1/me/plugin-grants/${encodeURIComponent(grantId)}`,
        { method: "DELETE" },
      );
      await load();
    } catch (error) {
      // error-policy:J4 revoke failure renders the visible error state.
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not revoke grant",
      });
    } finally {
      setRevoking(null);
    }
  };

  if (!cloudConnected && !hasCloudCredential) {
    return (
      <SettingsGroup
        title="Cloud plugin grants"
        footer="Connect to Eliza Cloud to manage plugin grants."
      >
        <CloudRow label="No cloud connection" />
      </SettingsGroup>
    );
  }

  return (
    <SettingsGroup
      title="Cloud plugin grants"
      footer="Server-side permissions granted to cloud plugins. Revoke a grant to withdraw access immediately."
    >
      {state.kind === "loading" ? (
        <CloudRow label="Loading plugin grants…" />
      ) : state.kind === "missing" ? (
        <CloudRow label="Plugin grant tracking is not available on this server." />
      ) : state.kind === "error" ? (
        <CloudRow
          label="Plugin grants unavailable"
          description={state.message}
        />
      ) : state.grants.length === 0 ? (
        <CloudRow label="No plugins have been granted permissions." />
      ) : (
        state.grants.map((grant) => (
          <CloudRow
            key={grant.grant_id}
            label={grant.plugin_name ?? grant.plugin_id}
            description={[grant.permission, grant.scope]
              .filter(Boolean)
              .join(" · ")}
            control={
              <span className="flex items-center gap-3">
                <PermissionStatusBadge granted />
                <DestructiveSecondaryButton
                  size="sm"
                  disabled={revoking === grant.grant_id}
                  onClick={() => void revoke(grant.grant_id)}
                >
                  {revoking === grant.grant_id ? "Revoking…" : "Revoke"}
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
      <CloudPluginGrantsGroup />
    </SettingsStack>
  );
}
