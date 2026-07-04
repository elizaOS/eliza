/**
 * Presentational rows for the Permissions settings section. `PermissionRow`
 * renders one OS/app permission (icon, name, status badge, request/open-settings
 * action, and the optional shell-enable switch); `CapabilityToggle` renders a
 * capability on/off row. Status/badge/action copy is resolved through
 * `permission-types`; the controls are agent-addressable via `useAgentElement`.
 */

import {
  AppWindow,
  Battery,
  Bell,
  Bluetooth,
  Calendar,
  Camera,
  Contact,
  HardDrive,
  HeartPulse,
  Hourglass,
  Image,
  ListTodo,
  type LucideIcon,
  MapPin,
  MessageSquare,
  Mic,
  Monitor,
  MousePointer2,
  Network,
  NotebookTabs,
  Phone,
  Settings,
  ShieldBan,
  Terminal,
  Wifi,
  Workflow,
} from "lucide-react";
import { useAgentElement } from "../../agent-surface";
import type { PermissionStatus, PluginInfo } from "../../api";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import { Switch } from "../ui/switch";
import type { CapabilityDef, PermissionDef } from "./permission-types";
import {
  getPermissionAction,
  getPermissionBadge,
  translateWithFallback,
} from "./permission-types";
import { SettingsRow } from "./settings-layout";

const PERMISSION_ICONS: Record<string, LucideIcon> = {
  cursor: MousePointer2,
  monitor: Monitor,
  mic: Mic,
  camera: Camera,
  terminal: Terminal,
  "shield-ban": ShieldBan,
  "map-pin": MapPin,
  "list-todo": ListTodo,
  calendar: Calendar,
  "heart-pulse": HeartPulse,
  hourglass: Hourglass,
  contact: Contact,
  "notebook-tabs": NotebookTabs,
  bell: Bell,
  "hard-drive": HardDrive,
  workflow: Workflow,
  image: Image,
  phone: Phone,
  "message-square": MessageSquare,
  wifi: Wifi,
  bluetooth: Bluetooth,
  "app-window": AppWindow,
  network: Network,
  battery: Battery,
  settings: Settings,
};

function permissionIcon(icon: string): LucideIcon {
  return PERMISSION_ICONS[icon] ?? Settings;
}

export function PermissionRow({
  def,
  status,
  reason,
  platform,
  canRequest,
  onRequest,
  onOpenSettings,
  isShell,
  shellEnabled,
  onToggleShell,
}: {
  def: PermissionDef;
  status: PermissionStatus;
  reason?: string;
  platform: string;
  canRequest: boolean;
  onRequest: () => void;
  onOpenSettings: () => void;
  isShell: boolean;
  shellEnabled: boolean;
  onToggleShell?: (enabled: boolean) => void;
}) {
  const t = useAppSelector((s) => s.t);
  const action = getPermissionAction(t, def.id, status, canRequest, platform);
  const badge = getPermissionBadge(t, def.id, status, platform);
  const name = translateWithFallback(t, def.nameKey, def.name);
  const description = translateWithFallback(
    t,
    def.descriptionKey,
    def.description,
  );

  const showShellToggle =
    isShell && onToggleShell && status !== "not-applicable";

  const { ref: shellRef, agentProps: shellAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `perm-shell-${def.id}`,
      role: "toggle",
      label: `${name} shell access`,
      group: "permissions",
      status: shellEnabled ? "on" : "off",
      getValue: () => shellEnabled,
      onActivate: onToggleShell
        ? () => onToggleShell(!shellEnabled)
        : undefined,
    });
  const { ref: actionRef, agentProps: actionAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `perm-action-${def.id}`,
      role: "button",
      label: action ? `${action.ariaLabelPrefix} ${name}` : `Grant ${name}`,
      group: "permissions",
      onActivate: action
        ? action.type === "request"
          ? onRequest
          : onOpenSettings
        : undefined,
    });

  const control = showShellToggle ? (
    <Switch
      ref={shellRef}
      checked={shellEnabled}
      onCheckedChange={onToggleShell}
      title={
        shellEnabled
          ? translateWithFallback(
              t,
              "permissionssection.DisableShellAccess",
              "Disable shell access",
            )
          : translateWithFallback(
              t,
              "permissionssection.EnableShellAccess",
              "Enable shell access",
            )
      }
      {...shellAgentProps}
    />
  ) : !isShell && action ? (
    <Button
      ref={actionRef}
      variant="default"
      size="sm"
      className="min-h-11 rounded-sm px-3 text-xs font-semibold"
      onClick={action.type === "request" ? onRequest : onOpenSettings}
      aria-label={`${action.ariaLabelPrefix} ${name}`}
      {...actionAgentProps}
    >
      {action.label}
    </Button>
  ) : undefined;

  const label = (
    <span className="flex flex-wrap items-center gap-2">
      {name}
      {isShell && (
        <span className="rounded-full border border-border/50 bg-surface px-2 py-0.5 text-2xs font-medium text-muted">
          {translateWithFallback(
            t,
            "permissionssection.LocalRuntime",
            "Local runtime",
          )}
        </span>
      )}
      <StatusBadge
        label={badge.label}
        variant={badge.tone}
        withDot
        className="rounded-full font-semibold"
      />
    </span>
  );

  return (
    <SettingsRow
      icon={permissionIcon(def.icon)}
      label={label}
      control={control}
      description={
        <>
          {description}
          {reason ? (
            <span className="mt-1 block text-txt">{reason}</span>
          ) : null}
        </>
      }
    />
  );
}

export function CapabilityToggle({
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
  const t = useAppSelector((s) => s.t);
  const enabled = plugin?.enabled ?? false;
  const available = plugin !== null;
  const canEnable = permissionsGranted && available;
  const label = translateWithFallback(t, cap.labelKey, cap.label);
  const description = translateWithFallback(
    t,
    cap.descriptionKey,
    cap.description,
  );
  const toggleActionLabel = `${
    enabled
      ? translateWithFallback(t, "permissionssection.Disable", "Disable")
      : translateWithFallback(t, "permissionssection.Enable", "Enable")
  } ${label}`;

  const { ref: toggleRef, agentProps: toggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `perm-capability-${cap.id}`,
      role: "toggle",
      label,
      group: "permissions",
      description,
      status: enabled ? "on" : "off",
      getValue: () => enabled,
      onActivate: canEnable ? () => onToggle(!enabled) : undefined,
    });

  const rowLabel = (
    <span className="flex flex-wrap items-center gap-2">
      {label}
      {!available && (
        <span className="rounded-full border border-border/50 bg-surface px-2 py-0.5 text-2xs font-medium text-muted">
          {translateWithFallback(
            t,
            "permissionssection.PluginUnavailable",
            "Plugin unavailable",
          )}
        </span>
      )}
      {!permissionsGranted && (
        <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 text-2xs font-medium text-warn">
          {t("permissionssection.MissingPermissions")}
        </span>
      )}
    </span>
  );

  return (
    <SettingsRow
      label={rowLabel}
      description={description}
      control={
        <Switch
          ref={toggleRef}
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={!canEnable}
          aria-label={toggleActionLabel}
          {...toggleAgentProps}
          title={
            !available
              ? translateWithFallback(
                  t,
                  "permissionssection.PluginNotAvailable",
                  "Plugin not available",
                )
              : !permissionsGranted
                ? translateWithFallback(
                    t,
                    "permissionssection.GrantRequiredPermissionsFirst",
                    "Grant required permissions first",
                  )
                : enabled
                  ? translateWithFallback(
                      t,
                      "permissionssection.Disable",
                      "Disable",
                    )
                  : translateWithFallback(
                      t,
                      "permissionssection.Enable",
                      "Enable",
                    )
          }
        />
      }
    />
  );
}
