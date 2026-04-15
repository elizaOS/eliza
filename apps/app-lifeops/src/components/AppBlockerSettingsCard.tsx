import {
  Button,
  client,
  StatusBadge,
  translateWithFallback,
  useApp,
} from "@elizaos/app-core";
import { startTransition, useCallback, useEffect, useState } from "react";
import type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
} from "../types";

type AppBlockerStatus = Awaited<ReturnType<typeof client.getAppBlockerStatus>>;
type AppBlockerPermission = Awaited<
  ReturnType<typeof client.checkAppBlockerPermissions>
>;
type InstalledApp = Awaited<
  ReturnType<typeof client.getInstalledAppsToBlock>
>["apps"][number];

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
  mode: AppBlockerSettingsMode,
  t: (key: string) => string,
  status: AppBlockerStatus | null,
): string {
  if (mode !== "mobile") {
    return translateWithFallback(
      t,
      "permissionssection.AppBlockingDesktopDescription",
      "App blocking is only available in the native iPhone and Android builds.",
    );
  }

  if (status?.platform === "ios") {
    return translateWithFallback(
      t,
      "permissionssection.AppBlockingIOSDescription",
      "Use Apple's Family Controls picker to choose apps, then start a shield from Milady. This build supports manual unblock on iPhone; timed auto-unblock still needs the DeviceActivity extension.",
    );
  }

  if (status?.platform === "android") {
    return translateWithFallback(
      t,
      "permissionssection.AppBlockingAndroidDescription",
      "Choose installed Android apps and Milady will shield them with Usage Access plus a system overlay.",
    );
  }

  return translateWithFallback(
    t,
    "permissionssection.AppBlockingMobileDescription",
    "App blocking is available in the native mobile builds.",
  );
}

function getStatusBadge(
  status: AppBlockerStatus | null,
  t: (key: string) => string,
): { label: string; variant: "success" | "warning" | "muted" | "danger" } {
  if (!status?.available) {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.AppBlockingUnavailable",
        "Unavailable",
      ),
      variant: "muted",
    };
  }

  if (status.active) {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.AppBlockingActive",
        "Blocking",
      ),
      variant: "success",
    };
  }

  if (status.permissionStatus !== "granted") {
    return {
      label: translateWithFallback(
        t,
        "permissionssection.AppBlockingNeedsAccess",
        "Needs Access",
      ),
      variant: "warning",
    };
  }

  return {
    label: translateWithFallback(
      t,
      "permissionssection.AppBlockingReady",
      "Ready",
    ),
    variant: "warning",
  };
}

export function AppBlockerSettingsCard({ mode }: AppBlockerSettingsCardProps) {
  const { t } = useApp();
  const [status, setStatus] = useState<AppBlockerStatus | null>(null);
  const [permission, setPermission] = useState<AppBlockerPermission | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<
    "permissions" | "select" | "start" | "stop" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAndroidPackages, setSelectedAndroidPackages] = useState<
    string[]
  >([]);
  const [selectedIosApps, setSelectedIosApps] = useState<InstalledApp[]>([]);
  const [durationMinutes, setDurationMinutes] = useState("60");
  const [indefinite, setIndefinite] = useState(false);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [nextStatus, nextPermission] = await Promise.all([
        client.getAppBlockerStatus(),
        client.checkAppBlockerPermissions(),
      ]);

      const nextInstalledApps =
        nextStatus.platform === "android"
          ? (await client.getInstalledAppsToBlock()).apps
          : [];

      startTransition(() => {
        setStatus(nextStatus);
        setPermission(nextPermission);
        setInstalledApps(nextInstalledApps);
        setSelectedAndroidPackages((currentValue) =>
          currentValue.length > 0
            ? currentValue
            : nextStatus.platform === "android"
              ? nextStatus.blockedPackageNames
              : currentValue,
        );
        setIndefinite(nextStatus.active && !nextStatus.endsAt);
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.AppBlockingLoadFailed",
              "Could not load app blocker status.",
            ),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const statusBadge = getStatusBadge(status, t);
  const isIos = status?.platform === "ios";
  const isAndroid = status?.platform === "android";
  const selectedAndroidApps = installedApps.filter((app) =>
    selectedAndroidPackages.includes(app.packageName),
  );
  const filteredInstalledApps = installedApps.filter((app) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return (
      app.displayName.toLowerCase().includes(query) ||
      app.packageName.toLowerCase().includes(query)
    );
  });

  async function handleRequestPermissions(): Promise<void> {
    setActionPending("permissions");
    setError(null);

    try {
      await client.requestAppBlockerPermissions();
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.AppBlockingPermissionFailed",
              "Could not open the app blocking permission flow.",
            ),
      );
    } finally {
      setActionPending(null);
    }
  }

  async function handleSelectIosApps(): Promise<void> {
    setActionPending("select");
    setError(null);

    try {
      const result = await client.selectAppBlockerApps();
      if (!result.cancelled) {
        setSelectedIosApps(result.apps);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.AppBlockingSelectFailed",
              "Could not open the iPhone app picker.",
            ),
      );
    } finally {
      setActionPending(null);
    }
  }

  async function handleStartBlock(): Promise<void> {
    setActionPending("start");
    setError(null);

    try {
      if (isIos) {
        const tokens = selectedIosApps
          .map((app) => app.tokenData)
          .filter((token): token is string => typeof token === "string");
        if (tokens.length === 0) {
          setError(
            translateWithFallback(
              t,
              "permissionssection.AppBlockingIOSSelectionRequired",
              "Select at least one iPhone app first.",
            ),
          );
          return;
        }

        const result = await client.startAppBlock({
          appTokens: tokens,
          durationMinutes: null,
        });
        if (!result.success) {
          setError(result.error ?? "Could not start the iPhone app block.");
          return;
        }
        await refreshStatus();
        return;
      }

      if (selectedAndroidPackages.length === 0) {
        setError(
          translateWithFallback(
            t,
            "permissionssection.AppBlockingAndroidSelectionRequired",
            "Select at least one Android app first.",
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
            "permissionssection.AppBlockingDurationRequired",
            "Enter a blocking duration in minutes, or keep the block active until you stop it.",
          ),
        );
        return;
      }

      const result = await client.startAppBlock({
        packageNames: selectedAndroidPackages,
        durationMinutes: nextDuration,
      });
      if (!result.success) {
        setError(result.error ?? "Could not start the Android app block.");
        return;
      }
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.AppBlockingStartFailed",
              "Could not start the app block.",
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
      const result = await client.stopAppBlock();
      if (!result.success) {
        setError(result.error ?? "Could not stop the app block.");
        return;
      }
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : translateWithFallback(
              t,
              "permissionssection.AppBlockingStopFailed",
              "Could not stop the app block.",
            ),
      );
    } finally {
      setActionPending(null);
    }
  }

  if (mode !== "mobile") {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-4 shadow-sm">
        <div className="space-y-1">
          <div className="font-bold text-sm text-txt">
            {translateWithFallback(
              t,
              "permissionssection.AppBlockingTitle",
              "App Blocker",
            )}
          </div>
          <p className="text-xs-tight leading-5 text-muted">
            {translateWithFallback(
              t,
              "permissionssection.AppBlockingMobileOnly",
              "App blocking is only available in the native iPhone and Android builds.",
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card/92 shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border/50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-bold text-sm text-txt">
              {translateWithFallback(
                t,
                "permissionssection.AppBlockingTitle",
                "App Blocker",
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
          {permission?.status !== "granted" ? (
            <Button
              variant="default"
              size="sm"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleRequestPermissions()}
              disabled={actionPending !== null}
            >
              {actionPending === "permissions"
                ? translateWithFallback(
                    t,
                    "permissionssection.AppBlockingOpeningSettings",
                    "Opening...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingGrantAccess",
                    "Grant Access",
                  )}
            </Button>
          ) : null}
          {isIos && !status?.active ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleSelectIosApps()}
              disabled={actionPending !== null}
            >
              {actionPending === "select"
                ? translateWithFallback(
                    t,
                    "permissionssection.AppBlockingSelecting",
                    "Opening Picker...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingSelectApps",
                    "Select Apps",
                  )}
            </Button>
          ) : null}
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
                    "permissionssection.AppBlockingStopping",
                    "Stopping...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingStop",
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
                status?.available === false ||
                permission?.status !== "granted" ||
                (isIos
                  ? selectedIosApps.length === 0
                  : selectedAndroidPackages.length === 0)
              }
            >
              {actionPending === "start"
                ? translateWithFallback(
                    t,
                    "permissionssection.AppBlockingStarting",
                    "Starting...",
                  )
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingStart",
                    "Start Block",
                  )}
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {isAndroid ? (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-2">
              <label className="space-y-1">
                <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                  {translateWithFallback(
                    t,
                    "permissionssection.AppBlockingSearch",
                    "Search Apps",
                  )}
                </span>
                <input
                  type="text"
                  className="min-h-11 w-full rounded-xl border border-border/60 bg-card/96 px-3 py-2 text-sm text-txt shadow-sm"
                  placeholder={translateWithFallback(
                    t,
                    "permissionssection.AppBlockingSearchPlaceholder",
                    "Search by app name or package",
                  )}
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </label>

              <div className="max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-card/96">
                {filteredInstalledApps.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-muted">
                    {translateWithFallback(
                      t,
                      "permissionssection.AppBlockingNoApps",
                      "No installed Android apps matched your search.",
                    )}
                  </div>
                ) : (
                  filteredInstalledApps.map((app) => {
                    const checked = selectedAndroidPackages.includes(
                      app.packageName,
                    );
                    return (
                      <label
                        key={app.packageName}
                        className="flex cursor-pointer items-start gap-3 border-b border-border/40 px-3 py-3 text-sm last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedAndroidPackages((currentValue) =>
                              event.target.checked
                                ? [...currentValue, app.packageName]
                                : currentValue.filter(
                                    (packageName) =>
                                      packageName !== app.packageName,
                                  ),
                            );
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block font-medium text-txt">
                            {app.displayName}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {app.packageName}
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-3">
              <label className="space-y-1">
                <span className="text-xs-tight font-semibold uppercase tracking-[0.08em] text-muted">
                  {translateWithFallback(
                    t,
                    "permissionssection.AppBlockingDuration",
                    "Duration (minutes)",
                  )}
                </span>
                <input
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
                  type="checkbox"
                  checked={indefinite}
                  onChange={(event) => setIndefinite(event.target.checked)}
                />
                <span>
                  {translateWithFallback(
                    t,
                    "permissionssection.AppBlockingIndefinite",
                    "Keep blocking until I stop it",
                  )}
                </span>
              </label>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-xl border border-border/50 bg-bg-hover/70 px-3 py-3 text-xs-tight leading-5 text-muted">
              {translateWithFallback(
                t,
                "permissionssection.AppBlockingIOSHelp",
                "Use Select Apps to open Apple's picker. After you close the picker, start the block from here. This first pass supports manual unblock on iPhone; timed auto-unblock still needs the DeviceActivity monitor extension.",
              )}
            </div>
            <div className="grid gap-2 text-xs-tight text-muted sm:grid-cols-2">
              <div>
                <span className="font-semibold text-muted-strong">
                  {translateWithFallback(
                    t,
                    "permissionssection.AppBlockingSelectedApps",
                    "Selected apps:",
                  )}{" "}
                </span>
                {selectedIosApps.length > 0
                  ? String(selectedIosApps.length)
                  : translateWithFallback(
                      t,
                      "permissionssection.AppBlockingNoneSelected",
                      "None",
                    )}
              </div>
              <div>
                <span className="font-semibold text-muted-strong">
                  {translateWithFallback(
                    t,
                    "permissionssection.AppBlockingCurrentBlock",
                    "Current block:",
                  )}{" "}
                </span>
                {status?.blockedCount ?? 0}
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-2 text-xs-tight text-muted sm:grid-cols-2">
          <div>
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.AppBlockingEngine",
                "Engine:",
              )}{" "}
            </span>
            {status?.engine ?? "none"}
          </div>
          <div>
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.AppBlockingEndsAt",
                "Ends:",
              )}{" "}
            </span>
            {formatBlockEndsAt(status?.endsAt ?? null)}
          </div>
          <div className="sm:col-span-2">
            <span className="font-semibold text-muted-strong">
              {translateWithFallback(
                t,
                "permissionssection.AppBlockingTargets",
                "Current targets:",
              )}{" "}
            </span>
            {isAndroid
              ? selectedAndroidApps.length > 0
                ? selectedAndroidApps.map((app) => app.displayName).join(", ")
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingNone",
                    "None",
                  )
              : status?.blockedCount
                ? `${status.blockedCount} app${status.blockedCount === 1 ? "" : "s"}`
                : translateWithFallback(
                    t,
                    "permissionssection.AppBlockingNone",
                    "None",
                  )}
          </div>
        </div>

        {permission?.reason ? (
          <div className="rounded-xl border border-border/50 bg-bg-hover/70 px-3 py-2 text-xs-tight leading-5 text-muted">
            {permission.reason}
          </div>
        ) : null}

        {status?.reason ? (
          <div className="rounded-xl border border-border/50 bg-bg-hover/70 px-3 py-2 text-xs-tight leading-5 text-muted">
            {status.reason}
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
