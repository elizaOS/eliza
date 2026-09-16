/**
 * Presentational rows for the Permissions settings section. `PermissionRow`
 * renders one OS/app permission (icon, name, status badge, request/open-settings
 * action, and the optional shell-enable switch); `CapabilityToggle` is a
 * SettingsSwitchRow for a capability on/off. Status/badge/action copy is
 * resolved through `permission-types`.
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
import { Badge } from "../ui/badge";
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

  const label = (
    <span className="flex flex-wrap items-center gap-2">
      {name}
      {isShell && (
        <Badge asChild variant="statusMuted" size="pill">
          <span>
            {translateWithFallback(
              t,
              "permissionssection.LocalRuntime",
              "Local runtime",
            )}
          </span>
        </Badge>
      )}
      <StatusBadge label={badge.label} variant={badge.tone} withDot />
    </span>
  );

  const descriptionNode = (
    <>
      {description}
      {reason ? <span className="mt-1 block text-txt">{reason}</span> : null}
    </>
  );

  if (showShellToggle) {
    return (
      <SettingsSwitchRow
        agentId={`perm-shell-${def.id}`}
        agentLabel={`${name} shell access`}
        group="permissions"
        icon={permissionIcon(def.icon)}
        label={label}
        description={descriptionNode}
        checked={shellEnabled}
        agentStatus={shellEnabled ? "on" : "off"}
        onCheckedChange={(checked) => onToggleShell?.(checked)}
      />
    );
  }

  return (
    <SettingsRow
      icon={permissionIcon(def.icon)}
      label={label}
      control={
        !isShell && action ? (
          <Button
            ref={actionRef}
            variant="default"
            size="touch"
            onClick={action.type === "request" ? onRequest : onOpenSettings}
            aria-label={`${action.ariaLabelPrefix} ${name}`}
            {...actionAgentProps}
          >
            {action.label}
          </Button>
        ) : undefined
      }
      description={descriptionNode}
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
        <Badge asChild variant="statusMuted" size="pill">
          <span>
            {translateWithFallback(
              t,
              "permissionssection.PluginUnavailable",
              "Plugin unavailable",
            )}
          </span>
        </Badge>
      )}
      {!permissionsGranted && (
        <Badge asChild variant="statusWarning" size="pill">
          <span>{t("permissionssection.MissingPermissions")}</span>
        </Badge>
      )}
    </span>
  );

  return (
    <SettingsSwitchRow
      agentId={`perm-capability-${cap.id}`}
      agentLabel={label}
      group="permissions"
      label={rowLabel}
      description={description}
      checked={enabled}
      disabled={!canEnable}
      agentStatus={enabled ? "on" : "off"}
      onCheckedChange={onToggle}
    />
  );
}
