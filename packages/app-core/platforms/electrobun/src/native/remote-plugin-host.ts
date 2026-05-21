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
  WorkerEventMessage,
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
import type { DynamicViewHost } from "../dynamic-views/host";
import { logger } from "../logger.js";
import type { TraceHost } from "../trace/trace-host-requests";
import type { SendToWebview } from "../types.js";
import type { VoiceHost } from "../voice/voice-host-requests";
import { getAgentManager, getDiagnosticLogPath } from "./agent";

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

export interface RemotePluginWorkerEventRecord {
  remotePluginId: string;
  sequence: number;
  name: string;
  payload: JsonValue | null;
  timestamp: string;
}

export interface RemotePluginWorkerEventsTailSnapshot {
  id: string;
  events: RemotePluginWorkerEventRecord[];
  nextSequence: number;
  minimumSequence: number | null;
  gapBeforeSequence: number | null;
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
  maxWorkerEvents?: number;
  events?: RemotePluginHostEvents;
  dynamicViewHost?: DynamicViewHost;
  traceHost?: TraceHost;
  voiceHost?: VoiceHost;
}

const REMOTE_PLUGIN_STORE_ENV_KEYS = [
  "MILADY_REMOTE_PLUGIN_STORE_DIR",
  "ELIZA_REMOTE_PLUGIN_STORE_DIR",
  // Deprecated: kept for backward compatibility with operators using the
  // old "carrot" vocabulary; remove after one release cycle.
  "MILADY_CARROT_STORE_DIR",
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

interface PendingDirectInvoke {
  targetId: string;
  resolve: (payload: JsonValue | null) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const INVOKE_TIMEOUT_MS = 30_000;
const DEFAULT_WORKER_EVENT_BUFFER_LIMIT = 1_000;
const DEFAULT_WORKER_EVENT_TAIL_LIMIT = 100;
const MAX_WORKER_EVENT_TAIL_LIMIT = 500;

function resolveWorkerEventBufferLimit(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw =
    env.ELIZA_REMOTE_PLUGIN_MAX_WORKER_EVENTS ?? env.ELIZA_CARROT_MAX_WORKER_EVENTS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WORKER_EVENT_BUFFER_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("ELIZA_REMOTE_PLUGIN_MAX_WORKER_EVENTS must be positive.");
  }
  return Math.floor(value);
}

function cloneEventPayload(payload: JsonValue | undefined): JsonValue | null {
  if (payload === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(payload)) as JsonValue;
  } catch (error) {
    return {
      error: "EVENT_PAYLOAD_UNSERIALIZABLE",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export class RemotePluginHost {
  private readonly storeRoot: string;
  private readonly workerRunner: RemotePluginWorkerRunner;
  private readonly now: () => number;
  private readonly maxWorkerEvents: number;
  private events: RemotePluginHostEvents;
  private readonly workers = new Map<string, RemotePluginWorkerRecord>();
  private readonly workerEvents = new Map<
    string,
    RemotePluginWorkerEventRecord[]
  >();
  private readonly workerEventSequences = new Map<string, number>();
  private readonly pendingInvokes = new Map<number, PendingInvoke>();
  private readonly pendingDirectInvokes = new Map<
    number,
    PendingDirectInvoke
  >();
  private dynamicViewHost: DynamicViewHost | null;
  private traceHost: TraceHost | null;
  private voiceHost: VoiceHost | null;
  private nextInvokeId = 1;

  constructor(options: RemotePluginHostOptions = {}) {
    this.storeRoot = options.storeRoot ?? resolveRemotePluginStoreRoot();
    this.workerRunner = options.workerRunner ?? new AdaptiveWorkerRunner();
    this.now = options.now ?? Date.now;
    this.maxWorkerEvents =
      options.maxWorkerEvents ?? resolveWorkerEventBufferLimit();
    this.events = options.events ?? {};
    this.dynamicViewHost = options.dynamicViewHost ?? null;
    this.traceHost = options.traceHost ?? null;
    this.voiceHost = options.voiceHost ?? null;
  }

  setEvents(events: RemotePluginHostEvents): void {
    this.events = events;
  }

  setDynamicViewHost(host: DynamicViewHost | null): void {
    this.dynamicViewHost = host;
  }

  setTraceHost(host: TraceHost | null): void {
    this.traceHost = host;
  }

  setVoiceHost(host: VoiceHost | null): void {
    this.voiceHost = host;
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
      this.workerEvents.delete(id);
      this.workerEventSequences.delete(id);
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
    this.workerEvents.set(id, []);
    this.workerEventSequences.set(id, 0);
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
    this.workerEvents.delete(id);
    this.workerEventSequences.delete(id);
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

  invokeWorker(options: {
    id: string;
    method: string;
    params?: JsonValue;
    windowId?: string;
  }): Promise<JsonValue | null> {
    if (options.id.length === 0) {
      throw new Error("remote-plugin invoke: invalid id.");
    }
    if (options.method.length === 0) {
      throw new Error("remote-plugin invoke: invalid method.");
    }
    const target = this.workers.get(options.id);
    if (!target?.handle || target.status.state !== "running") {
      throw new Error(
        `remote-plugin invoke: target ${options.id} is not running.`,
      );
    }
    const requestId = ++this.nextInvokeId;
    const timeout = setTimeout(() => {
      const pending = this.pendingDirectInvokes.get(requestId);
      if (!pending) return;
      this.pendingDirectInvokes.delete(requestId);
      pending.reject(
        new Error(
          `remote-plugin invoke: target ${options.id} did not respond within ${INVOKE_TIMEOUT_MS}ms`,
        ),
      );
    }, INVOKE_TIMEOUT_MS);

    const promise = new Promise<JsonValue | null>((resolve, reject) => {
      this.pendingDirectInvokes.set(requestId, {
        targetId: options.id,
        resolve,
        reject,
        timeout,
      });
    });
    target.handle.postMessage({
      type: "request",
      requestId,
      method: options.method,
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(typeof options.windowId === "string"
        ? { windowId: options.windowId }
        : {}),
    });
    return promise;
  }

  tailWorkerEvents(options: {
    id: string;
    afterSequence?: number;
    limit?: number;
  }): RemotePluginWorkerEventsTailSnapshot {
    const record = this.workers.get(options.id);
    if (!record?.handle || record.status.state !== "running") {
      throw new Error(
        `remote-plugin events: target ${options.id} is not running.`,
      );
    }
    const limit = this.normalizeEventTailLimit(options.limit);
    const events = this.workerEvents.get(options.id) ?? [];
    const afterSequence = options.afterSequence;
    const filtered =
      typeof afterSequence === "number"
        ? events.filter((event) => event.sequence > afterSequence)
        : events.slice(-limit);
    const selected = filtered.slice(0, limit);
    const currentSequence = this.workerEventSequences.get(options.id) ?? 0;
    const minimumSequence = events[0]?.sequence ?? null;
    const gapBeforeSequence =
      typeof afterSequence === "number" &&
      minimumSequence !== null &&
      afterSequence < minimumSequence - 1
        ? minimumSequence
        : null;
    return {
      id: options.id,
      events: selected,
      nextSequence:
        selected.length > 0
          ? selected[selected.length - 1].sequence
          : (afterSequence ?? currentSequence),
      minimumSequence,
      gapBeforeSequence,
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

    if (message.type === "event") {
      this.recordWorkerEvent(id, message);
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

  private recordWorkerEvent(id: string, message: WorkerEventMessage): void {
    const sequence = (this.workerEventSequences.get(id) ?? 0) + 1;
    this.workerEventSequences.set(id, sequence);
    const event: RemotePluginWorkerEventRecord = {
      remotePluginId: id,
      sequence,
      name: message.name,
      payload: cloneEventPayload(message.payload),
      timestamp: new Date(this.now()).toISOString(),
    };
    const events = this.workerEvents.get(id) ?? [];
    events.push(event);
    if (events.length > this.maxWorkerEvents) {
      events.splice(0, events.length - this.maxWorkerEvents);
    }
    this.workerEvents.set(id, events);
  }

  private normalizeEventTailLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_WORKER_EVENT_TAIL_LIMIT;
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error("remote-plugin events: limit must be positive.");
    }
    return Math.min(Math.floor(limit), MAX_WORKER_EVENT_TAIL_LIMIT);
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
    if (!pending) {
      this.handleDirectWorkerResponse(response);
      return;
    }
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

  private handleDirectWorkerResponse(response: WorkerResponseMessage): void {
    const pending = this.pendingDirectInvokes.get(response.requestId);
    if (!pending) return;
    this.pendingDirectInvokes.delete(response.requestId);
    clearTimeout(pending.timeout);
    if (response.success) {
      pending.resolve(response.payload ?? null);
    } else {
      pending.reject(
        new Error(
          response.error ?? "remote-plugin invoke: target returned failure",
        ),
      );
    }
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
    for (const [invokeId, pending] of this.pendingDirectInvokes) {
      if (pending.targetId !== id) continue;
      this.pendingDirectInvokes.delete(invokeId);
      clearTimeout(pending.timeout);
      pending.reject(
        new Error(
          `remote-plugin invoke: target ${id} stopped before responding`,
        ),
      );
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
   * remote plugin can call Milady's HTTP API as the user without seeing the
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
      case "agent-manager-start":
        this.requireManageRemotePlugins(callerId, "agent-manager-start");
        return (await getAgentManager().start()) as unknown as JsonValue;
      case "agent-manager-stop": {
        this.requireManageRemotePlugins(callerId, "agent-manager-stop");
        await getAgentManager().stop();
        return getAgentManager().getStatus() as unknown as JsonValue;
      }
      case "agent-manager-restart":
        this.requireManageRemotePlugins(callerId, "agent-manager-restart");
        return (await getAgentManager().restart()) as unknown as JsonValue;
      case "agent-manager-status":
        this.requireManageRemotePlugins(callerId, "agent-manager-status");
        return getAgentManager().getStatus() as unknown as JsonValue;
      case "agent-manager-health":
        this.requireManageRemotePlugins(callerId, "agent-manager-health");
        return this.readAgentManagerHealth();
      case "agent-manager-logs-tail":
        this.requireManageRemotePlugins(callerId, "agent-manager-logs-tail");
        return this.readAgentManagerLogsTail(params);
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
      case "dynamic-view-register":
        this.requireManageRemotePlugins(callerId, "dynamic-view-register");
        return this.requireDynamicViewHost(method).register(params);
      case "dynamic-view-unregister":
        this.requireManageRemotePlugins(callerId, "dynamic-view-unregister");
        return this.requireDynamicViewHost(method).unregister(params);
      case "dynamic-view-list":
        this.requireManageRemotePlugins(callerId, "dynamic-view-list");
        return this.requireDynamicViewHost(method).list();
      case "dynamic-view-open":
        this.requireManageRemotePlugins(callerId, "dynamic-view-open");
        return this.requireDynamicViewHost(method).open(params);
      case "dynamic-view-close":
        this.requireManageRemotePlugins(callerId, "dynamic-view-close");
        return this.requireDynamicViewHost(method).close(params);
      case "dynamic-view-push":
        this.requireManageRemotePlugins(callerId, "dynamic-view-push");
        return this.requireDynamicViewHost(method).push(params);
      case "dynamic-view-sessions":
        this.requireManageRemotePlugins(callerId, "dynamic-view-sessions");
        return this.requireDynamicViewHost(method).sessions();
      case "trace-session-start":
        this.requireManageRemotePlugins(callerId, "trace-session-start");
        return this.requireTraceHost(method).startSession(params);
      case "trace-session-complete":
        this.requireManageRemotePlugins(callerId, "trace-session-complete");
        return this.requireTraceHost(method).completeSession(params);
      case "trace-session-cancel":
        this.requireManageRemotePlugins(callerId, "trace-session-cancel");
        return this.requireTraceHost(method).cancelSession(params);
      case "trace-session-error":
        this.requireManageRemotePlugins(callerId, "trace-session-error");
        return this.requireTraceHost(method).errorSession(params);
      case "trace-event-record":
        this.requireManageRemotePlugins(callerId, "trace-event-record");
        return this.requireTraceHost(method).recordEvent(params);
      case "trace-session-list":
        this.requireManageRemotePlugins(callerId, "trace-session-list");
        return this.requireTraceHost(method).listSessions(params);
      case "trace-session-get":
        this.requireManageRemotePlugins(callerId, "trace-session-get");
        return this.requireTraceHost(method).getSession(params);
      case "trace-session-summary":
        this.requireManageRemotePlugins(callerId, "trace-session-summary");
        return this.requireTraceHost(method).summarizeSession(params);
      case "trace-events-tail":
        this.requireManageRemotePlugins(callerId, "trace-events-tail");
        return this.requireTraceHost(method).tailEvents(params);
      case "trace-events-search":
        this.requireManageRemotePlugins(callerId, "trace-events-search");
        return this.requireTraceHost(method).searchEvents(params);
      case "trace-view-open":
        this.requireManageRemotePlugins(callerId, "trace-view-open");
        return this.requireTraceHost(method).openTraceView(params);
      case "voice-status":
        this.requireManageRemotePlugins(callerId, "voice-status");
        return this.requireVoiceHost(method).status();
      case "voice-components":
        this.requireManageRemotePlugins(callerId, "voice-components");
        return this.requireVoiceHost(method).components();
      case "voice-start":
        this.requireManageRemotePlugins(callerId, "voice-start");
        return this.requireVoiceHost(method).start(params);
      case "voice-stop":
        this.requireManageRemotePlugins(callerId, "voice-stop");
        return this.requireVoiceHost(method).stop(params);
      case "voice-interrupt":
        this.requireManageRemotePlugins(callerId, "voice-interrupt");
        return this.requireVoiceHost(method).interrupt(params);
      case "voice-inject-transcript":
        this.requireManageRemotePlugins(callerId, "voice-inject-transcript");
        return this.requireVoiceHost(method).injectTranscript(params);
      case "voice-speak":
        this.requireManageRemotePlugins(callerId, "voice-speak");
        return this.requireVoiceHost(method).speak(params);
      case "voice-transcribe-audio":
        this.requireManageRemotePlugins(callerId, "voice-transcribe-audio");
        return this.requireVoiceHost(method).transcribeAudio(params);
      case "voice-synthesize-speech":
        this.requireManageRemotePlugins(callerId, "voice-synthesize-speech");
        return this.requireVoiceHost(method).synthesizeSpeech(params);
      case "voice-latency":
        this.requireManageRemotePlugins(callerId, "voice-latency");
        return this.requireVoiceHost(method).latency();
      case "voice-recent-turns":
        this.requireManageRemotePlugins(callerId, "voice-recent-turns");
        return this.requireVoiceHost(method).recentTurns(params);
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

  private async readAgentManagerHealth(): Promise<JsonValue> {
    const status = getAgentManager().getStatus();
    if (status.port === null) {
      return {
        ok: false,
        apiBase: null,
        path: "/api/health",
        status: null,
        error: "AgentManager has no active API port.",
        agentStatus: status as unknown as JsonValue,
      };
    }
    const apiBase = `http://127.0.0.1:${status.port}`;
    try {
      const response = await fetch(`${apiBase}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      return {
        ok: response.ok,
        apiBase,
        path: "/api/health",
        status: response.status,
        body: await response.text(),
        agentStatus: status as unknown as JsonValue,
      };
    } catch (error) {
      return {
        ok: false,
        apiBase,
        path: "/api/health",
        status: null,
        error: error instanceof Error ? error.message : String(error),
        agentStatus: status as unknown as JsonValue,
      };
    }
  }

  private requireDynamicViewHost(method: string): DynamicViewHost {
    if (!this.dynamicViewHost) {
      throw new Error(`${method}: dynamic view host is not configured.`);
    }
    return this.dynamicViewHost;
  }

  private requireTraceHost(method: string): TraceHost {
    if (!this.traceHost) {
      throw new Error(`${method}: trace host is not configured.`);
    }
    return this.traceHost;
  }

  private requireVoiceHost(method: string): VoiceHost {
    if (!this.voiceHost) {
      throw new Error(`${method}: voice host is not configured.`);
    }
    return this.voiceHost;
  }

  private readAgentManagerLogsTail(params: JsonValue | undefined): JsonValue {
    const maxBytes = this.readLogMaxBytes(params);
    const logPath = getDiagnosticLogPath();
    if (!fs.existsSync(logPath)) {
      return { path: logPath, text: "", truncated: false };
    }
    const stat = fs.statSync(logPath);
    const size = Math.max(0, stat.size);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    return {
      path: logPath,
      text: buffer.toString("utf8"),
      truncated: start > 0,
    };
  }

  private readLogMaxBytes(params: JsonValue | undefined): number {
    if (params === undefined) return 64 * 1024;
    if (!isRecord(params)) {
      throw new Error("agent-manager-logs-tail: params must be an object.");
    }
    const value = params.maxBytes;
    if (value === undefined) return 64 * 1024;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      throw new Error("agent-manager-logs-tail: maxBytes must be positive.");
    }
    return Math.floor(value);
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
