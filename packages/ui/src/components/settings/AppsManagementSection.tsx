/**
 * Apps management settings panel — installed app inventory plus the
 * "Create new app" and "Load from directory" entry points that the
 * unified APP action exposes over HTTP.
 *
 * Endpoints owned by Agent C:
 *   POST /api/apps/create               — { intent, editTarget? }
 *   POST /api/apps/relaunch             — { name, verify? }
 *   POST /api/apps/load-from-directory  — { directory }
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
import { useApp } from "../../state";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

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

const HEAD_CELL_CLASS =
  "px-2 py-1.5 text-2xs font-semibold uppercase tracking-wider text-muted";
const BODY_CELL_CLASS = "px-2 py-2 align-middle";

export function AppsManagementSection() {
  const { setActionNotice, t } = useApp();

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
        setCreateStatus({ state: "idle" });
        setCreateIntent("");
        setCreateEditTarget("");
        setShowCreate(false);
        setActionNotice(
          response.message ?? "App creation started.",
          response.ok === false ? "error" : "success",
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
        setLoadStatus({ state: "idle" });
        setLoadDirectory("");
        setShowLoad(false);
        const count = response.loaded ?? response.count ?? 0;
        setActionNotice(
          response.message ?? `Loaded ${count} app${count === 1 ? "" : "s"}.`,
          response.ok === false ? "error" : "success",
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
  const { ref: verifyRef, agentProps: verifyAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "apps-verify-on-relaunch",
      role: "toggle",
      label: t("settings.sections.apps.verifyOnRelaunch", {
        defaultValue: "Verify on relaunch",
      }),
      group: "apps-management",
      status: verifyOnRelaunch ? "active" : "inactive",
      onActivate: () => setVerifyOnRelaunch((v) => !v),
    });
  const { ref: createIntentRef, agentProps: createIntentAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "apps-create-intent",
      role: "textarea",
      label: t("settings.sections.apps.intentLabel", {
        defaultValue: "What should the app do?",
      }),
      group: "apps-create",
      getValue: () => createIntent,
      onFill: setCreateIntent,
    });
  const { ref: createTargetRef, agentProps: createTargetAgentProps } =
    useAgentElement<HTMLSelectElement>({
      id: "apps-create-edit-target",
      role: "select",
      label: t("settings.sections.apps.basedOnLabel", {
        defaultValue: "Based on existing app (optional)",
      }),
      group: "apps-create",
      getValue: () => createEditTarget,
      onFill: setCreateEditTarget,
      options: ["", ...installed.map((app) => app.name)],
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
  const { ref: loadDirectoryRef, agentProps: loadDirectoryAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "apps-load-directory",
      role: "text-input",
      label: t("settings.sections.apps.directoryLabel", {
        defaultValue: "Directory path",
      }),
      group: "apps-load",
      getValue: () => loadDirectory,
      onFill: setLoadDirectory,
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={createToggleRef}
          type="button"
          size="sm"
          variant="default"
          className="h-8 px-3 text-xs"
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
          size="sm"
          variant="outline"
          className="h-8 px-3 text-xs"
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
        <div className="flex-1" />
        <div className="inline-flex items-center gap-1.5 text-2xs text-muted">
          <Checkbox
            ref={verifyRef}
            checked={verifyOnRelaunch}
            onCheckedChange={(checked: boolean | "indeterminate") =>
              setVerifyOnRelaunch(!!checked)
            }
            aria-current={verifyOnRelaunch ? "true" : undefined}
            aria-label={t("settings.sections.apps.verifyOnRelaunchLabel", {
              defaultValue: "Verify on relaunch",
            })}
            {...verifyAgentProps}
          />
          <span>
            {t("settings.sections.apps.verifyOnRelaunch", {
              defaultValue: "Verify on relaunch",
            })}
          </span>
        </div>
      </div>

      {showCreate ? (
        <form
          className="space-y-2 rounded-sm border border-border bg-card p-3"
          onSubmit={handleCreateSubmit}
        >
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-txt"
              htmlFor="apps-create-intent"
            >
              {t("settings.sections.apps.intentLabel", {
                defaultValue: "What should the app do?",
              })}
            </label>
            <textarea
              ref={createIntentRef}
              id="apps-create-intent"
              rows={3}
              value={createIntent}
              disabled={isCreating}
              onChange={(e) => setCreateIntent(e.target.value)}
              className="block w-full resize-y rounded-sm border border-border bg-bg px-2 py-1.5 text-xs text-txt focus:border-accent focus:outline-none disabled:opacity-50"
              placeholder={t("settings.sections.apps.intentPlaceholder", {
                defaultValue:
                  "Describe the experience you want — e.g. a vibe coder for prototyping web apps with Tailwind.",
              })}
              {...createIntentAgentProps}
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-txt"
              htmlFor="apps-create-edit-target"
            >
              {t("settings.sections.apps.basedOnLabel", {
                defaultValue: "Based on existing app (optional)",
              })}
            </label>
            <select
              ref={createTargetRef}
              id="apps-create-edit-target"
              value={createEditTarget}
              disabled={isCreating}
              onChange={(e) => setCreateEditTarget(e.target.value)}
              className="block w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-xs text-txt focus:border-accent focus:outline-none disabled:opacity-50"
              {...createTargetAgentProps}
            >
              <option value="">
                {t("settings.sections.apps.basedOnNone", {
                  defaultValue: "Start from scratch",
                })}
              </option>
              {installed.map((app) => (
                <option key={app.name} value={app.name}>
                  {app.displayName} ({app.name})
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              ref={createSubmitRef}
              type="submit"
              size="sm"
              variant="default"
              className="h-7 px-3 text-xs"
              disabled={isCreating || createIntent.trim().length === 0}
              {...createSubmitAgentProps}
            >
              {isCreating ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
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
              size="sm"
              variant="ghost"
              className="h-7 px-3 text-xs text-muted"
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
            {createStatus.state === "error" ? (
              <span className="text-2xs text-danger">
                {createStatus.message}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}

      {showLoad ? (
        <form
          className="space-y-2 rounded-sm border border-border bg-card p-3"
          onSubmit={handleLoadSubmit}
        >
          <div className="space-y-1">
            <label
              className="text-xs font-medium text-txt"
              htmlFor="apps-load-directory"
            >
              {t("settings.sections.apps.directoryLabel", {
                defaultValue: "Directory path",
              })}
            </label>
            <Input
              ref={loadDirectoryRef}
              id="apps-load-directory"
              type="text"
              value={loadDirectory}
              disabled={isLoading}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setLoadDirectory(e.target.value)
              }
              placeholder="/Users/me/code/my-app"
              className="h-8 text-xs"
              {...loadDirectoryAgentProps}
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              ref={loadSubmitRef}
              type="submit"
              size="sm"
              variant="default"
              className="h-7 px-3 text-xs"
              disabled={isLoading || loadDirectory.trim().length === 0}
              {...loadSubmitAgentProps}
            >
              {isLoading ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
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
              size="sm"
              variant="ghost"
              className="h-7 px-3 text-xs text-muted"
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
            {loadStatus.state === "error" ? (
              <span className="text-2xs text-danger">{loadStatus.message}</span>
            ) : null}
          </div>
        </form>
      ) : null}

      {listStatus.state === "loading" ? (
        <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          <span>
            {t("settings.sections.apps.loadingApps", {
              defaultValue: "Loading apps…",
            })}
          </span>
        </div>
      ) : listStatus.state === "error" ? (
        <div className="rounded-sm border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          {listStatus.message}
        </div>
      ) : installed.length === 0 ? (
        <div className="rounded-sm border border-border bg-card px-3 py-4 text-center text-xs text-muted">
          {t("settings.sections.apps.empty", {
            defaultValue:
              "No apps installed yet. Click 'Create new app' to scaffold one.",
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-bg-hover">
              <tr>
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
                      className={`${BODY_CELL_CLASS} font-mono text-2xs text-muted`}
                    >
                      {app.name}
                    </td>
                    <td className={`${BODY_CELL_CLASS} text-2xs text-muted`}>
                      {app.version || "—"}
                    </td>
                    <td className={BODY_CELL_CLASS}>
                      {running ? (
                        <span className="inline-flex items-center rounded-full bg-ok/10 px-1.5 py-0.5 text-2xs font-medium text-ok">
                          {appRuns.length}{" "}
                          {appRuns.length === 1 ? "run" : "runs"}
                        </span>
                      ) : (
                        <span className="text-2xs text-muted">—</span>
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
                          <Play className="h-3.5 w-3.5" aria-hidden />
                        </AppRowActionButton>
                        <AppRowActionButton
                          agentId={`apps-relaunch-${app.name}`}
                          label={`Relaunch ${app.displayName}`}
                          group="apps-list"
                          disabled={busy}
                          onClick={() => void handleRelaunch(app)}
                        >
                          <RotateCw className="h-3.5 w-3.5" aria-hidden />
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
                            <Square className="h-3.5 w-3.5" aria-hidden />
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
      )}
    </div>
  );
}
