import { Badge, Button, client, useApp } from "@elizaos/ui";
import { Search, ShieldBan, Smartphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppBlockerSettingsCardProps } from "../types";

type AppBlockerPermission = Awaited<
  ReturnType<typeof client.checkAppBlockerPermissions>
>;
type AppBlockerStatus = Awaited<ReturnType<typeof client.getAppBlockerStatus>>;
type AppBlockerInstalledApp = Awaited<
  ReturnType<typeof client.getInstalledAppsToBlock>
>["apps"][number];

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
  permission: AppBlockerPermission | null,
): { variant: "secondary" | "outline"; label: string } {
  if (!permission) {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.unknown", "Unknown"),
    };
  }
  if (permission.status === "granted") {
    return {
      variant: "secondary",
      label: translate(t, "permissionssection.badge.ready", "Ready"),
    };
  }
  return {
    variant: "outline",
    label: translate(
      t,
      "permissionssection.badge.needsApproval",
      "Needs Approval",
    ),
  };
}

function formatEndsAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function AppBlockerSettingsCard({ mode }: AppBlockerSettingsCardProps) {
  const { t: rawT } = useApp();
  const t = typeof rawT === "function" ? rawT : (key: string): string => key;

  const [permission, setPermission] = useState<AppBlockerPermission | null>(
    null,
  );
  const [status, setStatus] = useState<AppBlockerStatus | null>(null);
  const [installedApps, setInstalledApps] = useState<AppBlockerInstalledApp[]>(
    [],
  );
  const [selectedPackageNames, setSelectedPackageNames] = useState<string[]>(
    [],
  );
  const [selectedIosApps, setSelectedIosApps] = useState<
    AppBlockerInstalledApp[]
  >([]);
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [indefinite, setIndefinite] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(mode === "mobile");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshState = useCallback(async () => {
    if (mode !== "mobile") {
      return;
    }

    setLoading(true);
    try {
      const [nextPermission, nextStatus] = await Promise.all([
        client.checkAppBlockerPermissions(),
        client.getAppBlockerStatus(),
      ]);
      setPermission(nextPermission);
      setStatus(nextStatus);

      if (
        nextStatus.platform === "android" &&
        nextPermission.status === "granted"
      ) {
        const response = await client.getInstalledAppsToBlock();
        setInstalledApps(response.apps);
        setSelectedPackageNames((current) =>
          current.filter((packageName) =>
            response.apps.some((app) => app.packageName === packageName),
          ),
        );
      } else {
        setInstalledApps([]);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to load the mobile app blocker state.",
      );
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const filteredApps = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return installedApps;
    }
    return installedApps.filter((app) => {
      return (
        app.displayName.toLowerCase().includes(normalizedQuery) ||
        app.packageName.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [installedApps, query]);

  const togglePackageName = useCallback((packageName: string) => {
    setSelectedPackageNames((current) =>
      current.includes(packageName)
        ? current.filter((value) => value !== packageName)
        : [...current, packageName],
    );
  }, []);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The app blocker action failed.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRequestPermissions = useCallback(() => {
    return runAction(async () => {
      await client.requestAppBlockerPermissions();
      await refreshState();
    });
  }, [refreshState, runAction]);

  const handleSelectIosApps = useCallback(() => {
    return runAction(async () => {
      const response = await client.selectAppBlockerApps();
      if (!response.cancelled) {
        setSelectedIosApps(response.apps);
      }
    });
  }, [runAction]);

  const handleStartBlock = useCallback(() => {
    return runAction(async () => {
      if (status?.platform === "android") {
        const result = await client.startAppBlock({
          packageNames: selectedPackageNames,
          durationMinutes: indefinite
            ? null
            : Number.parseInt(durationMinutes, 10),
        });
        if (!result.success) {
          throw new Error(
            result.error ?? "Unable to start the Android app block.",
          );
        }
      } else {
        const result = await client.startAppBlock({
          appTokens: selectedIosApps
            .map((app) => app.tokenData)
            .filter((tokenData): tokenData is string => Boolean(tokenData)),
        });
        if (!result.success) {
          throw new Error(
            result.error ?? "Unable to start the iPhone app block.",
          );
        }
      }
      await refreshState();
    });
  }, [
    durationMinutes,
    indefinite,
    refreshState,
    runAction,
    selectedIosApps,
    selectedPackageNames,
    status?.platform,
  ]);

  const handleStopBlock = useCallback(() => {
    return runAction(async () => {
      const result = await client.stopAppBlock();
      if (!result.success) {
        throw new Error(result.error ?? "Unable to stop the app block.");
      }
      await refreshState();
    });
  }, [refreshState, runAction]);

  const badge = statusBadge(t, permission);
  const title = translate(
    t,
    "permissionssection.permission.appBlocking.name",
    "App Blocking",
  );

  if (mode !== "mobile") {
    return (
      <div className="rounded-2xl border border-border/60 bg-card/92 px-4 py-4 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-bg/40">
            <Smartphone className="h-5 w-5 text-muted" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="font-bold text-sm text-txt">{title}</div>
            <p className="text-xs-tight leading-5 text-muted">
              {translate(
                t,
                "permissionssection.appBlocking.mobileOnly",
                "App blocking is a mobile feature. Open this screen on iPhone or Android to choose apps and start a focus shield.",
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

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
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {status?.platform ? (
                <Badge variant="outline">{status.platform.toUpperCase()}</Badge>
              ) : null}
              {status?.active ? (
                <Badge variant="secondary">
                  {translate(
                    t,
                    "permissionssection.appBlocking.active",
                    "Blocking",
                  )}
                </Badge>
              ) : null}
            </div>
            <p className="max-w-2xl text-xs-tight leading-5 text-muted">
              {status?.platform === "ios"
                ? translate(
                    t,
                    "permissionssection.appBlocking.iosDescription",
                    "Use Family Controls to shield selected apps on this iPhone. Current iPhone blocks are manual until the timed DeviceActivity extension lands.",
                  )
                : translate(
                    t,
                    "permissionssection.appBlocking.androidDescription",
                    "Use Usage Access and a full-screen shield overlay to block selected Android apps during a focus session.",
                  )}
            </p>
            {status?.active ? (
              <p className="text-xs-tight leading-5 text-muted">
                {status.platform === "ios"
                  ? `Currently shielding ${status.blockedCount} app${status.blockedCount === 1 ? "" : "s"}.`
                  : `Currently blocking ${status.blockedCount} app${status.blockedCount === 1 ? "" : "s"}${
                      status.endsAt
                        ? ` until ${formatEndsAt(status.endsAt)}.`
                        : "."
                    }`}
              </p>
            ) : null}
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            {!error && permission?.reason ? (
              <p className="text-xs text-danger">{permission.reason}</p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:pt-0.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
            onClick={() => void refreshState()}
            disabled={loading || busy}
          >
            {loading
              ? translate(t, "common.loading", "Loading…")
              : translate(t, "common.refresh", "Refresh")}
          </Button>
          {permission?.status !== "granted" ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleRequestPermissions()}
              disabled={busy}
            >
              {translate(
                t,
                "permissionssection.RequestApproval",
                "Request Approval",
              )}
            </Button>
          ) : null}
          {status?.active ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
              onClick={() => void handleStopBlock()}
              disabled={busy}
            >
              {translate(
                t,
                "permissionssection.appBlocking.stop",
                "Stop Block",
              )}
            </Button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="border-t border-border/50 px-4 py-4 text-xs-tight text-muted">
          {translate(
            t,
            "permissionssection.LoadingPermissions",
            "Loading permissions...",
          )}
        </div>
      ) : null}

      {!loading &&
      permission?.status === "granted" &&
      status?.platform === "android" ? (
        <div className="border-t border-border/50 px-4 py-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-3">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted">
                  {translate(
                    t,
                    "permissionssection.appBlocking.search",
                    "Search Apps",
                  )}
                </span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={translate(
                      t,
                      "permissionssection.appBlocking.searchPlaceholder",
                      "Search installed apps",
                    )}
                    className="w-full rounded-xl border border-border/60 bg-bg/60 py-2 pl-9 pr-3 text-sm text-txt outline-none transition focus:border-border"
                  />
                </div>
              </label>
              <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border/60 bg-bg/25 p-2">
                {filteredApps.map((app) => {
                  const checked = selectedPackageNames.includes(
                    app.packageName,
                  );
                  return (
                    <label
                      key={app.packageName}
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-bg/50"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePackageName(app.packageName)}
                        className="mt-0.5 h-4 w-4 rounded border-border"
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
                })}
                {filteredApps.length === 0 ? (
                  <div className="px-3 py-4 text-center text-xs text-muted">
                    {translate(
                      t,
                      "permissionssection.appBlocking.noApps",
                      "No installed apps matched that search.",
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-border/60 bg-bg/25 p-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {translate(
                    t,
                    "permissionssection.appBlocking.selection",
                    "Selection",
                  )}
                </div>
                <p className="mt-1 text-sm text-txt">
                  {selectedPackageNames.length} app
                  {selectedPackageNames.length === 1 ? "" : "s"} selected
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm text-txt">
                <input
                  type="checkbox"
                  checked={indefinite}
                  onChange={(event) => setIndefinite(event.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                {translate(
                  t,
                  "permissionssection.appBlocking.indefinite",
                  "Block until I stop it",
                )}
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted">
                  {translate(
                    t,
                    "permissionssection.appBlocking.duration",
                    "Minutes",
                  )}
                </span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={durationMinutes}
                  onChange={(event) => setDurationMinutes(event.target.value)}
                  disabled={indefinite}
                  className="w-full rounded-xl border border-border/60 bg-bg/60 px-3 py-2 text-sm text-txt outline-none transition focus:border-border disabled:opacity-60"
                />
              </label>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="min-h-10 w-full rounded-xl px-3 text-xs-tight font-semibold"
                onClick={() => void handleStartBlock()}
                disabled={busy || selectedPackageNames.length === 0}
              >
                {translate(
                  t,
                  "permissionssection.appBlocking.start",
                  "Start Block",
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!loading &&
      permission?.status === "granted" &&
      status?.platform === "ios" ? (
        <div className="border-t border-border/50 px-4 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                {translate(
                  t,
                  "permissionssection.appBlocking.selection",
                  "Selection",
                )}
              </div>
              <p className="text-sm text-txt">
                {selectedIosApps.length > 0
                  ? `${selectedIosApps.length} app${
                      selectedIosApps.length === 1 ? "" : "s"
                    } selected`
                  : status.active
                    ? `${status.blockedCount} app${
                        status.blockedCount === 1 ? "" : "s"
                      } currently shielded`
                    : translate(
                        t,
                        "permissionssection.appBlocking.noneSelected",
                        "No iPhone apps selected yet.",
                      )}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                onClick={() => void handleSelectIosApps()}
                disabled={busy}
              >
                {translate(
                  t,
                  "permissionssection.appBlocking.chooseApps",
                  "Choose Apps",
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="default"
                className="min-h-10 rounded-xl px-3 text-xs-tight font-semibold"
                onClick={() => void handleStartBlock()}
                disabled={busy || selectedIosApps.length === 0}
              >
                {translate(
                  t,
                  "permissionssection.appBlocking.start",
                  "Start Block",
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
