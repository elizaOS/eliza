/**
 * Electrobun remote-plugin host runtime — manages install, start, stop, and
 * lifecycle for `mode: "background"` and `mode: "window"` remote plugins, plus
 * the host-side dispatcher for `bridge.requestHost(...)` host actions.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  HostActionMessage,
  HostRequestMessage,
  HostResponseMessage,
  InstalledRemotePlugin,
  InstalledRemotePluginSnapshot,
  JsonValue,
  RemotePluginInstallRecord,
  RemotePluginListEntry,
  RemotePluginPermissionGrant,
  RemotePluginRuntimeContext,
  RemotePluginStoreSnapshot,
  RemotePluginWorkerMessage,
  WorkerInitMessage,
  WorkerResponseMessage,
} from "@elizaos/plugin-remote-manifest";
import {
  buildRemotePluginRuntimeContext,
  ensureRemotePluginSourceDirectory,
  hasHostPermission,
  installPrebuiltRemotePlugin,
  loadInstalledRemotePlugin,
  loadRemotePluginListEntries,
  loadRemotePluginStoreSnapshot,
  toInstalledRemotePluginSnapshot,
  toRemotePluginListEntry,
  uninstallInstalledRemotePlugin,
} from "@elizaos/plugin-remote-manifest";
import { resolveApiToken } from "@elizaos/shared";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import { logger } from "../logger.js";
import type { SendToWebview } from "../types.js";

type RemotePluginWindowInstance = InstanceType<typeof BrowserWindow>;

export type RemotePluginWorkerState =
  | "stopped"
  | "starting"
  | "running"
  | "error";

export interface RemotePluginWorkerStatus {
  id: string;
  state: RemotePluginWorkerState;
  startedAt: number | null;
  stoppedAt: number | null;
  error: string | null;
}

export interface RemotePluginInstallFromDirectoryOptions {
  sourceDir: string;
  devMode?: boolean;
  permissionsGranted?: RemotePluginPermissionGrant;
  currentHash?: string | null;
}

export interface RemotePluginUninstallResult {
  removed: boolean;
  remotePlugin: RemotePluginListEntry | null;
}

export interface RemotePluginLogsSnapshot {
  id: string;
  path: string;
  text: string;
  truncated: boolean;
}

export interface RemotePluginWorkerHandle {
  postMessage(message: RemotePluginWorkerMessage): void;
  terminate(): void;
  onMessage(listener: (message: RemotePluginWorkerMessage) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface RemotePluginWorkerRunner {
  start(remotePlugin: InstalledRemotePlugin): RemotePluginWorkerHandle;
}

interface RemotePluginWorkerRecord {
  status: RemotePluginWorkerStatus;
  handle: RemotePluginWorkerHandle | null;
  context: RemotePluginRuntimeContext | null;
  window: RemotePluginWindowInstance | null;
}

interface RemotePluginHostEvents {
  storeChanged?: (snapshot: RemotePluginStoreSnapshot) => void;
  workerChanged?: (status: RemotePluginWorkerStatus) => void;
}

export interface RemotePluginHostOptions {
  storeRoot?: string;
  workerRunner?: RemotePluginWorkerRunner;
  now?: () => number;
  events?: RemotePluginHostEvents;
}

const REMOTE_PLUGIN_STORE_ENV_KEYS = [
  "ELIZA_CARROT_STORE_DIR",
  "ELIZA_CARROT_STORE_DIR",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveUtilsUserData(): string | null {
  const maybeUtils = Utils as typeof Utils & {
    paths?: { userData?: string };
  };
  const value = maybeUtils.paths.userData;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function resolveRemotePluginStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of REMOTE_PLUGIN_STORE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return path.resolve(value);
  }
  return path.join(
    resolveUtilsUserData() ?? path.join(os.homedir(), ".eliza"),
    "remote-plugins",
  );
}

class BrowserWorkerHandle implements RemotePluginWorkerHandle {
  constructor(private readonly worker: Worker) {}

  postMessage(message: RemotePluginWorkerMessage): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }

  onMessage(listener: (message: RemotePluginWorkerMessage) => void): void {
    this.worker.addEventListener("message", (event) => {
      listener(event.data as RemotePluginWorkerMessage);
    });
  }

  onError(listener: (error: Error) => void): void {
    this.worker.addEventListener("error", (event) => {
      listener(
        new Error(
          typeof event.message === "string"
            ? event.message
            : "Remote plugin worker failed.",
        ),
      );
    });
  }
}

class BrowserRemotePluginWorkerRunner implements RemotePluginWorkerRunner {
  start(remotePlugin: InstalledRemotePlugin): RemotePluginWorkerHandle {
    return new BrowserWorkerHandle(
      new Worker(pathToFileURL(remotePlugin.workerPath).href, {
        type: "module",
      }),
    );
  }
}

/**
 * Subprocess worker handle for `isolation: "isolated-process"`. Spawns
 * the worker entry as a fresh Bun subprocess with newline-delimited
 * JSON over stdio for the wire envelope and inherits stderr to the host
 * log. A panic in the worker only crashes itself; the host process is
 * unaffected.
 *
 * Termination policy: `terminate()` sends SIGTERM, schedules SIGKILL
 * after a 2-second grace window. The grace window gives the worker time
 * to flush any in-flight `worker-rpc-result` replies before being torn
 * down.
 */
class SubprocessWorkerHandle implements RemotePluginWorkerHandle {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly listeners = new Set<
    (message: RemotePluginWorkerMessage) => void
  >();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly decoder = new TextDecoder();
  private pendingLineBuffer = "";
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    workerEntry: string,
    runtimeContext: { cwd: string; env: Record<string, string> },
  ) {
    this.proc = Bun.spawn({
      cmd: [process.execPath, workerEntry],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      cwd: runtimeContext.cwd,
      env: runtimeContext.env,
    });
    void this.readStdout();
    void this.proc.exited.then((code) => {
      for (const listener of this.errorListeners) {
        listener(
          new Error(
            code === 0
              ? "Remote plugin worker exited."
              : `Remote plugin worker exited with code ${code}.`,
          ),
        );
      }
    });
  }

  postMessage(message: RemotePluginWorkerMessage): void {
    if (!this.proc.stdin) return;
    const writer = this.proc.stdin as unknown as { write(data: string): void };
    writer.write(`${JSON.stringify(message)}\n`);
  }

  terminate(): void {
    if (this.killTimer) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    this.killTimer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 2_000);
  }

  onMessage(listener: (message: RemotePluginWorkerMessage) => void): void {
    this.listeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
  }

  private async readStdout(): Promise<void> {
    if (!this.proc.stdout) return;
    const reader = (
      this.proc.stdout as unknown as ReadableStream<Uint8Array>
    ).getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        this.pendingLineBuffer += this.decoder.decode(value, { stream: true });
        let newlineIndex = this.pendingLineBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = this.pendingLineBuffer.slice(0, newlineIndex);
          this.pendingLineBuffer = this.pendingLineBuffer.slice(
            newlineIndex + 1,
          );
          if (line.trim()) {
            try {
              const message = JSON.parse(line) as RemotePluginWorkerMessage;
              for (const listener of this.listeners) listener(message);
            } catch (parseError) {
              for (const listener of this.errorListeners) {
                listener(
                  new Error(
                    `Remote plugin worker emitted malformed JSON: ${(parseError as Error).message}`,
                  ),
                );
              }
            }
          }
          newlineIndex = this.pendingLineBuffer.indexOf("\n");
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  }
}

/**
 * Worker runner that uses Bun.spawn for the `isolated-process`
 * isolation tier. Today's bootstrapped {@link RemotePluginHost} can opt
 * into this by constructing with `{ workerRunner: new IsolatedProcessWorkerRunner() }`
 * (and shipping a subprocess-aware
 * `@elizaos/plugin-worker-runtime/bootstrap` build for the worker side).
 */
export class IsolatedProcessWorkerRunner implements RemotePluginWorkerRunner {
  start(remotePlugin: InstalledRemotePlugin): RemotePluginWorkerHandle {
    return new SubprocessWorkerHandle(remotePlugin.workerPath, {
      cwd: remotePlugin.currentDir,
      env: {
        ...process.env,
        ELIZA_REMOTE_PLUGIN_ID: remotePlugin.manifest.id,
        ELIZA_REMOTE_PLUGIN_STATE_DIR: remotePlugin.stateDir,
        ELIZA_REMOTE_PLUGIN_CHANNEL: "stdio",
      } as Record<string, string>,
    });
  }
}

/**
 * Runner that picks shared-worker vs isolated-process per remote-plugin
 * manifest. Used as the default by {@link RemotePluginHost} so plugins
 * that declare `isolation: "isolated-process"` actually get a separate
 * process.
 */
export class AdaptiveWorkerRunner implements RemotePluginWorkerRunner {
  private readonly browser = new BrowserRemotePluginWorkerRunner();
  private readonly subprocess = new IsolatedProcessWorkerRunner();

  start(remotePlugin: InstalledRemotePlugin): RemotePluginWorkerHandle {
    return remotePlugin.install.permissionsGranted.isolation ===
      "isolated-process"
      ? this.subprocess.start(remotePlugin)
      : this.browser.start(remotePlugin);
  }
}

function stoppedStatus(id: string): RemotePluginWorkerStatus {
  return {
    id,
    state: "stopped",
    startedAt: null,
    stoppedAt: null,
    error: null,
  };
}

function buildWorkerInitMessage(
  remotePlugin: InstalledRemotePlugin,
  context: RemotePluginRuntimeContext,
): WorkerInitMessage {
  return {
    type: "init",
    manifest: remotePlugin.manifest,
    context: {
      statePath: context.statePath,
      logsPath: context.logsPath,
      permissions: context.permissions,
      grantedPermissions: context.grantedPermissions,
    },
  };
}

function hostRequestStringField(
  params: JsonValue | undefined,
  key: string,
): string {
  if (!isRecord(params)) {
    throw new Error(`Host request missing params object (expected ${key})`);
  }
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Host request missing or invalid ${key}`);
  }
  return value;
}

function actionLogPayload(message: HostActionMessage): string | null {
  if (message.action !== "log" || !isRecord(message.payload)) return null;
  const level = message.payload.level;
  const text = message.payload.message;
  if (typeof text !== "string" || text.length === 0) return null;
  return typeof level === "string" && level.length > 0
    ? `[${level}] ${text}`
    : text;
}

interface PendingInvoke {
  callerId: string;
  callerHandle: RemotePluginWorkerHandle;
  targetId: string;
  originalRequestId: number;
  timeout: ReturnType<typeof setTimeout>;
}

const INVOKE_TIMEOUT_MS = 30_000;

export class RemotePluginHost {
  private readonly storeRoot: string;
  private readonly workerRunner: RemotePluginWorkerRunner;
  private readonly now: () => number;
  private events: RemotePluginHostEvents;
  private readonly workers = new Map<string, RemotePluginWorkerRecord>();
  private readonly pendingInvokes = new Map<number, PendingInvoke>();
  private nextInvokeId = 1;

  constructor(options: RemotePluginHostOptions = {}) {
    this.storeRoot = options.storeRoot ?? resolveRemotePluginStoreRoot();
    this.workerRunner = options.workerRunner ?? new AdaptiveWorkerRunner();
    this.now = options.now ?? Date.now;
    this.events = options.events ?? {};
  }

  setEvents(events: RemotePluginHostEvents): void {
    this.events = events;
  }

  getStoreRoot(): string {
    return this.storeRoot;
  }

  listRemotePlugins(): RemotePluginListEntry[] {
    return loadRemotePluginListEntries(this.storeRoot);
  }

  getStoreSnapshot(): RemotePluginStoreSnapshot {
    return loadRemotePluginStoreSnapshot(this.storeRoot);
  }

  getRemotePlugin(id: string): InstalledRemotePluginSnapshot | null {
    const remotePlugin = loadInstalledRemotePlugin(this.storeRoot, id);
    return remotePlugin ? toInstalledRemotePluginSnapshot(remotePlugin) : null;
  }

  installFromDirectory(
    options: RemotePluginInstallFromDirectoryOptions,
  ): InstalledRemotePluginSnapshot {
    const sourceDir = ensureRemotePluginSourceDirectory(options.sourceDir);
    const remotePlugin = installPrebuiltRemotePlugin(
      this.storeRoot,
      sourceDir,
      {
        devMode: options.devMode === true,
        permissionsGranted: options.permissionsGranted,
        currentHash: options.currentHash,
        source: { kind: "local", path: sourceDir },
        now: this.now,
      },
    );
    this.emitStoreChanged();
    return toInstalledRemotePluginSnapshot(remotePlugin);
  }

  uninstall(id: string): RemotePluginUninstallResult {
    const remotePlugin = loadInstalledRemotePlugin(this.storeRoot, id);
    const entry = remotePlugin ? toRemotePluginListEntry(remotePlugin) : null;
    if (remotePlugin) {
      this.stopWorker(id);
    }
    const record = uninstallInstalledRemotePlugin(this.storeRoot, id);
    if (record) {
      this.workers.delete(id);
      this.emitStoreChanged();
    }
    return { removed: record !== null, remotePlugin: entry };
  }

  startWorker(id: string): RemotePluginWorkerStatus {
    const existing = this.workers.get(id);
    if (existing?.status.state === "running") return existing.status;
    if (existing?.status.state === "starting") return existing.status;

    const remotePlugin = loadInstalledRemotePlugin(this.storeRoot, id);
    if (!remotePlugin) {
      throw new Error(`Remote plugin is not installed: ${id}`);
    }

    fs.mkdirSync(remotePlugin.stateDir, { recursive: true });
    // Isolation is honored by the AdaptiveWorkerRunner (default):
    //  - "shared-worker"     → BrowserRemotePluginWorkerRunner (Bun Worker)
    //  - "isolated-process"  → IsolatedProcessWorkerRunner (Bun.spawn)
    // Both speak the same wire envelope; the worker bootstrap detects
    // ELIZA_REMOTE_PLUGIN_CHANNEL=stdio to choose the subprocess channel.
    const context = buildRemotePluginRuntimeContext(
      remotePlugin.currentDir,
      remotePlugin.stateDir,
      remotePlugin.manifest.id,
      remotePlugin.install.permissionsGranted,
    );
    const status: RemotePluginWorkerStatus = {
      id,
      state: "starting",
      startedAt: this.now(),
      stoppedAt: null,
      error: null,
    };
    const record: RemotePluginWorkerRecord = {
      status,
      handle: null,
      context,
      window: null,
    };
    this.workers.set(id, record);
    this.emitWorkerChanged(status);

    try {
      const handle = this.workerRunner.start(remotePlugin);
      record.handle = handle;
      handle.onMessage((message) =>
        this.handleWorkerMessage(id, handle, message),
      );
      handle.onError((error) => this.markWorkerError(id, handle, error));
      handle.postMessage(buildWorkerInitMessage(remotePlugin, context));
      if (remotePlugin.manifest.mode === "window") {
        record.window = this.openRemotePluginWindow(remotePlugin);
      }
      status.state = "running";
      this.emitWorkerChanged(status);
      return status;
    } catch (error) {
      status.state = "error";
      status.error = error instanceof Error ? error.message : String(error);
      status.stoppedAt = this.now();
      this.emitWorkerChanged(status);
      return status;
    }
  }

  /**
   * Open the remote plugin's view window. Used for `mode: "window"` remote plugins; the
   * remote-plugin's `view/index.html` (and friends) is served via Electrobun's
   * `views://` scheme rooted at `remotePlugin.currentDir`. Background remote plugins
   * never call this.
   *
   * Guarded against test stubs: vitest replaces `electrobun/bun` with a
   * non-constructor stub, so `BrowserWindow` won't be callable in the
   * test environment. We typeof-check before constructing and log a
   * warning if the runtime can't open windows (which is harmless in
   * tests and informative in dev where the host hasn't initialized FFI).
   */
  private openRemotePluginWindow(
    remotePlugin: InstalledRemotePlugin,
  ): RemotePluginWindowInstance | null {
    if (
      typeof BrowserWindow !== "function" ||
      typeof BrowserView !== "function"
    ) {
      logger.warn(
        `[remote-plugin] ${remotePlugin.manifest.id}: skipping window-mode open — Electrobun BrowserWindow not available in this runtime (typeof=${typeof BrowserWindow}).`,
      );
      return null;
    }

    const { width, height, title, titleBarStyle, transparent } =
      remotePlugin.manifest.view;
    try {
      const win = new BrowserWindow({
        title,
        url: null,
        preload: null,
        frame: { x: 120, y: 120, width, height },
        ...(titleBarStyle === undefined ? {} : { titleBarStyle }),
        ...(transparent === undefined ? {} : { transparent }),
      });
      try {
        win.webview.remove();
      } catch {
        // Some Electrobun builds expose webview lazily; safe to ignore.
      }
      new BrowserView({
        url: remotePlugin.viewUrl,
        viewsRoot: remotePlugin.currentDir,
        renderer: "cef",
        frame: { x: 0, y: 0, width, height },
        windowId: win.id,
      });
      win.on("close", () => {
        this.handleRemotePluginWindowClosed(remotePlugin.manifest.id);
      });
      return win;
    } catch (error) {
      logger.warn(
        `[remote-plugin] ${remotePlugin.manifest.id}: failed to open window — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private handleRemotePluginWindowClosed(id: string): void {
    const record = this.workers.get(id);
    if (!record) return;
    record.window = null;
    // Closing the window stops the underlying worker — `mode: "window"`
    // remote plugins have no UI-less lifetime.
    if (
      record.status.state === "running" ||
      record.status.state === "starting"
    ) {
      this.stopWorker(id);
    }
  }

  stopWorker(id: string): RemotePluginWorkerStatus {
    const record = this.workers.get(id);
    if (!record) {
      const status = stoppedStatus(id);
      this.emitWorkerChanged(status);
      return status;
    }
    this.rejectPendingInvokesForWorker(id);
    record.handle?.terminate();
    if (record.window) {
      try {
        record.window.close();
      } catch {
        // BrowserWindow.close() may throw if already destroyed.
      }
    }
    const status: RemotePluginWorkerStatus = {
      id,
      state: "stopped",
      startedAt: record.status.startedAt,
      stoppedAt: this.now(),
      error: null,
    };
    this.workers.set(id, {
      status,
      handle: null,
      context: record.context,
      window: null,
    });
    this.emitWorkerChanged(status);
    return status;
  }

  getWorkerStatus(id: string): RemotePluginWorkerStatus | null {
    const record = this.workers.get(id);
    if (record) return record.status;
    return loadInstalledRemotePlugin(this.storeRoot, id)
      ? stoppedStatus(id)
      : null;
  }

  listWorkerStatuses(): RemotePluginWorkerStatus[] {
    const statuses = new Map<string, RemotePluginWorkerStatus>();
    for (const remotePlugin of this.listRemotePlugins()) {
      statuses.set(remotePlugin.id, stoppedStatus(remotePlugin.id));
    }
    for (const [id, record] of this.workers) {
      statuses.set(id, record.status);
    }
    return Array.from(statuses.values()).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  getLogs(id: string, maxBytes = 64 * 1024): RemotePluginLogsSnapshot {
    const remotePlugin = loadInstalledRemotePlugin(this.storeRoot, id);
    if (!remotePlugin) {
      throw new Error(`Remote plugin is not installed: ${id}`);
    }
    const context = buildRemotePluginRuntimeContext(
      remotePlugin.currentDir,
      remotePlugin.stateDir,
      remotePlugin.manifest.id,
      remotePlugin.install.permissionsGranted,
    );
    if (!fs.existsSync(context.logsPath)) {
      return {
        id,
        path: context.logsPath,
        text: "",
        truncated: false,
      };
    }
    const stat = fs.statSync(context.logsPath);
    const size = Math.max(0, stat.size);
    const limit = Math.max(1, maxBytes);
    const start = Math.max(0, size - limit);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(context.logsPath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return {
      id,
      path: context.logsPath,
      text: buffer.toString("utf8"),
      truncated: start > 0,
    };
  }

  dispose(): void {
    for (const id of this.workers.keys()) {
      this.stopWorker(id);
    }
    this.events = {};
  }

  private handleWorkerMessage(
    id: string,
    handle: RemotePluginWorkerHandle,
    message: RemotePluginWorkerMessage,
  ): void {
    const record = this.workers.get(id);
    if (record?.handle !== handle) return;

    if (message.type === "ready") {
      record.status.state = "running";
      record.status.error = null;
      this.emitWorkerChanged(record.status);
      return;
    }

    if (message.type === "host-request") {
      this.handleHostRequest(id, handle, message);
      return;
    }

    if (message.type === "response") {
      this.handleWorkerResponse(id, handle, message);
      return;
    }

    if (message.type !== "action") return;
    if (!record.context) return;

    const logLine = actionLogPayload(message);
    if (logLine) {
      fs.mkdirSync(path.dirname(record.context.logsPath), { recursive: true });
      fs.appendFileSync(record.context.logsPath, `${logLine}\n`, "utf8");
      return;
    }

    if (message.action === "stop-remote-plugin") {
      this.stopWorker(id);
      return;
    }

    if (message.action === "emit-remote-plugin-event") {
      this.dispatchEmitRemotePluginEvent(id, message.payload);
    }
  }

  private dispatchEmitRemotePluginEvent(
    callerId: string,
    payload: JsonValue | undefined,
  ): void {
    if (!isRecord(payload)) return;
    const targetId = payload.remotePluginId;
    const name = payload.name;
    if (typeof targetId !== "string" || typeof name !== "string") return;
    const target = this.workers.get(targetId);
    if (!target?.handle || target.status.state !== "running") {
      logger.warn(
        `[remote-plugin] ${callerId} → emit-remote-plugin-event dropped: target ${targetId} is not running.`,
      );
      return;
    }
    target.handle.postMessage({
      type: "event",
      name,
      ...(payload.payload === undefined ? {} : { payload: payload.payload }),
    });
  }

  private handleHostRequest(
    callerId: string,
    handle: RemotePluginWorkerHandle,
    request: HostRequestMessage,
  ): void {
    if (request.method === "invoke-remote-plugin") {
      try {
        this.startInvokeRemotePlugin(callerId, handle, request);
      } catch (error) {
        this.postHostResponse(handle, {
          type: "host-response",
          requestId: request.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    void this.dispatchHostRequest(callerId, request.method, request.params)
      .then((payload) => {
        this.postHostResponse(handle, {
          type: "host-response",
          requestId: request.requestId,
          success: true,
          payload,
        });
      })
      .catch((error: unknown) => {
        this.postHostResponse(handle, {
          type: "host-response",
          requestId: request.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private startInvokeRemotePlugin(
    callerId: string,
    callerHandle: RemotePluginWorkerHandle,
    request: HostRequestMessage,
  ): void {
    this.requireManageRemotePlugins(callerId, "invoke-remote-plugin");
    if (!isRecord(request.params)) {
      throw new Error("invoke-remote-plugin: missing params object.");
    }
    const targetId = request.params.remotePluginId;
    const method = request.params.method;
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("invoke-remote-plugin: invalid remotePluginId.");
    }
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("invoke-remote-plugin: invalid method.");
    }
    const target = this.workers.get(targetId);
    if (!target?.handle || target.status.state !== "running") {
      throw new Error(
        `invoke-remote-plugin: target ${targetId} is not running.`,
      );
    }
    const targetHandle = target.handle;

    const invokeId = ++this.nextInvokeId;
    const timeout = setTimeout(() => {
      const pending = this.pendingInvokes.get(invokeId);
      if (!pending) return;
      this.pendingInvokes.delete(invokeId);
      this.postHostResponse(pending.callerHandle, {
        type: "host-response",
        requestId: pending.originalRequestId,
        success: false,
        error: `invoke-remote-plugin: target ${targetId} did not respond within ${INVOKE_TIMEOUT_MS}ms`,
      });
    }, INVOKE_TIMEOUT_MS);

    this.pendingInvokes.set(invokeId, {
      callerId,
      callerHandle,
      targetId,
      originalRequestId: request.requestId,
      timeout,
    });

    const requestParams = request.params.params;
    const windowId = request.params.windowId;
    const targetRequest: RemotePluginWorkerMessage = {
      type: "request",
      requestId: invokeId,
      method,
      ...(requestParams === undefined
        ? {}
        : { params: requestParams as JsonValue }),
      ...(typeof windowId === "string" ? { windowId } : {}),
    };
    targetHandle.postMessage(targetRequest);
  }

  private handleWorkerResponse(
    id: string,
    handle: RemotePluginWorkerHandle,
    response: WorkerResponseMessage,
  ): void {
    const record = this.workers.get(id);
    if (record?.handle !== handle) return;
    const pending = this.pendingInvokes.get(response.requestId);
    if (!pending) return;
    this.pendingInvokes.delete(response.requestId);
    clearTimeout(pending.timeout);
    this.postHostResponse(pending.callerHandle, {
      type: "host-response",
      requestId: pending.originalRequestId,
      success: response.success,
      ...(response.success
        ? response.payload === undefined
          ? {}
          : { payload: response.payload }
        : {
            error:
              response.error ?? "invoke-remote-plugin: target returned failure",
          }),
    });
  }

  private rejectPendingInvokesForWorker(id: string): void {
    for (const [invokeId, pending] of this.pendingInvokes) {
      if (pending.targetId === id) {
        this.pendingInvokes.delete(invokeId);
        clearTimeout(pending.timeout);
        this.postHostResponse(pending.callerHandle, {
          type: "host-response",
          requestId: pending.originalRequestId,
          success: false,
          error: `invoke-remote-plugin: target ${id} stopped before responding`,
        });
      } else if (pending.callerId === id) {
        this.pendingInvokes.delete(invokeId);
        clearTimeout(pending.timeout);
      }
    }
  }

  private postHostResponse(
    handle: RemotePluginWorkerHandle,
    response: HostResponseMessage,
  ): void {
    const record = [...this.workers.values()].find((r) => r.handle === handle);
    if (!record) return;
    handle.postMessage(response);
  }

  private requireManageRemotePlugins(callerId: string, action: string): void {
    const record = this.workers.get(callerId);
    const grant = record?.context?.grantedPermissions ?? null;
    if (!hasHostPermission(grant, "manage-remote-plugins")) {
      throw new Error(
        `${action}: remote plugin "${callerId}" lacks host:manage-remote-plugins permission`,
      );
    }
  }

  /**
   * Auth-token model (MVP): each remote plugin worker has its own
   * `context.authToken` stored in-process on the host. `get-auth-token` is
   * lazy — the first call seeds the slot from `resolveApiToken()` so a
   * remote plugin can call Eliza's HTTP API as the user without seeing the
   * underlying env var. `set-auth-token` lets a remote plugin REPLACE ITS OWN
   * token (Farm-login style flows); cross-remote plugin exfiltration is prevented
   * by keying read/write off the calling worker's id. The MVP forwards the
   * host token verbatim; the production hook is a per-remote plugin scoped JWT
   * issued by the auth pairing layer — schema unchanged.
   */
  private async dispatchHostRequest(
    callerId: string,
    method: string,
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    switch (method) {
      case "list-remote-plugins":
        return this.listRemotePlugins() as unknown as JsonValue;
      case "start-remote-plugin": {
        this.requireManageRemotePlugins(callerId, "start-remote-plugin");
        const targetId = hostRequestStringField(params, "id");
        this.startWorker(targetId);
        return { ok: true };
      }
      case "stop-remote-plugin": {
        this.requireManageRemotePlugins(callerId, "stop-remote-plugin");
        const targetId = hostRequestStringField(params, "id");
        this.stopWorker(targetId);
        return { ok: true };
      }
      case "get-auth-token": {
        const record = this.workers.get(callerId);
        if (!record?.context) {
          throw new Error(`Remote plugin  has no runtime context.`);
        }
        if (record.context.authToken === null) {
          record.context.authToken = resolveApiToken();
        }
        return { token: record.context.authToken };
      }
      case "invoke-remote-plugin":
        throw new Error(
          "invoke-remote-plugin must be routed through startInvokeRemotePlugin",
        );
      case "set-auth-token": {
        const record = this.workers.get(callerId);
        if (!record?.context) {
          throw new Error(`Remote plugin  has no runtime context.`);
        }
        if (!isRecord(params)) {
          throw new Error("set-auth-token: missing params object.");
        }
        const token = params.token;
        if (token !== null && typeof token !== "string") {
          throw new Error("set-auth-token: token must be a string or null.");
        }
        record.context.authToken = token;
        return { ok: true };
      }
      default:
        throw new Error(
          `Host request method not implemented: ${method} (caller=${callerId})`,
        );
    }
  }

  private markWorkerError(
    id: string,
    handle: RemotePluginWorkerHandle,
    error: Error,
  ): void {
    const record = this.workers.get(id);
    if (record?.handle !== handle) return;
    this.rejectPendingInvokesForWorker(id);
    record.status.state = "error";
    record.status.error = error.message;
    record.status.stoppedAt = this.now();
    // Don't leave an orphaned window for a dead worker — close it and
    // let the next start cycle reopen one cleanly.
    if (record.window) {
      try {
        record.window.close();
      } catch {
        // already destroyed
      }
      record.window = null;
    }
    this.emitWorkerChanged(record.status);
  }

  private emitStoreChanged(): void {
    this.events.storeChanged?.(this.getStoreSnapshot());
  }

  private emitWorkerChanged(status: RemotePluginWorkerStatus): void {
    this.events.workerChanged?.(status);
  }
}

let activeRemotePluginHost: RemotePluginHost | null = null;

export function getRemotePluginHost(): RemotePluginHost {
  activeRemotePluginHost ??= new RemotePluginHost();
  return activeRemotePluginHost;
}

export function configureRemotePluginHostEvents(
  sendToWebview: SendToWebview,
): void {
  getRemotePluginHost().setEvents({
    storeChanged: (snapshot) => {
      sendToWebview("remotePluginStoreChanged", { snapshot });
    },
    workerChanged: (status) => {
      sendToWebview("remotePluginWorkerChanged", { status });
    },
  });
}

export function resetRemotePluginHostForTesting(
  manager: RemotePluginHost | null = null,
): void {
  activeRemotePluginHost = manager;
}

export type { RemotePluginInstallRecord };
