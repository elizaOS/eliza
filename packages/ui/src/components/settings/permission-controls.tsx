/**
 * Presentational rows for the Permissions settings section. `PermissionRow`
 * renders one OS/app permission (icon, name, status badge, request/open-settings
 * action, and the optional shell-enable switch); `CapabilityToggle` renders a
 * capability on/off row. Status/badge/action copy is resolved through
 * `permission-types`; the controls are agent-addressable via SettingsSwitchRow.
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
import type { PermissionStatus, PluginInfo } from "../../api";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import type { CapabilityDef, PermissionDef } from "./permission-types";
import {
  getPermissionAction,
  getPermissionBadge,
  translateWithFallback,
} from "./permission-types";
import { SettingsSwitchRow } from "./settings-agent-rows";
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

  if (showShellToggle) {
    return (
      <SettingsSwitchRow
        agentId={`perm-shell-${def.id}`}
        label={label}
        agentLabel={`${name} shell access`}
        group="permissions"
        checked={shellEnabled}
        onCheckedChange={onToggleShell}
        description={
          <>
            {description}
            {reason ? (
              <span className="mt-1 block text-txt">{reason}</span>
            ) : null}
          </>
        }
        icon={permissionIcon(def.icon)}
      />
    );
  }

  const control = !isShell && action ? (
    <Button
      variant="default"
      size="sm"
      className="min-h-11 rounded-sm px-3 text-xs font-semibold"
      onClick={action.type === "request" ? onRequest : onOpenSettings}
      aria-label={`${action.ariaLabelPrefix} ${name}`}
    >
      {action.label}
    </Button>
  ) : undefined;

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
    <SettingsSwitchRow
      agentId={`perm-capability-${cap.id}`}
      label={rowLabel}
      agentLabel={label}
      group="permissions"
      checked={enabled}
      onCheckedChange={onToggle}
      disabled={!canEnable}
      description={description}
    />
  );
}
