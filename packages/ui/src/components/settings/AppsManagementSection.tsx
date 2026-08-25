/**
 * Apps management settings panel — installed app inventory plus the
 * "Create new app" and "Load from directory" entry points.
 */

import { Loader2, Play, RotateCw, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  AppRunSummary,
  AppStopResult,
  InstalledAppInfo,
} from "../../api/client-types-cloud";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
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
}: {
  agentId: string;
  label: string;
  group: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
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
      size="sm"
      variant="ghost"
      className={className ?? "h-7 px-2 text-xs"}
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

const HEAD_CELL_CLASS = "px-3 py-2 text-xs font-medium text-muted";
const BODY_CELL_CLASS = "px-3 py-2.5 align-middle text-sm";

export function AppsManagementSection() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const advancedEnabled = useAdvancedSettingsEnabled();

  const [installed, setInstalled] = useState<InstalledAppInfo[]>([]);
  const [runs, setRuns] = useState<AppRunSummary[]>([]);
  const [listStatus, setListStatus] = useState<AsyncStatus>({
    state: "loading",
  });
  const [busyApp, setBusyApp] = useState<string | null>(null);

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
      const [apps, appRuns] = await Promise.all([
        client.listInstalledApps(),
        client.listAppRuns(),
      ]);
      if (!mountedRef.current) return;
      setInstalled(apps);
      setRuns(appRuns);
      setListStatus({ state: "idle" });
    } catch (err) {
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

  const handleLaunch = useCallback(
    async (app: InstalledAppInfo) => {
      setBusyApp(app.name);
      try {
        await client.launchApp(app.name);
        setActionNotice(`${app.displayName} launched.`, "success", 3000);
        await refresh();
      } catch (err) {
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
    <SettingsStack>
      <SettingsGroup
        title={t("settings.sections.apps.groupTitle", { defaultValue: "Apps" })}
        action={<AdvancedToggle label="Advanced" />}
      >
        <div className="flex flex-wrap items-center gap-2 pb-1">
          <Button
            ref={createToggleRef}
            type="button"
            variant="default"
            className="min-h-11 rounded-md px-4 text-sm"
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
            className="min-h-11 rounded-md px-4 text-sm"
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
        {advancedEnabled ? (
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
        ) : null}
      </SettingsGroup>

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
                  className="h-11 rounded-md px-4 text-sm"
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
                  className="h-11 rounded-md px-4 text-sm text-muted"
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
                  className="h-11 rounded-md px-4 text-sm"
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
                  className="h-11 rounded-md px-4 text-sm text-muted"
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
        <SettingsGroup bare>
          <div
            className="flex items-center gap-2 px-1 py-3 text-sm text-muted"
            role="status"
            aria-live="polite"
          >
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            <span>
              {t("settings.sections.apps.loadingApps", {
                defaultValue: "Loading apps…",
              })}
            </span>
          </div>
        </SettingsGroup>
      ) : listStatus.state === "error" ? (
        <SettingsGroup bare>
          <div className="flex flex-wrap items-center gap-3 py-2">
            <p role="alert" className="text-sm text-danger">
              {listStatus.message}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 px-4 text-sm"
              onClick={() => void refresh()}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        </SettingsGroup>
      ) : installed.length === 0 ? (
        <SettingsGroup bare>
          <p className="py-4 text-center text-sm text-muted">
            {t("settings.sections.apps.empty", {
              defaultValue: "No apps installed yet.",
            })}
          </p>
        </SettingsGroup>
      ) : (
        <SettingsGroup
          bare
          title={t("settings.sections.apps.installedTitle", {
            defaultValue: "Installed apps",
          })}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border/50">
                  <th className={HEAD_CELL_CLASS}>
                    {t("settings.sections.apps.col.name", {
                      defaultValue: "App",
                    })}
                  </th>
                  <th className={HEAD_CELL_CLASS}>
                    {t("settings.sections.apps.col.id", {
                      defaultValue: "ID",
                    })}
                  </th>
                  <th className={HEAD_CELL_CLASS}>
                    {t("settings.sections.apps.col.version", {
                      defaultValue: "Version",
                    })}
                  </th>
                  <th className={HEAD_CELL_CLASS}>
                    {t("settings.sections.apps.col.runs", {
                      defaultValue: "Runs",
                    })}
                  </th>
                  <th className={`${HEAD_CELL_CLASS} text-right`}>
                    {t("settings.sections.apps.col.actions", {
                      defaultValue: "Actions",
                    })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {installed.map((app) => {
                  const appRuns = runsByName.get(app.name) ?? [];
                  const running = appRuns.length > 0;
                  const busy = busyApp === app.name;
                  return (
                    <tr
                      key={app.name}
                      className="border-t border-border/60 hover:bg-bg-hover/40"
                      data-testid={`apps-mgmt-row-${app.name}`}
                    >
                      <td className={`${BODY_CELL_CLASS} font-medium text-txt`}>
                        {app.displayName}
                      </td>
                      <td
                        className={`${BODY_CELL_CLASS} font-mono text-xs text-muted`}
                      >
                        {app.name}
                      </td>
                      <td className={`${BODY_CELL_CLASS} text-xs text-muted`}>
                        {app.version || "—"}
                      </td>
                      <td className={BODY_CELL_CLASS}>
                        {running ? (
                          <span className="inline-flex items-center rounded-full bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok">
                            {appRuns.length}{" "}
                            {appRuns.length === 1 ? "run" : "runs"}
                          </span>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                      <td className={`${BODY_CELL_CLASS} text-right`}>
                        <div className="inline-flex items-center gap-1">
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
                              className="h-7 px-2 text-xs text-danger hover:text-danger"
                              disabled={busy}
                              onClick={() => void handleStop(app)}
                            >
                              <Square className="size-3.5" aria-hidden />
                            </AppRowActionButton>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SettingsGroup>
      )}
    </SettingsStack>
  );
}
