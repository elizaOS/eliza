/**
 * Owner-facing settings card for the website blocker: shows current block status
 * and permission state and lets the owner configure and start/stop hosts-file
 * (SelfControl) blocking. Exported via the plugin's ui module.
 */
import type { PermissionStatus } from "@elizaos/shared";
import { Button } from "@elizaos/ui";
import { useAppSelector } from "@elizaos/ui/state";
import { CheckCircle2, Monitor, Settings, ShieldBan } from "lucide-react";
import type { WebsiteBlockerSettingsCardProps } from "../types/website-blocker-settings-card";

function translate(
  t: (key: string) => string,
  key: string,
  fallback: string,
): string {
  const value = t(key);
  return value === key ? fallback : value;
}

function statusBadge(
  t: (key: string) => string,
  status: PermissionStatus | undefined,
  platform: string | undefined,
): { variant: "secondary" | "outline"; label: string; ready: boolean } {
  if (!status) {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.unknown", "Unknown"),
      ready: false,
    };
  }
  if (status === "denied") {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.needsAdmin", "Needs Admin"),
      ready: false,
    };
  }
  if (status === "not-determined") {
    return {
      variant: "outline",
      label: translate(
        t,
        "permissionssection.badge.needsApproval",
        "Needs Approval",
      ),
      ready: false,
    };
  }
  if (status === "granted" || status === "not-applicable") {
    return {
      variant: "secondary",
      label: translate(t, "permissionssection.badge.ready", "Ready"),
      ready: true,
    };
  }
  if (status === "restricted") {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.restricted", "Restricted"),
      ready: false,
    };
  }
  return {
    variant: "outline",
    label:
      platform === "darwin"
        ? translate(
            t,
            "permissionssection.badge.offInSettings",
            "Off in Settings",
          )
        : translate(t, "permissionssection.badge.off", "Off"),
    ready: false,
  };
}

export function WebsiteBlockerSettingsCard({
  mode,
  permission,
  platform,
  onOpenPermissionSettings,
  onRequestPermission,
}: WebsiteBlockerSettingsCardProps) {
  const rawT = useAppSelector((s) => s.t);
  const t = typeof rawT === "function" ? rawT : (key: string): string => key;

  const title = translate(
    t,
    "permissionssection.permission.websiteBlocking.name",
    "Website Blocking",
  );
  const description = translate(
    t,
    "permissionssection.permission.websiteBlocking.description",
    "Hosts-file blocking for distracting sites. Admin approval may be required.",
  );

  if (mode === "web" || mode === "mobile") {
    // Flat row to match the permission rows above it (no card chrome / prose).
    return (
      <div className="flex items-center gap-3 py-2.5">
        <Monitor
          className="h-[18px] w-[18px] shrink-0 text-muted/80"
          aria-hidden
        />
        <div className="min-w-0 flex-1 text-sm font-medium text-txt">
          {title}
        </div>
        <span className="text-xs text-muted">
          {translate(t, "permissionssection.desktopOnly", "Desktop only")}
        </span>
      </div>
    );
  }

  const badge = statusBadge(t, permission?.status, platform);

  const primary =
    permission &&
    permission.status !== "granted" &&
    permission.status !== "not-applicable"
      ? permission.status === "not-determined" && permission.canRequest
        ? onRequestPermission
          ? {
              label: translate(
                t,
                "permissionssection.RequestApproval",
                "Request Approval",
              ),
              action: onRequestPermission,
            }
          : null
        : onOpenPermissionSettings
          ? {
              label: translate(
                t,
                "permissionssection.OpenHostsFile",
                "Open Hosts File",
              ),
              action: onOpenPermissionSettings,
            }
          : null
      : null;

  return (
    <div className="px-1 py-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center">
            <ShieldBan className="h-5 w-5 text-txt" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">{title}</div>
              {permission ? (
                <span
                  className={`inline-flex items-center gap-1 text-xs ${
                    badge.ready ? "text-ok" : "text-muted"
                  }`}
                >
                  {badge.ready ? (
                    <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden />
                  ) : null}
                  {badge.label}
                </span>
              ) : null}
              {platform ? (
                <span className="text-xs text-muted">{platform}</span>
              ) : null}
            </div>
            <div className="max-w-2xl text-xs-tight leading-5 text-muted">
              {description}
            </div>
            {permission?.reason ? (
              <div className="text-xs text-danger">{permission.reason}</div>
            ) : null}
          </div>
        </div>
        {primary ? (
          <div className="flex shrink-0 flex-wrap gap-2 sm:pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="default"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void primary.action()}
            >
              <Settings className="mr-1.5 h-4 w-4" aria-hidden />
              {primary.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
