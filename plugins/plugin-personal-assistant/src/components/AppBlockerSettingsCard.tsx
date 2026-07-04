import { Button, client, Input } from "@elizaos/ui";
import { useAppSelector } from "@elizaos/ui/state";
import {
  CheckCircle2,
  Clock3,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  ShieldBan,
  Smartphone,
  Sparkles,
  Square,
  Timer,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { AppBlockerSettingsCardProps } from "../types/app-blocker-settings-card";

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
): { variant: "secondary" | "outline"; label: string; ready: boolean } {
  if (!permission) {
    return {
      variant: "outline",
      label: translate(t, "permissionssection.badge.unknown", "Unknown"),
      ready: false,
    };
  }
  if (permission.status === "granted") {
    return {
      variant: "secondary",
      label: translate(t, "permissionssection.badge.ready", "Ready"),
      ready: true,
    };
  }
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

function AppBlockerStatusIcon({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center py-4 text-muted"
      role="status"
      aria-label={label}
      title={label}
    >
      <Sparkles className="h-4 w-4 opacity-70" aria-hidden />
      <span className="sr-only">{label}</span>
    </div>
  );
}

function inputIdForPackageName(packageName: string): string {
  return `app-blocker-package-${packageName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function AppBlockerSettingsCard({ mode }: AppBlockerSettingsCardProps) {
  const rawT = useAppSelector((s) => s.t);
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
            response.apps.some(
              (app: AppBlockerInstalledApp) => app.packageName === packageName,
            ),
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
      <div className="px-1 py-2">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center">
            <Smartphone className="h-5 w-5 text-muted" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-bold text-sm text-txt">{title}</div>
              <span className="text-xs text-muted">
                {translate(t, "permissionssection.mobileOnly", "Mobile only")}
              </span>
            </div>
            <div className="text-xs-tight leading-5 text-muted">
              {translate(
                t,
                "permissionssection.appBlocking.mobileOnly",
                "Open on iPhone or Android to choose apps and start a focus shield.",
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

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
              {status?.platform ? (
                <span className="text-xs text-muted">
                  {status.platform.toUpperCase()}
                </span>
              ) : null}
              {status?.active ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  <Timer className="mr-1 h-3 w-3" aria-hidden />
                  {translate(
                    t,
                    "permissionssection.appBlocking.active",
                    "Blocking",
                  )}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2 text-xs-tight text-muted">
              <span>
                {status?.platform === "ios"
                  ? translate(
                      t,
                      "permissionssection.appBlocking.iosDescription",
                      "Family Controls shield for selected iPhone apps.",
                    )
                  : translate(
                      t,
                      "permissionssection.appBlocking.androidDescription",
                      "Usage Access shield for selected Android apps.",
                    )}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-xs text-muted">
                <ListChecks className="h-3.5 w-3.5" aria-hidden />
                {status?.active
                  ? `${status.blockedCount}`
                  : `${selectedPackageNames.length + selectedIosApps.length}`}{" "}
                {translate(t, "permissionssection.appBlocking.apps", "apps")}
              </span>
              {status?.active && status.endsAt ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden />
                  {formatEndsAt(status.endsAt)}
                </span>
              ) : null}
            </div>
            {error ? <div className="text-xs text-danger">{error}</div> : null}
            {!error && permission?.reason ? (
              <div className="text-xs text-danger">{permission.reason}</div>
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
            aria-label={translate(t, "common.refresh", "Refresh")}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden />
            )}
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
              <CheckCircle2 className="mr-1.5 h-4 w-4" aria-hidden />
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
              <Square className="mr-1.5 h-4 w-4" aria-hidden />
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
        <div className="py-3 text-xs-tight text-muted">
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
        <div className="py-3">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-3">
              <label htmlFor="app-blocker-search" className="block">
                <span
                  id="app-blocker-search-label"
                  className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  {translate(
                    t,
                    "permissionssection.appBlocking.search",
                    "Search Apps",
                  )}
                </span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <Input
                    id="app-blocker-search"
                    aria-labelledby="app-blocker-search-label"
                    value={query}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setQuery(event.target.value)
                    }
                    placeholder={translate(
                      t,
                      "permissionssection.appBlocking.searchPlaceholder",
                      "Search installed apps",
                    )}
                    className="w-full rounded-xl border border-border/60 bg-bg/60 py-2 pl-9 pr-3 text-sm text-txt outline-none transition focus:border-border"
                  />
                </div>
              </label>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {filteredApps.map((app) => {
                  const checked = selectedPackageNames.includes(
                    app.packageName,
                  );
                  const inputId = inputIdForPackageName(app.packageName);
                  return (
                    <label
                      htmlFor={inputId}
                      key={app.packageName}
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2 text-sm transition hover:bg-bg/50"
                    >
                      <Input
                        id={inputId}
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePackageName(app.packageName)}
                        className="mt-0.5 h-4 w-4 rounded border-border p-0"
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
                  <AppBlockerStatusIcon
                    label={translate(
                      t,
                      "permissionssection.appBlocking.noApps",
                      "Apps clear",
                    )}
                  />
                ) : null}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {translate(
                    t,
                    "permissionssection.appBlocking.selection",
                    "Selection",
                  )}
                </div>
                <div className="mt-1 text-sm text-txt">
                  {selectedPackageNames.length} app
                  {selectedPackageNames.length === 1 ? "" : "s"} selected
                </div>
              </div>
              <label
                htmlFor="app-blocker-indefinite"
                className="flex items-center gap-2 text-sm text-txt"
              >
                <Input
                  id="app-blocker-indefinite"
                  type="checkbox"
                  checked={indefinite}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setIndefinite(event.target.checked)
                  }
                  className="h-4 w-4 rounded border-border p-0"
                />
                {translate(
                  t,
                  "permissionssection.appBlocking.indefinite",
                  "Block until I stop it",
                )}
              </label>
              <label htmlFor="app-blocker-duration" className="block">
                <span
                  id="app-blocker-duration-label"
                  className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted"
                >
                  {translate(
                    t,
                    "permissionssection.appBlocking.duration",
                    "Minutes",
                  )}
                </span>
                <Input
                  id="app-blocker-duration"
                  aria-labelledby="app-blocker-duration-label"
                  type="number"
                  min={1}
                  step={1}
                  value={durationMinutes}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDurationMinutes(event.target.value)
                  }
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
                <ShieldBan className="mr-1.5 h-4 w-4" aria-hidden />
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
        <div className="py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                {translate(
                  t,
                  "permissionssection.appBlocking.selection",
                  "Selection",
                )}
              </div>
              <div className="text-sm text-txt">
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
                        "Selection clear",
                      )}
              </div>
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
                <ListChecks className="mr-1.5 h-4 w-4" aria-hidden />
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
                <ShieldBan className="mr-1.5 h-4 w-4" aria-hidden />
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
