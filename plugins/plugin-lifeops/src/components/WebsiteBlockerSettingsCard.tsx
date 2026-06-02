import type { PermissionStatus } from "@elizaos/shared";
import { Badge, Button, useApp } from "@elizaos/ui";
import { CheckCircle2, Monitor, Settings, ShieldBan } from "lucide-react";
import type { WebsiteBlockerSettingsCardProps } from "../types";

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
  const { t: rawT } = useApp();
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
    return (
      <div className="rounded-xl border border-border/60 bg-card/92 px-4 py-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/40">
            <Monitor className="h-5 w-5 text-muted" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">{title}</div>
              <Badge variant="outline">
                {translate(t, "permissionssection.desktopOnly", "Desktop only")}
              </Badge>
            </div>
            <div className="text-xs-tight leading-5 text-muted">
              {mode === "web"
                ? translate(
                    t,
                    "permissionssection.websiteBlocking.webInfo",
                    "Use the desktop app to manage system hosts blocking.",
                  )
                : translate(
                    t,
                    "permissionssection.websiteBlocking.mobileInfo",
                    "Install the desktop build to manage blocked sites.",
                  )}
            </div>
          </div>
        </div>
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
    <div className="rounded-xl border border-border/60 bg-card/92 shadow-sm">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/40">
            <ShieldBan className="h-5 w-5 text-txt" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">{title}</div>
              {permission ? (
                <Badge variant={badge.variant}>
                  {badge.ready ? (
                    <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden />
                  ) : null}
                  {badge.label}
                </Badge>
              ) : null}
              {platform ? <Badge variant="outline">{platform}</Badge> : null}
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
