import type { PermissionStatus, PluginInfo } from "../../api";
import { useApp } from "../../state";
import { PermissionIcon } from "../permissions/PermissionIcon";
import { Button } from "../ui/button";
import { StatusBadge } from "../ui/status-badge";
import { Switch } from "../ui/switch";
import type { CapabilityDef, PermissionDef } from "./permission-types";
import {
  getPermissionAction,
  getPermissionBadge,
  translateWithFallback,
} from "./permission-types";

// ---------------------------------------------------------------------------
// PermissionRow
// ---------------------------------------------------------------------------

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
  const { t } = useApp();
  const action = getPermissionAction(t, def.id, status, canRequest, platform);
  const badge = getPermissionBadge(t, def.id, status, platform);
  const name = translateWithFallback(t, def.nameKey, def.name);
  const description = translateWithFallback(
    t,
    def.descriptionKey,
    def.description,
  );

  return (
    <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <PermissionIcon icon={def.icon} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-sm text-txt">{name}</span>
            {isShell && (
              <span className="rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong">
                {translateWithFallback(
                  t,
                  "permissionssection.LocalRuntime",
                  "Local runtime",
                )}
              </span>
            )}
          </div>
          <StatusBadge
            label={badge.label}
            variant={badge.tone}
            withDot
            className="rounded-full font-semibold"
          />
          <div className="mt-1 text-xs-tight leading-5 text-muted">
            {description}
          </div>
          {reason && (
            <div className="mt-1 text-xs-tight leading-5 text-muted-strong">
              {reason}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        {isShell && onToggleShell && status !== "not-applicable" && (
          <div className="flex min-h-10 items-center gap-2 rounded-sm border border-border/50 bg-bg-hover px-3">
            <span className="text-xs-tight font-medium text-muted-strong">
              {shellEnabled
                ? translateWithFallback(
                    t,
                    "permissionssection.Enabled",
                    "Enabled",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.Disabled",
                    "Disabled",
                  )}
            </span>
            <Switch
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
            />
          </div>
        )}
        {!isShell && action && (
          <Button
            variant="default"
            size="sm"
            className="min-h-10 rounded-sm px-3 text-xs-tight font-semibold"
            onClick={action.type === "request" ? onRequest : onOpenSettings}
            aria-label={`${action.ariaLabelPrefix} ${name}`}
          >
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CapabilityToggle
// ---------------------------------------------------------------------------

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
  const { t } = useApp();
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

  return (
    <div
      className={`flex flex-col gap-3 rounded-sm border px-4 py-3 transition-colors sm:flex-row sm:items-center ${
        enabled
          ? "border-accent/30 bg-accent/10"
          : "border-border/60 bg-card/92"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-sm text-txt">{label}</span>
          {!available && (
            <span className="rounded-full border border-border/50 bg-bg-hover px-2 py-0.5 text-2xs font-medium text-muted-strong">
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
        </div>
        <div className="mt-1 text-xs-tight leading-5 text-muted">
          {description}
        </div>
      </div>
      <div className="flex w-full justify-end sm:w-auto">
        <div className="flex min-h-10 items-center gap-2 rounded-sm border border-border/50 bg-bg-hover px-3">
          <span className="text-xs-tight font-medium text-muted-strong">
            {enabled
              ? translateWithFallback(
                  t,
                  "permissionssection.Enabled",
                  "Enabled",
                )
              : translateWithFallback(
                  t,
                  "permissionssection.Disabled",
                  "Disabled",
                )}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!canEnable}
            aria-label={toggleActionLabel}
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
        </div>
      </div>
    </div>
  );
}
