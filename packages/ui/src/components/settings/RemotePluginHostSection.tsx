/**
 * Remote Plugin Manager — installs, starts, stops, and uninstalls Electrobun
 * remote plugins through the typed desktop bridge. Lives in Settings rather
 * than AppsView until the catalog→remote-plugin product mapping is decided
 * (see PR #7624 follow-up notes). Scope is deliberately MVP: no
 * remote install, no permission diff/re-consent dialog, no
 * window-mode webview opening, no inter-plugin invoke surface. Just:
 * list, install from a local directory, start/stop, tail logs,
 * uninstall.
 */

import {
  ExternalLink,
  FolderOpen,
  Play,
  RefreshCw,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type RemotePluginViewState = DesktopRemotePluginWorkerStatus["state"];

interface WorkerStatusMap {
  [remotePluginId: string]: DesktopRemotePluginWorkerStatus | undefined;
}

type RemotePluginStoreSnapshotCompat = DesktopRemotePluginStoreSnapshot & {
  carrots?: DesktopInstalledRemotePluginSnapshot[];
  remotePlugins?: DesktopInstalledRemotePluginSnapshot[];
};

const STATE_TONE: Record<RemotePluginViewState, string> = {
  stopped: "bg-bg/40 text-muted",
  starting: "bg-warn/20 text-warn",
  running: "bg-ok/20 text-ok",
  error: "bg-err/20 text-err",
};

function StateBadge({ state }: { state: RemotePluginViewState }) {
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATE_TONE[state]}`}
    >
      {state}
    </span>
  );
}

function formatRelative(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "—";
  const diffMs = Date.now() - epochMs;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
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
}

function RemotePluginRow({
  remotePlugin,
  status,
  onStart,
  onStop,
  onUninstall,
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

  return (
    <div className="rounded border border-bg-3 bg-bg-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {remotePlugin.name}
            </span>
            <span className="text-[10px] font-mono text-muted">
              {remotePlugin.id}
            </span>
            <span className="text-[10px] text-muted">
              v{remotePlugin.version}
            </span>
            <span className="rounded bg-bg/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
              {remotePlugin.mode}
            </span>
            <StateBadge state={state} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {remotePlugin.description}
          </p>
          {status?.error ? (
            <p className="mt-1 text-xs text-err">{status.error}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {state === "running" || state === "starting" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={() => onStop(remotePlugin.id)}
            >
              <Square className="mr-1 h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onStart(remotePlugin.id)}
            >
              <Play className="mr-1 h-3 w-3" /> Start
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={handleLogsToggle}
            disabled={logsLoading}
          >
            Logs
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onUninstall(remotePlugin.id, remotePlugin.name)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-muted sm:grid-cols-3">
        <div>
          <span className="font-medium text-txt/80">host:</span>{" "}
          {host.length === 0 ? "none" : host.join(", ")}
        </div>
        <div>
          <span className="font-medium text-txt/80">bun:</span>{" "}
          {bun.length === 0 ? "none" : bun.join(", ")}
        </div>
        <div>
          <span className="font-medium text-txt/80">isolation:</span>{" "}
          {isolation ?? "shared-worker"}
        </div>
      </div>

      <div className="mt-1 flex gap-3 text-[10px] text-muted/70">
        <span title={new Date(remotePlugin.installedAt).toISOString()}>
          installed {formatRelative(remotePlugin.installedAt)}
        </span>
        {remotePlugin.updatedAt !== remotePlugin.installedAt ? (
          <span title={new Date(remotePlugin.updatedAt).toISOString()}>
            updated {formatRelative(remotePlugin.updatedAt)}
          </span>
        ) : null}
        {remotePlugin.devMode ? (
          <span className="text-warn/80">dev-mode</span>
        ) : null}
      </div>

      {logsOpen ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-bg-3 p-2 text-[11px] text-txt/80">
          {logs.length === 0 ? "(no logs yet)" : logs}
        </pre>
      ) : null}
    </div>
  );
}

export function RemotePluginHostSection() {
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
        setError("Install failed — desktop bridge not available.");
        return;
      }
      setSourceDir("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh, sourceDir]);

  const handlePickFolder = useCallback(async () => {
    setError(null);
    try {
      const result = await pickDesktopWorkspaceFolder({
        promptTitle: "Select a remote plugin source directory",
      });
      if (!result) {
        setError("Folder picker unavailable — desktop bridge not connected.");
        return;
      }
      if (result.canceled) return;
      if (mountedRef.current) setSourceDir(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleStart = useCallback(async (id: string) => {
    await startDesktopRemotePluginWorker(id);
  }, []);

  const handleStop = useCallback(async (id: string) => {
    await stopDesktopRemotePluginWorker(id);
  }, []);

  const handleUninstall = useCallback(
    async (id: string, name: string) => {
      if (!window.confirm(`Uninstall "${name}"? Files will be removed.`)) {
        return;
      }
      await uninstallDesktopRemotePlugin(id);
      await refresh();
    },
    [refresh],
  );

  const remotePlugins = remotePluginsFromSnapshot(snapshot);

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          About remote plugins
        </h3>
        <p className="text-xs text-muted">
          Remote plugins are Electrobun's sandboxed mini-app primitive. Each
          runs in its own Bun Worker with a scoped state path, log file, and
          auth token.{" "}
          <span className="text-warn">
            Permissions are declared in the manifest and shown here at install —
            runtime enforcement is not wired yet. <code>bun:*</code> grants also
            depend on a Bun runtime feature (Worker permissions) that doesn't
            ship today.
          </span>{" "}
          Process isolation lands when a Bun.spawn-based runner is wired.
        </p>
        <p className="text-xs text-muted">
          <span className="text-warn">Auth token:</span> a remote plugin can
          request your API token via the host bridge and call Eliza's HTTP API
          as you. Future versions will issue per-plugin scoped tokens; the
          current bridge forwards the host token verbatim. Only install remote
          plugins from sources you trust.
        </p>
        {storeRoot ? (
          <p className="flex items-center gap-1 text-[11px] text-muted/80">
            <span>
              Store: <code>{storeRoot}</code>
            </span>
            <button
              type="button"
              className="rounded p-0.5 hover:bg-bg-3"
              title="Reveal in file manager"
              onClick={() => void desktopOpenPath(storeRoot)}
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          </p>
        ) : null}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
          Install from directory
        </h3>
        <div className="flex gap-2">
          <Input
            value={sourceDir}
            onChange={(e) => setSourceDir(e.target.value)}
            placeholder="/absolute/path/to/remote-plugin/source"
            disabled={busy}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void handlePickFolder()}
            disabled={busy}
            title="Pick a folder…"
          >
            <FolderOpen className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            onClick={() => void handleInstall()}
            disabled={busy || sourceDir.trim().length === 0}
          >
            Install
          </Button>
        </div>
        {error ? <p className="text-xs text-err">{error}</p> : null}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted">
            Installed ({remotePlugins.length})
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refresh()}
            disabled={busy}
          >
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
        </div>
        {remotePlugins.length === 0 ? (
          <p className="text-xs text-muted">
            No remote plugins installed. Try installing the bundled example at{" "}
            <code>
              packages/plugin-remote-manifest/examples/hello-remote-plugin
            </code>
            .
          </p>
        ) : (
          <div className="space-y-2">
            {remotePlugins.map((remotePlugin) => (
              <RemotePluginRow
                key={remotePlugin.id}
                remotePlugin={remotePlugin}
                status={statuses[remotePlugin.id]}
                onStart={handleStart}
                onStop={handleStop}
                onUninstall={handleUninstall}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
