/**
 * Remote Plugin Manager — install from a local directory, start/stop, tail
 * logs, and uninstall Electrobun remote plugins via the typed desktop bridge.
 */

import { ExternalLink, FolderOpen, Play, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type DesktopInstalledRemotePluginSnapshot,
  type DesktopRemotePluginPermissionTag,
  type DesktopRemotePluginStoreSnapshot,
  type DesktopRemotePluginWorkerStatus,
  desktopOpenPath,
  getDesktopRemotePluginLogs,
  getDesktopRemotePluginStoreRoot,
  getDesktopRemotePluginStoreSnapshot,
  installDesktopRemotePluginFromDirectory,
  listDesktopRemotePluginWorkerStatuses,
  pickDesktopWorkspaceFolder,
  startDesktopRemotePluginWorker,
  stopDesktopRemotePluginWorker,
  subscribeDesktopRemotePluginStoreChanged,
  subscribeDesktopRemotePluginWorkerChanged,
  uninstallDesktopRemotePlugin,
} from "../../bridge/electrobun-rpc";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  type TranslationContextValue,
  useTranslation,
} from "../../state/TranslationContext.hooks";
import { Button } from "../ui/button";
import { SettingsInput } from "../ui/settings-controls";
import { SettingsGroup, SettingsStack } from "./settings-layout";

type TranslateFn = TranslationContextValue["t"];

type RemotePluginViewState = DesktopRemotePluginWorkerStatus["state"];

interface WorkerStatusMap {
  [remotePluginId: string]: DesktopRemotePluginWorkerStatus | undefined;
}

type RemotePluginStoreSnapshotCompat = DesktopRemotePluginStoreSnapshot & {
  carrots?: DesktopInstalledRemotePluginSnapshot[];
  remotePlugins?: DesktopInstalledRemotePluginSnapshot[];
};

const STATE_TONE: Record<RemotePluginViewState, string> = {
  stopped: "bg-surface text-muted",
  starting: "bg-warn/20 text-warn",
  running: "bg-ok/20 text-ok",
  error: "bg-warn/20 text-warn",
};

function StateBadge({ state }: { state: RemotePluginViewState }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}
    >
      {state}
    </span>
  );
}

function formatRelative(epochMs: number, t: TranslateFn): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "—";
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)
    return t("remotepluginhost.justNow", { defaultValue: "just now" });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function remotePluginsFromSnapshot(
  snapshot: DesktopRemotePluginStoreSnapshot | null,
): DesktopInstalledRemotePluginSnapshot[] {
  const compat = snapshot as RemotePluginStoreSnapshotCompat | null;
  return compat?.remotePlugins ?? compat?.carrots ?? [];
}

function permissionGroups(
  permissions: readonly DesktopRemotePluginPermissionTag[],
): {
  host: string[];
  bun: string[];
  isolation: string | null;
} {
  const host: string[] = [];
  const bun: string[] = [];
  let isolation: string | null = null;
  for (const tag of permissions) {
    if (tag.startsWith("host:")) host.push(tag.slice("host:".length));
    else if (tag.startsWith("bun:")) bun.push(tag.slice("bun:".length));
    else if (tag.startsWith("isolation:"))
      isolation = tag.slice("isolation:".length);
  }
  return { host, bun, isolation };
}

interface RemotePluginRowProps {
  remotePlugin: DesktopInstalledRemotePluginSnapshot;
  status: DesktopRemotePluginWorkerStatus | undefined;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onUninstall: (id: string, name: string) => Promise<void>;
  t: TranslateFn;
}

function RemotePluginRow({
  remotePlugin,
  status,
  onStart,
  onStop,
  onUninstall,
  t,
}: RemotePluginRowProps) {
  const [logs, setLogs] = useState<string>("");
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const state = status?.state ?? "stopped";
  const isBusy = state === "starting";

  const { host, bun, isolation } = permissionGroups([
    ...Object.entries(remotePlugin.grantedPermissions.host ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => `host:${k}` as DesktopRemotePluginPermissionTag),
    ...Object.entries(remotePlugin.grantedPermissions.bun ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => `bun:${k}` as DesktopRemotePluginPermissionTag),
    ...(remotePlugin.grantedPermissions.isolation
      ? [
          `isolation:${remotePlugin.grantedPermissions.isolation}` as DesktopRemotePluginPermissionTag,
        ]
      : []),
  ] as DesktopRemotePluginPermissionTag[]);

  const handleLogsToggle = useCallback(async () => {
    if (logsOpen) {
      setLogsOpen(false);
      return;
    }
    setLogsLoading(true);
    try {
      const snapshot = await getDesktopRemotePluginLogs(remotePlugin.id);
      setLogs(snapshot?.text ?? "");
      setLogsOpen(true);
    } finally {
      setLogsLoading(false);
    }
  }, [remotePlugin.id, logsOpen]);

  const isRunning = state === "running" || state === "starting";
  const { ref: toggleRef, agentProps: toggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `remote-plugin-toggle-${remotePlugin.id}`,
      role: "button",
      label: isRunning
        ? `${t("remotepluginhost.stop", { defaultValue: "Stop" })} ${remotePlugin.name}`
        : `${t("remotepluginhost.start", { defaultValue: "Start" })} ${remotePlugin.name}`,
      group: "remote-plugins-list",
      status: isRunning ? "active" : "inactive",
      onActivate: () =>
        void (isRunning ? onStop(remotePlugin.id) : onStart(remotePlugin.id)),
    });
  const { ref: logsRef, agentProps: logsAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `remote-plugin-logs-${remotePlugin.id}`,
      role: "button",
      label: `${t("remotepluginhost.logs", { defaultValue: "Logs" })} ${remotePlugin.name}`,
      group: "remote-plugins-list",
      status: logsOpen ? "active" : "inactive",
      onActivate: () => void handleLogsToggle(),
    });
  const { ref: uninstallRef, agentProps: uninstallAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `remote-plugin-uninstall-${remotePlugin.id}`,
      role: "button",
      label: `${t("remotepluginhost.uninstall", { defaultValue: "Uninstall" })} ${remotePlugin.name}`,
      group: "remote-plugins-list",
      onActivate: () => void onUninstall(remotePlugin.id, remotePlugin.name),
    });

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {remotePlugin.name}
            </span>
            <span className="text-xs font-mono text-muted">
              {remotePlugin.id}
            </span>
            <span className="text-xs text-muted">v{remotePlugin.version}</span>
            <span className="rounded-sm bg-bg/40 px-1.5 py-0.5 text-xs text-muted">
              {remotePlugin.mode}
            </span>
            <StateBadge state={state} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {remotePlugin.description}
          </p>
          {status?.error ? (
            <p className="mt-1 text-xs text-warn">{status.error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {isRunning ? (
            <Button
              ref={toggleRef}
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={() => onStop(remotePlugin.id)}
              {...toggleAgentProps}
            >
              <Square className="mr-1 h-3 w-3" />{" "}
              {t("remotepluginhost.stop", { defaultValue: "Stop" })}
            </Button>
          ) : (
            <Button
              ref={toggleRef}
              size="sm"
              variant="outline"
              onClick={() => onStart(remotePlugin.id)}
              {...toggleAgentProps}
            >
              <Play className="mr-1 h-3 w-3" />{" "}
              {t("remotepluginhost.start", { defaultValue: "Start" })}
            </Button>
          )}
          <Button
            ref={logsRef}
            size="sm"
            variant="outline"
            onClick={handleLogsToggle}
            disabled={logsLoading}
            {...logsAgentProps}
          >
            {t("remotepluginhost.logs", { defaultValue: "Logs" })}
          </Button>
          <Button
            ref={uninstallRef}
            size="sm"
            variant="outline"
            onClick={() => onUninstall(remotePlugin.id, remotePlugin.name)}
            {...uninstallAgentProps}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-muted sm:grid-cols-3">
        <div>
          <span className="font-medium text-txt/80">host:</span>{" "}
          {host.length === 0
            ? t("remotepluginhost.none", { defaultValue: "none" })
            : host.join(", ")}
        </div>
        <div>
          <span className="font-medium text-txt/80">bun:</span>{" "}
          {bun.length === 0
            ? t("remotepluginhost.none", { defaultValue: "none" })
            : bun.join(", ")}
        </div>
        <div>
          <span className="font-medium text-txt/80">isolation:</span>{" "}
          {isolation ?? "shared-worker"}
        </div>
      </div>

      <div className="mt-1 flex gap-3 text-xs text-muted/70">
        <span title={new Date(remotePlugin.installedAt).toISOString()}>
          {t("remotepluginhost.installed", {
            time: formatRelative(remotePlugin.installedAt, t),
            defaultValue: "installed {{time}}",
          })}
        </span>
        {remotePlugin.updatedAt !== remotePlugin.installedAt ? (
          <span title={new Date(remotePlugin.updatedAt).toISOString()}>
            {t("remotepluginhost.updated", {
              time: formatRelative(remotePlugin.updatedAt, t),
              defaultValue: "updated {{time}}",
            })}
          </span>
        ) : null}
        {remotePlugin.devMode ? (
          <span className="text-warn/80">
            {t("remotepluginhost.devMode", { defaultValue: "dev-mode" })}
          </span>
        ) : null}
      </div>

      {logsOpen ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-surface p-2 text-xs text-txt/80">
          {logs.length === 0
            ? t("remotepluginhost.noLogs", { defaultValue: "(no logs yet)" })
            : logs}
        </pre>
      ) : null}
    </div>
  );
}

export function RemotePluginHostSection() {
  const { t } = useTranslation();
  const branding = useBranding();
  const [snapshot, setSnapshot] =
    useState<DesktopRemotePluginStoreSnapshot | null>(null);
  const [statuses, setStatuses] = useState<WorkerStatusMap>({});
  const [storeRoot, setStoreRoot] = useState<string | null>(null);
  const [sourceDir, setSourceDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [snap, workerList, root] = await Promise.all([
      getDesktopRemotePluginStoreSnapshot(),
      listDesktopRemotePluginWorkerStatuses(),
      getDesktopRemotePluginStoreRoot(),
    ]);
    if (!mountedRef.current) return;
    setSnapshot(snap);
    setStoreRoot(root);
    if (workerList) {
      const next: WorkerStatusMap = {};
      for (const status of workerList) next[status.id] = status;
      setStatuses(next);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offStore = subscribeDesktopRemotePluginStoreChanged((next) => {
      if (mountedRef.current) setSnapshot(next);
    });
    const offWorker = subscribeDesktopRemotePluginWorkerChanged((status) => {
      if (mountedRef.current) {
        setStatuses((prev) => ({ ...prev, [status.id]: status }));
      }
    });
    return () => {
      offStore();
      offWorker();
    };
  }, [refresh]);

  const handleInstall = useCallback(async () => {
    if (!sourceDir.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const installed = await installDesktopRemotePluginFromDirectory({
        sourceDir: sourceDir.trim(),
        devMode: true,
      });
      if (installed === null) {
        setError(
          t("remotepluginhost.installFailed", {
            defaultValue: "Install failed — desktop bridge not available.",
          }),
        );
        return;
      }
      setSourceDir("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh, sourceDir, t]);

  const handlePickFolder = useCallback(async () => {
    setError(null);
    try {
      const result = await pickDesktopWorkspaceFolder({
        promptTitle: t("remotepluginhost.folderPickerTitle", {
          defaultValue: "Select a remote plugin source directory",
        }),
      });
      if (!result) {
        setError(
          t("remotepluginhost.folderPickerUnavailable", {
            defaultValue:
              "Folder picker unavailable — desktop bridge not connected.",
          }),
        );
        return;
      }
      if (result.canceled) return;
      if (mountedRef.current) setSourceDir(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [t]);

  const handleStart = useCallback(async (id: string) => {
    await startDesktopRemotePluginWorker(id);
  }, []);

  const handleStop = useCallback(async (id: string) => {
    await stopDesktopRemotePluginWorker(id);
  }, []);

  const handleUninstall = useCallback(
    async (id: string, name: string) => {
      if (
        !window.confirm(
          t("remotepluginhost.uninstallConfirm", {
            name,
            defaultValue: 'Uninstall "{{name}}"? Files will be removed.',
          }),
        )
      ) {
        return;
      }
      await uninstallDesktopRemotePlugin(id);
      await refresh();
    },
    [refresh, t],
  );

  const remotePlugins = remotePluginsFromSnapshot(snapshot);

  const { ref: revealStoreRef, agentProps: revealStoreAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "remote-plugin-reveal-store",
      role: "button",
      label: t("remotepluginhost.revealInFileManager", {
        defaultValue: "Reveal in file manager",
      }),
      group: "remote-plugins",
      onActivate: () => {
        if (storeRoot) void desktopOpenPath(storeRoot);
      },
    });
  const { ref: sourceDirRef, agentProps: sourceDirAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "remote-plugin-source-dir",
      role: "text-input",
      label: t("remotepluginhost.installFromDirectory", {
        defaultValue: "Install from directory",
      }),
      group: "remote-plugins",
      getValue: () => sourceDir,
      onFill: setSourceDir,
    });
  const { ref: pickFolderRef, agentProps: pickFolderAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "remote-plugin-pick-folder",
      role: "button",
      label: t("remotepluginhost.pickFolder", {
        defaultValue: "Pick a folder…",
      }),
      group: "remote-plugins",
      onActivate: () => void handlePickFolder(),
    });
  const { ref: installRef, agentProps: installAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "remote-plugin-install",
      role: "button",
      label: t("remotepluginhost.install", { defaultValue: "Install" }),
      group: "remote-plugins",
      status: busy || sourceDir.trim().length === 0 ? "inactive" : "active",
      onActivate: () => void handleInstall(),
    });
  return (
    <SettingsStack>
      <SettingsGroup
        title={t("remotepluginhost.installFromDirectory", {
          defaultValue: "Install from directory",
        })}
        description={t("remotepluginhost.authTokenDesc", {
          defaultValue:
            "A remote plugin can call {{appName}}'s API as you. Only install from sources you trust.",
          ...appNameInterpolationVars(branding),
        })}
        footer={
          storeRoot || error ? (
            <>
              {storeRoot ? (
                <Button
                  ref={revealStoreRef}
                  variant="ghost"
                  size="sm"
                  className="flex items-center gap-1.5 text-muted/80 hover:text-txt"
                  onClick={() => void desktopOpenPath(storeRoot)}
                  {...revealStoreAgentProps}
                >
                  <code className="truncate">{storeRoot}</code>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                </Button>
              ) : null}
              {error ? <span className="text-warn">{error}</span> : null}
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2 py-2.5 sm:flex-row">
          <SettingsInput
            ref={sourceDirRef}
            variant="touch"
            value={sourceDir}
            onChange={(e) => setSourceDir(e.target.value)}
            placeholder="/absolute/path/to/remote-plugin/source"
            disabled={busy}
            className="w-full sm:flex-1"
            {...sourceDirAgentProps}
          />
          <div className="flex gap-2">
            <Button
              ref={pickFolderRef}
              type="button"
              variant="outline"
              onClick={() => void handlePickFolder()}
              disabled={busy}
              className="h-11 w-11 shrink-0 rounded-md p-0"
              title={t("remotepluginhost.pickFolder", {
                defaultValue: "Pick a folder…",
              })}
              {...pickFolderAgentProps}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
            <Button
              ref={installRef}
              type="button"
              onClick={() => void handleInstall()}
              disabled={busy || sourceDir.trim().length === 0}
              className="h-11 flex-1 rounded-md px-4 text-sm sm:flex-none"
              {...installAgentProps}
            >
              {t("remotepluginhost.install", { defaultValue: "Install" })}
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        bare
        title={t("remotepluginhost.installedCount", {
          count: remotePlugins.length,
          defaultValue: "Installed ({{count}})",
        })}
      >
        {remotePlugins.length === 0 ? (
          <p className="px-1 py-3 text-xs text-muted">
            {t("remotepluginhost.emptyLeadIn", {
              defaultValue: "No remote plugins installed.",
            })}
          </p>
        ) : (
          <div className="flex flex-col">
            {remotePlugins.map((remotePlugin) => (
              <RemotePluginRow
                key={remotePlugin.id}
                remotePlugin={remotePlugin}
                status={statuses[remotePlugin.id]}
                onStart={handleStart}
                onStop={handleStop}
                onUninstall={handleUninstall}
                t={t}
              />
            ))}
          </div>
        )}
      </SettingsGroup>
    </SettingsStack>
  );
}
