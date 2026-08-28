/**
 * Apps hub collection for installed and available apps, including lifecycle,
 * filtering, creation, and local-directory loading controls.
 */

import { Loader2, Play, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  AppRunSummary,
  AppStopResult,
  InstalledAppInfo,
  RegistryAppInfo,
} from "../../api/client-types-cloud";
import { useAppSelector } from "../../state";
import { ContentState } from "../composites/page-panel";
import { Button } from "../ui/button";
import { SettingsInput } from "../ui/settings-controls";
import { AdvancedToggle } from "./AdvancedToggle";
import { useAdvancedSettingsEnabled } from "./AdvancedToggle.hooks";
import {
  SettingsInputRow,
  SettingsSelectRow,
  SettingsSwitchRow,
  SettingsTextareaRow,
} from "./settings-agent-rows";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";

/**
 * Sentinel for the "Start from scratch" option. The create flow uses an empty
 * string to mean "no base app", but Radix Select forbids an empty-string item
 * value, so we map this sentinel back to "" at the value/onChange boundary.
 */
const CREATE_FROM_SCRATCH_VALUE = "__scratch__";

function AppRowActionButton({
  agentId,
  label,
  group,
  disabled,
  onClick,
  children,
  className,
  variant = "ghostMuted",
}: {
  agentId: string;
  label: string;
  group: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group,
    status: disabled ? "inactive" : "active",
    onActivate: onClick,
  });
  return (
    <Button
      ref={ref}
      type="button"
      size="touch"
      variant={variant}
      className={className}
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      {...agentProps}
    >
      {children}
    </Button>
  );
}

interface CreateAppResponse {
  ok?: boolean;
  status?: string;
  message?: string;
  appId?: string;
  taskId?: string;
}

interface LoadFromDirectoryResponse {
  ok?: boolean;
  loaded?: number;
  count?: number;
  message?: string;
}

interface RelaunchResponse {
  ok?: boolean;
  message?: string;
}

type AsyncStatus =
  | { state: "idle" }
  | { state: "loading"; message?: string }
  | { state: "error"; message: string };

export function AppsManagementSection() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const advancedEnabled = useAdvancedSettingsEnabled();

  const [installed, setInstalled] = useState<InstalledAppInfo[]>([]);
  const [catalog, setCatalog] = useState<RegistryAppInfo[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [runs, setRuns] = useState<AppRunSummary[]>([]);
  const [listStatus, setListStatus] = useState<AsyncStatus>({
    state: "loading",
  });
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [createIntent, setCreateIntent] = useState("");
  const [createEditTarget, setCreateEditTarget] = useState("");
  const [createStatus, setCreateStatus] = useState<AsyncStatus>({
    state: "idle",
  });

  const [showLoad, setShowLoad] = useState(false);
  const [loadDirectory, setLoadDirectory] = useState("");
  const [loadStatus, setLoadStatus] = useState<AsyncStatus>({ state: "idle" });

  const [verifyOnRelaunch, setVerifyOnRelaunch] = useState(true);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setListStatus({ state: "loading" });
    try {
      const [apps, appRuns, catalogResult] = await Promise.all([
        client.listInstalledApps(),
        client.listAppRuns(),
        client
          .listCatalogApps()
          .then((entries) => ({ ok: true as const, entries }))
          .catch((error: unknown) => {
            // error-policy:J4 installed app management remains usable while the
            // separately labeled Available collection reports catalog failure.
            return {
              ok: false as const,
              message:
                error instanceof Error
                  ? error.message
                  : "Could not load available apps.",
            };
          }),
      ]);
      if (!mountedRef.current) return;
      setInstalled(apps);
      setRuns(appRuns);
      if (catalogResult.ok) {
        setCatalog(catalogResult.entries);
        setCatalogError(null);
      } else {
        setCatalog([]);
        setCatalogError(catalogResult.message);
      }
      setListStatus({ state: "idle" });
    } catch (err) {
      // error-policy:J4 the hub presents a visible retry state when its
      // required installed-app inventory or run status cannot be loaded.
      if (!mountedRef.current) return;
      setListStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Failed to load apps.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runsByName = useMemo(() => {
    const map = new Map<string, AppRunSummary[]>();
    for (const run of runs) {
      const list = map.get(run.appName) ?? [];
      list.push(run);
      map.set(run.appName, list);
    }
    return map;
  }, [runs]);

  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const installedNames = useMemo(
    () => new Set(installed.map((app) => app.name)),
    [installed],
  );
  const filteredInstalled = useMemo(
    () =>
      installed.filter((app) =>
        `${app.displayName} ${app.name}`
          .toLocaleLowerCase()
          .includes(normalizedFilter),
      ),
    [installed, normalizedFilter],
  );
  const available = useMemo(
    () =>
      catalog
        .filter(
          (app) =>
            !installedNames.has(app.name) && app.visibleInAppStore !== false,
        )
        .filter((app) =>
          `${app.displayName} ${app.name} ${app.description}`
            .toLocaleLowerCase()
            .includes(normalizedFilter),
        )
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
    [catalog, installedNames, normalizedFilter],
  );

  const handleLaunch = useCallback(
    async (app: InstalledAppInfo) => {
      setBusyApp(app.name);
      try {
        await client.launchApp(app.name);
        setActionNotice(`${app.displayName} launched.`, "success", 3000);
        await refresh();
      } catch (err) {
        // error-policy:J4 launch failures surface as a shell action error.
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't launch ${app.displayName}.`,
          "error",
          5000,
        );
      } finally {
        if (mountedRef.current) setBusyApp(null);
      }
    },
    [refresh, setActionNotice],
  );

  const handleCatalogLaunch = useCallback(
    async (app: RegistryAppInfo) => {
      setBusyApp(app.name);
      try {
        await client.launchApp(app.name);
        setActionNotice(`${app.displayName} launched.`, "success", 3000);
        await refresh();
      } catch (err) {
        // error-policy:J4 catalog launch failures remain attached to the
        // requested action through the shell notice instead of faking install.
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't launch ${app.displayName}.`,
          "error",
          5000,
        );
      } finally {
        if (mountedRef.current) setBusyApp(null);
      }
    },
    [refresh, setActionNotice],
  );

  const handleRelaunch = useCallback(
    async (app: InstalledAppInfo) => {
      setBusyApp(app.name);
      try {
        const response = await client.fetch<RelaunchResponse>(
          "/api/apps/relaunch",
          {
            method: "POST",
            body: JSON.stringify({
              name: app.name,
              verify: verifyOnRelaunch,
            }),
          },
        );
        setActionNotice(
          response.message ?? `${app.displayName} relaunched.`,
          response.ok === false ? "error" : "success",
          4000,
        );
        await refresh();
      } catch (err) {
        // error-policy:J4 relaunch failures surface as a shell action error.
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't relaunch ${app.displayName}.`,
          "error",
          5000,
        );
      } finally {
        if (mountedRef.current) setBusyApp(null);
      }
    },
    [refresh, setActionNotice, verifyOnRelaunch],
  );

  const handleEdit = useCallback(
    async (app: InstalledAppInfo) => {
      setBusyApp(app.name);
      try {
        const response = await client.fetch<CreateAppResponse>(
          "/api/apps/create",
          {
            method: "POST",
            body: JSON.stringify({
              intent: "edit",
              editTarget: app.name,
            }),
          },
        );
        setActionNotice(
          response.message ?? `Editing ${app.displayName}…`,
          response.ok === false ? "error" : "info",
          4000,
        );
      } catch (err) {
        // error-policy:J4 edit failures surface as a shell action error.
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't start an edit for ${app.displayName}.`,
          "error",
          5000,
        );
      } finally {
        if (mountedRef.current) setBusyApp(null);
      }
    },
    [setActionNotice],
  );

  const handleStop = useCallback(
    async (app: InstalledAppInfo) => {
      setBusyApp(app.name);
      try {
        const result: AppStopResult = await client.stopApp(app.name);
        setActionNotice(
          result.message ?? `${app.displayName} stopped.`,
          result.success ? "success" : "error",
          3500,
        );
        await refresh();
      } catch (err) {
        // error-policy:J4 stop failures surface as a shell action error.
        setActionNotice(
          err instanceof Error
            ? err.message
            : `Couldn't stop ${app.displayName}.`,
          "error",
          5000,
        );
      } finally {
        if (mountedRef.current) setBusyApp(null);
      }
    },
    [refresh, setActionNotice],
  );

  const handleCreateSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const intent = createIntent.trim();
      if (!intent) return;
      setCreateStatus({ state: "loading", message: "Creating app…" });
      try {
        const response = await client.fetch<CreateAppResponse>(
          "/api/apps/create",
          {
            method: "POST",
            body: JSON.stringify({
              intent,
              editTarget: createEditTarget.trim() || undefined,
            }),
          },
        );
        if (!mountedRef.current) return;
        if (response.ok === false) {
          setCreateStatus({
            state: "error",
            message: response.message ?? "Failed to create app.",
          });
          return;
        }
        setCreateStatus({ state: "idle" });
        setCreateIntent("");
        setCreateEditTarget("");
        setShowCreate(false);
        setActionNotice(
          response.message ?? "App creation started.",
          "success",
          4500,
        );
        await refresh();
      } catch (err) {
        // error-policy:J4 create failures keep the form open with an error.
        if (!mountedRef.current) return;
        setCreateStatus({
          state: "error",
          message: err instanceof Error ? err.message : "Failed to create app.",
        });
      }
    },
    [createEditTarget, createIntent, refresh, setActionNotice],
  );

  const handleLoadSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const directory = loadDirectory.trim();
      if (!directory) return;
      setLoadStatus({ state: "loading" });
      try {
        const response = await client.fetch<LoadFromDirectoryResponse>(
          "/api/apps/load-from-directory",
          {
            method: "POST",
            body: JSON.stringify({ directory }),
          },
        );
        if (!mountedRef.current) return;
        if (response.ok === false) {
          setLoadStatus({
            state: "error",
            message: response.message ?? "Failed to load directory.",
          });
          return;
        }
        setLoadStatus({ state: "idle" });
        setLoadDirectory("");
        setShowLoad(false);
        const count = response.loaded ?? response.count ?? 0;
        setActionNotice(
          response.message ?? `Loaded ${count} app${count === 1 ? "" : "s"}.`,
          "success",
          4000,
        );
        await refresh();
      } catch (err) {
        // error-policy:J4 load failures keep the form open with an error.
        if (!mountedRef.current) return;
        setLoadStatus({
          state: "error",
          message:
            err instanceof Error ? err.message : "Failed to load directory.",
        });
      }
    },
    [loadDirectory, refresh, setActionNotice],
  );

  const isCreating = createStatus.state === "loading";
  const isLoading = loadStatus.state === "loading";

  const { ref: filterRef, agentProps: filterAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "apps-filter",
      role: "text-input",
      label: "Filter apps",
      group: "apps-management",
      status: normalizedFilter ? "active" : "inactive",
      getValue: () => filter,
      onFill: setFilter,
    });

  const { ref: createToggleRef, agentProps: createToggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-create-toggle",
      role: "button",
      label: t("settings.sections.apps.createNew", {
        defaultValue: "Create new app",
      }),
      group: "apps-management",
      status: showCreate ? "active" : "inactive",
      onActivate: () => {
        setShowCreate((v) => !v);
        setShowLoad(false);
      },
    });
  const { ref: loadToggleRef, agentProps: loadToggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-load-toggle",
      role: "button",
      label: t("settings.sections.apps.loadFromDirectory", {
        defaultValue: "Load from directory",
      }),
      group: "apps-management",
      status: showLoad ? "active" : "inactive",
      onActivate: () => {
        setShowLoad((v) => !v);
        setShowCreate(false);
      },
    });
  const { ref: createSubmitRef, agentProps: createSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-create-submit",
      role: "button",
      label: t("common.create", { defaultValue: "Create" }),
      group: "apps-create",
      status:
        isCreating || createIntent.trim().length === 0 ? "inactive" : "active",
      onActivate: () =>
        void handleCreateSubmit({
          preventDefault: () => {},
        } as React.FormEvent),
    });
  const { ref: createCancelRef, agentProps: createCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-create-cancel",
      role: "button",
      label: t("common.cancel", { defaultValue: "Cancel" }),
      group: "apps-create",
      onActivate: () => {
        setShowCreate(false);
        setCreateIntent("");
        setCreateEditTarget("");
        setCreateStatus({ state: "idle" });
      },
    });
  const { ref: loadSubmitRef, agentProps: loadSubmitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-load-submit",
      role: "button",
      label: t("settings.sections.apps.loadButton", { defaultValue: "Load" }),
      group: "apps-load",
      status:
        isLoading || loadDirectory.trim().length === 0 ? "inactive" : "active",
      onActivate: () =>
        void handleLoadSubmit({
          preventDefault: () => {},
        } as React.FormEvent),
    });
  const { ref: loadCancelRef, agentProps: loadCancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-load-cancel",
      role: "button",
      label: t("common.cancel", { defaultValue: "Cancel" }),
      group: "apps-load",
      onActivate: () => {
        setShowLoad(false);
        setLoadDirectory("");
        setLoadStatus({ state: "idle" });
      },
    });

  return (
    <SettingsStack className="gap-6 min-[700px]:gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={createToggleRef}
              type="button"
              variant="default"
              size="touch"
              onClick={() => {
                setShowCreate((v) => !v);
                setShowLoad(false);
              }}
              {...createToggleAgentProps}
            >
              {t("settings.sections.apps.createNew", {
                defaultValue: "Create new app",
              })}
            </Button>
            <Button
              ref={loadToggleRef}
              type="button"
              variant="outline"
              size="touch"
              onClick={() => {
                setShowLoad((v) => !v);
                setShowCreate(false);
              }}
              {...loadToggleAgentProps}
            >
              {t("settings.sections.apps.loadFromDirectory", {
                defaultValue: "Load from directory",
              })}
            </Button>
          </div>
          <AdvancedToggle label="Advanced" />
        </div>
        {advancedEnabled ? (
          <SettingsGroup bare>
            <SettingsSwitchRow
              agentId="apps-verify-on-relaunch"
              group="apps-management"
              label={t("settings.sections.apps.verifyOnRelaunch", {
                defaultValue: "Verify on relaunch",
              })}
              checked={verifyOnRelaunch}
              agentStatus={verifyOnRelaunch ? "active" : "inactive"}
              onCheckedChange={setVerifyOnRelaunch}
            />
          </SettingsGroup>
        ) : null}
        <SettingsInput
          ref={filterRef}
          variant="filter"
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter installed and available apps"
          {...filterAgentProps}
        />
      </div>

      {showCreate ? (
        <form onSubmit={handleCreateSubmit}>
          <SettingsGroup
            title={t("settings.sections.apps.createNew", {
              defaultValue: "Create new app",
            })}
            footer={
              createStatus.state === "error" ? (
                <span role="alert" className="text-danger">
                  {createStatus.message}
                </span>
              ) : undefined
            }
          >
            <SettingsTextareaRow
              agentId="apps-create-intent"
              group="apps-create"
              label={t("settings.sections.apps.intentLabel", {
                defaultValue: "What should the app do?",
              })}
              value={createIntent}
              disabled={isCreating}
              rows={3}
              onValueChange={setCreateIntent}
              textareaClassName="block w-full resize-y font-sans text-sm text-txt"
              placeholder={t("settings.sections.apps.intentPlaceholder", {
                defaultValue: "Describe what the app should do.",
              })}
            />
            {advancedEnabled ? (
              <SettingsSelectRow
                agentId="apps-create-edit-target"
                group="apps-create"
                label={t("settings.sections.apps.basedOnLabel", {
                  defaultValue: "Based on existing app (optional)",
                })}
                value={createEditTarget || CREATE_FROM_SCRATCH_VALUE}
                onValueChange={(value) =>
                  setCreateEditTarget(
                    value === CREATE_FROM_SCRATCH_VALUE ? "" : value,
                  )
                }
                disabled={isCreating}
                options={[
                  {
                    value: CREATE_FROM_SCRATCH_VALUE,
                    label: t("settings.sections.apps.basedOnNone", {
                      defaultValue: "Start from scratch",
                    }),
                  },
                  ...installed.map((app) => ({
                    value: app.name,
                    label: `${app.displayName} (${app.name})`,
                  })),
                ]}
              />
            ) : null}
            <SettingsRow label="" stacked>
              <div className="flex items-center gap-2">
                <Button
                  ref={createSubmitRef}
                  type="submit"
                  variant="default"
                  size="touch"
                  disabled={isCreating || createIntent.trim().length === 0}
                  {...createSubmitAgentProps}
                >
                  {isCreating ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2
                        className="size-3.5 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                      <span>
                        {createStatus.state === "loading"
                          ? (createStatus.message ?? "Working…")
                          : "Working…"}
                      </span>
                    </span>
                  ) : (
                    t("common.create", { defaultValue: "Create" })
                  )}
                </Button>
                <Button
                  ref={createCancelRef}
                  type="button"
                  variant="ghost"
                  size="touch"
                  onClick={() => {
                    setShowCreate(false);
                    setCreateIntent("");
                    setCreateEditTarget("");
                    setCreateStatus({ state: "idle" });
                  }}
                  disabled={isCreating}
                  {...createCancelAgentProps}
                >
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </Button>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </form>
      ) : null}

      {showLoad ? (
        <form onSubmit={handleLoadSubmit}>
          <SettingsGroup
            title={t("settings.sections.apps.loadFromDirectory", {
              defaultValue: "Load from directory",
            })}
            footer={
              loadStatus.state === "error" ? (
                <span role="alert" className="text-danger">
                  {loadStatus.message}
                </span>
              ) : undefined
            }
          >
            <SettingsInputRow
              agentId="apps-load-directory"
              group="apps-load"
              label={t("settings.sections.apps.directoryLabel", {
                defaultValue: "Directory path",
              })}
              value={loadDirectory}
              disabled={isLoading}
              type="text"
              onValueChange={setLoadDirectory}
              placeholder="/Users/me/code/my-app"
              inputClassName="w-full"
            />
            <SettingsRow label="" stacked>
              <div className="flex items-center gap-2">
                <Button
                  ref={loadSubmitRef}
                  type="submit"
                  variant="default"
                  size="touch"
                  disabled={isLoading || loadDirectory.trim().length === 0}
                  {...loadSubmitAgentProps}
                >
                  {isLoading ? (
                    <span className="inline-flex items-center gap-1">
                      <Loader2
                        className="size-3.5 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                      <span>
                        {t("common.loading", { defaultValue: "Loading…" })}
                      </span>
                    </span>
                  ) : (
                    t("settings.sections.apps.loadButton", {
                      defaultValue: "Load",
                    })
                  )}
                </Button>
                <Button
                  ref={loadCancelRef}
                  type="button"
                  variant="ghost"
                  size="touch"
                  onClick={() => {
                    setShowLoad(false);
                    setLoadDirectory("");
                    setLoadStatus({ state: "idle" });
                  }}
                  disabled={isLoading}
                  {...loadCancelAgentProps}
                >
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </Button>
              </div>
            </SettingsRow>
          </SettingsGroup>
        </form>
      ) : null}

      {listStatus.state === "loading" ? (
        <ContentState
          state="loading"
          placement="workspace"
          className="min-h-48"
          heading={t("settings.sections.apps.loadingApps", {
            defaultValue: "Loading apps…",
          })}
        />
      ) : listStatus.state === "error" ? (
        <ContentState
          state="error"
          placement="workspace"
          className="min-h-48"
          title="Apps unavailable"
          description={listStatus.message}
          action={
            <AppRowActionButton
              agentId="apps-retry"
              label={t("common.retry", { defaultValue: "Retry" })}
              group="apps-management"
              onClick={() => void refresh()}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </AppRowActionButton>
          }
        />
      ) : (
        <div className="flex flex-col gap-7" data-testid="apps-collection">
          <SettingsGroup
            bare
            title={t("settings.sections.apps.installedTitle", {
              defaultValue: "Installed",
            })}
            action={
              <span className="text-xs text-muted">{installed.length}</span>
            }
          >
            {filteredInstalled.length === 0 ? (
              <ContentState
                state="empty"
                placement="inset"
                className="min-h-32"
                title={
                  normalizedFilter
                    ? "No installed apps match"
                    : "No apps installed"
                }
                description={
                  normalizedFilter
                    ? "Try a different app name or ID."
                    : "Create an app, load one from disk, or launch one from Available."
                }
              />
            ) : (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {filteredInstalled.map((app) => {
                  const appRuns = runsByName.get(app.name) ?? [];
                  const running = appRuns.length > 0;
                  const busy = busyApp === app.name;
                  return (
                    <div
                      key={app.name}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                      data-testid={`apps-mgmt-row-${app.name}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-txt">
                            {app.displayName}
                          </h3>
                          {running ? (
                            <span
                              className="inline-flex items-center rounded-full bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok"
                              data-status="running"
                            >
                              {appRuns.length}{" "}
                              {appRuns.length === 1 ? "run" : "runs"}
                            </span>
                          ) : (
                            <span className="text-xs text-muted">Idle</span>
                          )}
                        </div>
                        <p className="mt-1 break-all font-mono text-xs text-muted">
                          {app.name} · {app.version || "Version unavailable"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                        <AppRowActionButton
                          agentId={`apps-launch-${app.name}`}
                          label={`Launch ${app.displayName}`}
                          group="apps-list"
                          disabled={busy}
                          onClick={() => void handleLaunch(app)}
                        >
                          <Play className="size-3.5" aria-hidden />
                        </AppRowActionButton>
                        <AppRowActionButton
                          agentId={`apps-relaunch-${app.name}`}
                          label={`Relaunch ${app.displayName}`}
                          group="apps-list"
                          disabled={busy}
                          onClick={() => void handleRelaunch(app)}
                        >
                          <RotateCw className="size-3.5" aria-hidden />
                        </AppRowActionButton>
                        <AppRowActionButton
                          agentId={`apps-edit-${app.name}`}
                          label={`Edit ${app.displayName}`}
                          group="apps-list"
                          disabled={busy}
                          onClick={() => void handleEdit(app)}
                        >
                          {t("settings.sections.apps.edit", {
                            defaultValue: "Edit",
                          })}
                        </AppRowActionButton>
                        {running ? (
                          <AppRowActionButton
                            agentId={`apps-stop-${app.name}`}
                            label={`Stop ${app.displayName}`}
                            group="apps-list"
                            className="px-2 text-xs text-danger hover:text-danger"
                            disabled={busy}
                            onClick={() => void handleStop(app)}
                          >
                            <Square className="size-3.5" aria-hidden />
                          </AppRowActionButton>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsGroup>

          <SettingsGroup
            bare
            title="Available"
            action={
              <span className="text-xs text-muted">{available.length}</span>
            }
          >
            {catalogError ? (
              <ContentState
                state="error"
                placement="inset"
                className="min-h-32"
                title="Available apps could not be loaded"
                description={catalogError}
                tone="warning"
              />
            ) : available.length === 0 ? (
              <ContentState
                state="empty"
                placement="inset"
                className="min-h-32"
                title={
                  normalizedFilter
                    ? "No available apps match"
                    : "No additional apps available"
                }
                description={
                  normalizedFilter
                    ? "Try a different app name, ID, or description."
                    : "New catalog apps will appear here when they become available."
                }
              />
            ) : (
              <div className="divide-y divide-border/60 border-y border-border/60">
                {available.map((app) => {
                  const busy = busyApp === app.name;
                  return (
                    <div
                      key={app.name}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                      data-testid={`apps-available-row-${app.name}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-medium text-txt">
                            {app.displayName}
                          </h3>
                          <span className="text-xs text-muted">Available</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-muted">
                          {app.description || app.name}
                        </p>
                      </div>
                      <AppRowActionButton
                        agentId={`apps-get-${app.name}`}
                        label={`Get ${app.displayName}`}
                        group="apps-list"
                        disabled={busy}
                        onClick={() => void handleCatalogLaunch(app)}
                        className="self-start px-3 sm:self-auto"
                        variant="outline"
                      >
                        {busy ? (
                          <Loader2
                            className="size-3.5 animate-spin motion-reduce:animate-none"
                            aria-hidden
                          />
                        ) : (
                          "Get"
                        )}
                      </AppRowActionButton>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsGroup>
        </div>
      )}
    </SettingsStack>
  );
}
