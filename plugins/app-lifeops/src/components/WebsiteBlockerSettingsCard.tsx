import { Badge, Button, useApp } from "@elizaos/ui";
import type { PermissionStatus } from "@elizaos/shared";
import { ShieldBan } from "lucide-react";
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
): { variant: "secondary" | "outline"; label: string } {
  if (!status) {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.unknown", "Unknown"),
    };
  }
  if (status === "denied") {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.needsAdmin", "Needs Admin"),
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
    };
  }
  if (status === "granted" || status === "not-applicable") {
    return {
      variant: "secondary",
      label: translate(t, "permissionssection.badge.ready", "Ready"),
    };
  }
  if (status === "restricted") {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.restricted", "Restricted"),
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
    "Edit the system hosts file to block distracting websites. This may require admin or root approval each time.",
  );

  if (mode === "web" || mode === "mobile") {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg/40">
            <ShieldBan className="h-5 w-5 text-muted" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="font-bold text-sm text-txt">{title}</div>
            <p className="text-xs-tight leading-5 text-muted">
              {mode === "web"
                ? translate(
                    t,
                    "permissionssection.websiteBlocking.webInfo",
                    "Hosts-file website blocking runs in the desktop app. Use Eliza on macOS, Windows, or Linux to enable SelfControl-style blocking for your agent.",
                  )
                : translate(
                    t,
                    "permissionssection.websiteBlocking.mobileInfo",
                    "Website blocking via the system hosts file is a desktop feature. Install the desktop build to manage blocked sites for LifeOps.",
                  )}
            </p>
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
    <div className="rounded-2xl border border-border/60 bg-card/92 shadow-sm">
      <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg/40">
            <ShieldBan className="h-5 w-5 text-txt" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">{title}</div>
              {permission ? (
                <Badge variant={badge.variant}>{badge.label}</Badge>
              ) : null}
            </div>
            <p className="max-w-2xl text-xs-tight leading-5 text-muted">
              {description}
            </p>
            {permission?.reason ? (
              <p className="text-xs text-danger">{permission.reason}</p>
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
              {primary.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
