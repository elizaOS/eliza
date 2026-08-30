/**
 * Apps management settings panel — installed app inventory plus the
 * "Create new app" and "Load from directory" entry points.
 */

import { Boxes, Loader2, MoreHorizontal, Play, Plus } from "lucide-react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api/client";
import type {
  AppRunSummary,
  AppStopResult,
  InstalledAppInfo,
} from "../../api/client-types-cloud";
import { useAppSelector } from "../../state";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
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
      size="tiny"
      variant="ghostMuted"
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

function AppRowActions({
  app,
  busy,
  running,
  onLaunch,
  onRelaunch,
  onEdit,
  onStop,
}: {
  app: InstalledAppInfo;
  busy: boolean;
  running: boolean;
  onLaunch: () => void;
  onRelaunch: () => void;
  onEdit: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <AppRowActionButton
        agentId={`apps-launch-${app.name}`}
        label={`Launch ${app.displayName}`}
        group="apps-list"
        disabled={busy}
        onClick={onLaunch}
        className="size-10"
      >
        <Play className="size-4" aria-hidden />
      </AppRowActionButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghostMuted"
            size="icon"
            className="size-10"
            disabled={busy}
            aria-label={`More actions for ${app.displayName}`}
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={onRelaunch}>Relaunch</DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
          {running ? (
            <DropdownMenuItem className="text-danger" onClick={onStop}>
              Stop
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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

interface AppsManagementActionsProps {
  showCreate: boolean;
  showLoad: boolean;
  setShowCreate: Dispatch<SetStateAction<boolean>>;
  setShowLoad: Dispatch<SetStateAction<boolean>>;
}

export function AppsManagementActions({
  showCreate,
  showLoad,
  setShowCreate,
  setShowLoad,
}: AppsManagementActionsProps) {
  const t = useAppSelector((s) => s.t);
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
        setShowCreate((value) => !value);
        setShowLoad(false);
      },
    });
  const { ref: loadToggleRef, agentProps: loadToggleAgentProps } =
    useAgentElement<HTMLDivElement>({
      id: "apps-load-toggle",
      role: "button",
      label: "Import from directory",
      group: "apps-management",
      status: showLoad ? "active" : "inactive",
      onActivate: () => {
        setShowLoad((value) => !value);
        setShowCreate(false);
      },
    });

  return (
    <section
      className="flex items-center justify-end gap-1"
      aria-label="App actions"
    >
      <Button
        ref={createToggleRef}
        type="button"
        variant="default"
        size="icon"
        className="size-10"
        aria-label="Create new app"
        title="Create new app"
        onClick={() => {
          setShowCreate((value) => !value);
          setShowLoad(false);
        }}
        {...createToggleAgentProps}
      >
        <Plus className="size-4" aria-hidden />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghostMuted"
            size="icon"
            className="size-10"
            aria-label="More app actions"
            title="More app actions"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem
            ref={loadToggleRef}
            onSelect={() => {
              setShowLoad((value) => !value);
              setShowCreate(false);
            }}
            {...loadToggleAgentProps}
          >
            Import from directory
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  );
}

interface AppsManagementSectionProps {
  showCreate?: boolean;
  showLoad?: boolean;
  setShowCreate?: Dispatch<SetStateAction<boolean>>;
  setShowLoad?: Dispatch<SetStateAction<boolean>>;
  hideActions?: boolean;
}

export function AppsManagementSection({
  showCreate: controlledShowCreate,
  showLoad: controlledShowLoad,
  setShowCreate: controlledSetShowCreate,
  setShowLoad: controlledSetShowLoad,
  hideActions = false,
}: AppsManagementSectionProps = {}) {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const advancedEnabled = useAdvancedSettingsEnabled();

  const [installed, setInstalled] = useState<InstalledAppInfo[]>([]);
  const [runs, setRuns] = useState<AppRunSummary[]>([]);
  const [listStatus, setListStatus] = useState<AsyncStatus>({
    state: "loading",
  });
  const [busyApp, setBusyApp] = useState<string | null>(null);

  const [internalShowCreate, setInternalShowCreate] = useState(false);
  const [createIntent, setCreateIntent] = useState("");
  const [createEditTarget, setCreateEditTarget] = useState("");
  const [createStatus, setCreateStatus] = useState<AsyncStatus>({
    state: "idle",
  });

  const [internalShowLoad, setInternalShowLoad] = useState(false);
  const showCreate = controlledShowCreate ?? internalShowCreate;
  const showLoad = controlledShowLoad ?? internalShowLoad;
  const setShowCreate = controlledSetShowCreate ?? setInternalShowCreate;
  const setShowLoad = controlledSetShowLoad ?? setInternalShowLoad;
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
    [createEditTarget, createIntent, refresh, setActionNotice, setShowCreate],
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
    [loadDirectory, refresh, setActionNotice, setShowLoad],
  );

  const isCreating = createStatus.state === "loading";
  const isLoading = loadStatus.state === "loading";

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
      {!hideActions ? (
        <AppsManagementActions
          showCreate={showCreate}
          showLoad={showLoad}
          setShowCreate={setShowCreate}
          setShowLoad={setShowLoad}
        />
      ) : null}

      {showCreate ? (
        <form onSubmit={handleCreateSubmit}>
          <SettingsGroup
            bare
            title={t("settings.sections.apps.createNew", {
              defaultValue: "Create new app",
            })}
            action={<AdvancedToggle label="Advanced" />}
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
            bare
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
              size="touch"
              onClick={() => void refresh()}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        </SettingsGroup>
      ) : installed.length === 0 ? (
        <SettingsGroup bare>
          <div
            role="status"
            className="mx-auto flex min-h-44 max-w-sm flex-col items-center justify-center gap-2 text-center [@media(orientation:landscape)_and_(max-height:520px)]:min-h-24"
          >
            <Boxes className="size-8 text-accent" aria-hidden />
            <p className="text-sm font-semibold text-txt-strong">
              No apps installed yet
            </p>
            <p className="text-xs leading-relaxed text-muted">
              Create an app or load one from a directory to get started.
            </p>
          </div>
        </SettingsGroup>
      ) : (
        <SettingsGroup
          bare
          title={t("settings.sections.apps.installedTitle", {
            defaultValue: "Installed apps",
          })}
        >
          {advancedEnabled ? (
            <div className="border-y border-border/50 py-2">
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
            </div>
          ) : null}
          <div className="divide-y divide-border/60 border-y border-border/60">
            {installed.map((app) => {
              const appRuns = runsByName.get(app.name) ?? [];
              const running = appRuns.length > 0;
              const busy = busyApp === app.name;
              return (
                <div
                  key={app.name}
                  className="flex min-w-0 items-center gap-3 py-3 transition-colors hover:bg-bg-hover/20"
                  data-testid={`apps-mgmt-row-${app.name}`}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface text-sm font-semibold text-muted-strong">
                    {app.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm font-semibold text-txt-strong">
                      {app.displayName}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {app.name}
                      {app.version ? ` · v${app.version}` : ""}
                    </span>
                  </span>
                  <span className="hidden shrink-0 sm:inline-flex">
                    {running ? (
                      <span className="inline-flex items-center rounded-full bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok">
                        {appRuns.length} {appRuns.length === 1 ? "run" : "runs"}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </span>
                  <AppRowActions
                    app={app}
                    busy={busy}
                    running={running}
                    onLaunch={() => void handleLaunch(app)}
                    onRelaunch={() => void handleRelaunch(app)}
                    onEdit={() => void handleEdit(app)}
                    onStop={() => void handleStop(app)}
                  />
                </div>
              );
            })}
          </div>
        </SettingsGroup>
      )}
    </SettingsStack>
  );
}
