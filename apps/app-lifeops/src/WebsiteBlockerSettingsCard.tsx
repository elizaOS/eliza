import { Button, StatusBadge } from "@elizaos/app-core";
import { startTransition, useCallback, useEffect, useState } from "react";
import { client } from "@elizaos/app-core";
import { useApp } from "@elizaos/app-core";
import type { PermissionState } from "@elizaos/shared/contracts/permissions";
import type {
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types";
import {
  getPermissionAction,
  translateWithFallback,
} from "@elizaos/app-core";

type WebsiteBlockerStatus = Awaited<
  ReturnType<typeof client.getWebsiteBlockerStatus>
>;

function parseWebsiteTargets(input: string): string[] {
  return input
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

function formatBlockEndsAt(endsAt: string | null): string {
  if (!endsAt) {
    return "Until you stop it";
  }

  const date = new Date(endsAt);
  if (Number.isNaN(date.getTime())) {
    return endsAt;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function getModeDescription(
  mode: WebsiteBlockerSettingsMode,
  t: (key: string) => string,
  status: WebsiteBlockerStatus | null,
): string {
  switch (mode) {
    case "desktop":
      return translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingDesktopDescription",
        "Manage website blocking for this machine from the app. Blocks are applied by the connected local runtime.",
      );
    case "mobile":
      if (status?.platform === "android" && status.available) {
        return translateWithFallback(
          t,
          "permissionssection.WebsiteBlockingMobileAndroidDescription",
          "Manage website blocking on this Android device. The app uses a local VPN DNS profile to block the selected hostnames across apps.",
        );
      }
      if (status?.platform === "ios") {
        return translateWithFallback(
          t,
          "permissionssection.WebsiteBlockingMobileIOSDescription",
          "Manage website blocking in Safari on this iPhone or iPad. The app uses a native Safari content blocker extension and can keep the block list in sync from the app once the extension is enabled in Settings > Safari > Extensions.",
        );
      }
      return translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingMobileDescription",
        "Manage website blocking from mobile with the native platform-specific blocker integration.",
      );
    default:
      return translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingWebDescription",
        "Manage website blocking on the connected runtime from the web app.",
      );
  }
}

function getStatusBadge(
  status: WebsiteBlockerStatus | null,
  t: (key: string) => string,
): { label: string; variant: "success" | "warning" | "muted" | "danger" } {
  if (!status?.available) {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingUnavailable",
        "Unavailable",
      ),
      variant: "muted",
    };
  }

  if (status.active) {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingActive",
        "Blocking",
      ),
      variant: "success",
    };
  }

  if (status.requiresElevation) {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.WebsiteBlockingNeedsApproval",
        "Needs Approval",
      ),
      variant: "warning",
    };
  }

  return {
    label: translateWithFallback(
      t,
      "permissionssection.WebsiteBlockingReady",
      "Ready",
    ),
    variant: "warning",
  };
}

export function WebsiteBlockerSettingsCard({
  mode,
  permission,
  platform,
  onOpenPermissionSettings,
  onRequestPermission,
}: WebsiteBlockerSettingsCardProps) {
  const { t } = useApp();
  const [status, setStatus] = useState<WebsiteBlockerStatus | null>(null);
  const [resolvedPermission, setResolvedPermission] =
    useState<PermissionState | null>(permission ?? null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<"start" | "stop" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [websiteInput, setWebsiteInput] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [indefinite, setIndefinite] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [nextStatus, nextPermission] = await Promise.all([
        client.getWebsiteBlockerStatus(),
        permission
          ? Promise.resolve(permission)
          : client.getPermission("website-blocking"),
      ]);
      startTransition(() => {
        setStatus(nextStatus);
        setResolvedPermission(nextPermission);
        setWebsiteInput((currentValue) => {
          if (!nextStatus.active || currentValue.trim().length > 0) {
            return currentValue;
          }
          return nextStatus.websites.join("\n");
        });
        setIndefinite(nextStatus.active && !nextStatus.endsAt);
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.WebsiteBlockingLoadFailed",
              "Could not load website blocker status.",
            ),
      );
    } finally {
      setLoading(false);
    }
  }, [permission, t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const effectivePermission = permission ?? resolvedPermission;
  const permissionPlatform = platform ?? status?.platform;

  const permissionAction = effectivePermission
    ? getPermissionAction(
        t,
        "website-blocking",
        effectivePermission.status,
        effectivePermission.canRequest,
        permissionPlatform,
      )
    : null;

  const statusBadge = getStatusBadge(status, t);

  async function handleStartBlock(): Promise<void> {
    const websites = parseWebsiteTargets(websiteInput);
    if (websites.length === 0) {
      setError(
        translateWithFallback(
          t,
          "permissionssection.WebsiteBlockingHostnameRequired",
          "Enter at least one website hostname such as x.com or twitter.com.",
        ),
      );
      return;
    }

    const nextDuration = indefinite ? null : Number(durationMinutes);
    const parsedDuration =
      typeof nextDuration === "number" ? nextDuration : Number.NaN;
    if (
      !indefinite &&
      (!Number.isFinite(parsedDuration) || parsedDuration <= 0)
    ) {
      setError(
        translateWithFallback(
          t,
          "permissionssection.WebsiteBlockingDurationRequired",
          "Enter a blocking duration in minutes, or keep the block active until you stop it.",
        ),
      );
      return;
    }

    setActionPending("start");
    setError(null);

    try {
      const result = await client.startWebsiteBlock({
        websites,
        durationMinutes: nextDuration,
        text: websiteInput,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.WebsiteBlockingStartFailed",
              "Could not start the website block.",
            ),
      );
    } finally {
      setActionPending(null);
    }
  }

  async function handleStopBlock(): Promise<void> {
    setActionPending("stop");
    setError(null);

    try {
      const result = await client.stopWebsiteBlock();
      if (!result.success) {
        setError(result.error);
        return;
      }
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.WebsiteBlockingStopFailed",
              "Could not stop the website block.",
            ),
      );
    } finally {
      setActionPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card/92 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-bold text-sm text-txt">
              {translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingTitle",
                "Website Blocker",
              )}
            </div>
            <StatusBadge
              label={statusBadge.label}
              variant={statusBadge.variant}
            />
          </div>
          <div className="max-w-2xl text-xs-tight leading-5 text-muted">
            {getModeDescription(mode, t, status)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="website-blocker-refresh-button"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() => void refreshStatus()}
            disabled={loading || actionPending !== null}
          >
            {loading
              ? translateWithFallback(
                  t,
                  "permissionssection.Refreshing",
                  "Refreshing...",
                )
              : translateWithFallback(t, "common.refresh", "Refresh")}
          </Button>
          {status?.active ? (
            <Button
              variant="default"
              size="sm"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleStopBlock()}
              disabled={actionPending !== null}
            >
              {actionPending === "stop"
                ? translateWithFallback(
                    t,
                    "permissionssection.WebsiteBlockingStopping",
                    "Stopping...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.WebsiteBlockingStop",
                    "Stop Block",
                  )}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleStartBlock()}
              disabled={
                actionPending !== null ||
                websiteInput.trim().length === 0 ||
                status?.available === false
              }
            >
              {actionPending === "start"
                ? translateWithFallback(
                    t,
                    "permissionssection.WebsiteBlockingStarting",
                    "Starting...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.WebsiteBlockingStart",
                    "Start Block",
                  )}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <label className="space-y-1">
            <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
              {translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingTargets",
                "Websites",
              )}
            </span>
            <textarea
              data-testid="website-blocker-input"
              className="min-h-24 w-full rounded-xl border border-border/60 bg-card/96 px-3 py-2 text-sm text-txt shadow-sm"
              placeholder={translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingTargetsPlaceholder",
                "x.com\ntwitter.com",
              )}
              value={websiteInput}
              onChange={(event) => setWebsiteInput(event.target.value)}
            />
          </label>

          <div className="space-y-3">
            <label className="space-y-1">
              <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                {translateWithFallback(
                  t,
                  "permissionssection.WebsiteBlockingDuration",
                  "Duration (minutes)",
                )}
              </span>
              <input
                data-testid="website-blocker-duration"
                type="number"
                min={1}
                max={10080}
                className="min-h-11 w-full rounded-xl border border-border/60 bg-card/96 px-3 py-2 text-sm text-txt shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
                value={durationMinutes}
                disabled={indefinite}
                onChange={(event) => setDurationMinutes(event.target.value)}
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                data-testid="website-blocker-indefinite"
                type="checkbox"
                checked={indefinite}
                onChange={(event) => setIndefinite(event.target.checked)}
              />
              <span>
                {translateWithFallback(
                  t,
                  "permissionssection.WebsiteBlockingIndefinite",
                  "Keep blocking until I stop it",
                )}
              </span>
            </label>
          </div>
        </div>

        <div className="grid gap-2 text-xs-tight text-muted sm:grid-cols-2">
          <div>
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingEngine",
                "Engine:",
              )}{" "}
            </span>
            {status?.engine ?? "hosts-file"}
          </div>
          <div>
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingEndsAt",
                "Ends:",
              )}{" "}
            </span>
            {formatBlockEndsAt(status?.endsAt ?? null)}
          </div>
          <div className="sm:col-span-2">
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.WebsiteBlockingCurrentTargets",
                "Current targets:",
              )}{" "}
            </span>
            {status?.websites?.length
              ? status.websites.join(", ")
              : translateWithFallback(
                  t,
                  "permissionssection.WebsiteBlockingNone",
                  "None",
                )}
          </div>
        </div>

        {status?.reason ? (
          <div className="rounded-xl border border-border/50 bg-bg-hover/70 px-3 py-2 text-xs-tight leading-5 text-muted">
            {status.reason}
          </div>
        ) : null}

        {permission && permission.status !== "granted" && permissionAction ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/50 bg-bg-hover/70 px-3 py-2 text-xs-tight text-muted">
            <span className="flex-1">
              {permission.reason ??
                translateWithFallback(
                  t,
                  "permissionssection.WebsiteBlockingPermissionHelp",
                  "Website blocking may need administrator or root approval on this machine.",
                )}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="min-h-9 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={async () => {
                if (permissionAction.type === "request") {
                  if (onRequestPermission) {
                    await onRequestPermission();
                  } else {
                    await client.requestPermission("website-blocking");
                  }
                } else if (onOpenPermissionSettings) {
                  await onOpenPermissionSettings();
                } else {
                  await client.openPermissionSettings("website-blocking");
                }
                await refreshStatus();
              }}
            >
              {permissionAction.label}
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs-tight leading-5 text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
