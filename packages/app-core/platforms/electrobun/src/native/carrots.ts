/**
 * Electrobun carrot host runtime — manages install, start, stop, and
 * lifecycle for `mode: "background"` and `mode: "window"` carrots, plus
 * the host-side dispatcher for `bridge.requestHost(...)` host actions.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CarrotInstallRecord,
  CarrotListEntry,
  CarrotPermissionGrant,
  CarrotRuntimeContext,
  CarrotStoreSnapshot,
  CarrotWorkerMessage,
  HostActionMessage,
  HostRequestMessage,
  HostResponseMessage,
  InstalledCarrot,
  InstalledCarrotSnapshot,
  JsonValue,
  WorkerInitMessage,
  WorkerEventMessage,
  WorkerResponseMessage,
} from "@elizaos/electrobun-carrots";
import {
  buildCarrotRuntimeContext,
  ensureCarrotSourceDirectory,
  hasHostPermission,
  installPrebuiltCarrot,
  loadCarrotListEntries,
  loadCarrotStoreSnapshot,
  loadInstalledCarrot,
  toCarrotListEntry,
  toInstalledCarrotSnapshot,
  uninstallInstalledCarrot,
} from "@elizaos/electrobun-carrots";
import { resolveApiToken } from "@elizaos/shared";
import { BrowserView, BrowserWindow, Utils } from "electrobun/bun";
import type { DynamicViewHost } from "../dynamic-views/host";
import { logger } from "../logger.js";
import type { TraceHost } from "../trace/trace-host-requests";
import type { SendToWebview } from "../types.js";
import type { VoiceHost } from "../voice/voice-host-requests";
import { getAgentManager, getDiagnosticLogPath } from "./agent";

type CarrotWindowInstance = InstanceType<typeof BrowserWindow>;

export type CarrotWorkerState = "stopped" | "starting" | "running" | "error";

export interface CarrotWorkerStatus {
  id: string;
  state: CarrotWorkerState;
  startedAt: number | null;
  stoppedAt: number | null;
  error: string | null;
}

export interface CarrotInstallFromDirectoryOptions {
  sourceDir: string;
  devMode?: boolean;
  permissionsGranted?: CarrotPermissionGrant;
  currentHash?: string | null;
}

export interface CarrotUninstallResult {
  removed: boolean;
  carrot: CarrotListEntry | null;
}

export interface CarrotLogsSnapshot {
  id: string;
  path: string;
  text: string;
  truncated: boolean;
}

export interface CarrotWorkerEventRecord {
  carrotId: string;
  satelliteId: string;
  sequence: number;
  name: string;
  payload: JsonValue | null;
  timestamp: string;
}

export interface CarrotWorkerEventsTailSnapshot {
  id: string;
  events: CarrotWorkerEventRecord[];
  nextSequence: number;
}

export interface CarrotWorkerHandle {
  postMessage(message: CarrotWorkerMessage): void;
  terminate(): void;
  onMessage(listener: (message: CarrotWorkerMessage) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface CarrotWorkerRunner {
  start(carrot: InstalledCarrot): CarrotWorkerHandle;
}

interface CarrotWorkerRecord {
  status: CarrotWorkerStatus;
  handle: CarrotWorkerHandle | null;
  context: CarrotRuntimeContext | null;
  window: CarrotWindowInstance | null;
}

interface CarrotManagerEvents {
  storeChanged?: (snapshot: CarrotStoreSnapshot) => void;
  workerChanged?: (status: CarrotWorkerStatus) => void;
}

export interface CarrotManagerOptions {
  storeRoot?: string;
  workerRunner?: CarrotWorkerRunner;
  now?: () => number;
  events?: CarrotManagerEvents;
  dynamicViewHost?: DynamicViewHost;
  traceHost?: TraceHost;
  voiceHost?: VoiceHost;
}

const CARROT_STORE_ENV_KEYS = [
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

export function resolveCarrotStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const key of CARROT_STORE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) return path.resolve(value);
  }
  return path.join(
    resolveUtilsUserData() ?? path.join(os.homedir(), ".eliza"),
    "carrots",
  );
}

class BrowserWorkerHandle implements CarrotWorkerHandle {
  constructor(private readonly worker: Worker) {}

  postMessage(message: CarrotWorkerMessage): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }

  onMessage(listener: (message: CarrotWorkerMessage) => void): void {
    this.worker.addEventListener("message", (event) => {
      listener(event.data as CarrotWorkerMessage);
    });
  }

  onError(listener: (error: Error) => void): void {
    this.worker.addEventListener("error", (event) => {
      listener(
        new Error(
          typeof event.message === "string"
            ? event.message
            : "Carrot worker failed.",
        ),
      );
    });
  }
}

class BrowserCarrotWorkerRunner implements CarrotWorkerRunner {
  start(carrot: InstalledCarrot): CarrotWorkerHandle {
    return new BrowserWorkerHandle(
      new Worker(pathToFileURL(carrot.workerPath).href, { type: "module" }),
    );
  }
}

function stoppedStatus(id: string): CarrotWorkerStatus {
  return {
    id,
    state: "stopped",
    startedAt: null,
    stoppedAt: null,
    error: null,
  };
}

function buildWorkerInitMessage(
  carrot: InstalledCarrot,
  context: CarrotRuntimeContext,
): WorkerInitMessage {
  return {
    type: "init",
    manifest: carrot.manifest,
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
  callerHandle: CarrotWorkerHandle;
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
  const raw = env.ELIZA_CARROT_MAX_WORKER_EVENTS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WORKER_EVENT_BUFFER_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("ELIZA_CARROT_MAX_WORKER_EVENTS must be positive.");
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

export class CarrotManager {
  private readonly storeRoot: string;
  private readonly workerRunner: CarrotWorkerRunner;
  private readonly now: () => number;
  private readonly maxWorkerEvents: number;
  private events: CarrotManagerEvents;
  private readonly workers = new Map<string, CarrotWorkerRecord>();
  private readonly workerEvents = new Map<string, CarrotWorkerEventRecord[]>();
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

  constructor(options: CarrotManagerOptions = {}) {
    this.storeRoot = options.storeRoot ?? resolveCarrotStoreRoot();
    this.workerRunner = options.workerRunner ?? new BrowserCarrotWorkerRunner();
    this.now = options.now ?? Date.now;
    this.maxWorkerEvents = resolveWorkerEventBufferLimit();
    this.events = options.events ?? {};
    this.dynamicViewHost = options.dynamicViewHost ?? null;
    this.traceHost = options.traceHost ?? null;
    this.voiceHost = options.voiceHost ?? null;
  }

  setEvents(events: CarrotManagerEvents): void {
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

  listCarrots(): CarrotListEntry[] {
    return loadCarrotListEntries(this.storeRoot);
  }

  getStoreSnapshot(): CarrotStoreSnapshot {
    return loadCarrotStoreSnapshot(this.storeRoot);
  }

  getCarrot(id: string): InstalledCarrotSnapshot | null {
    const carrot = loadInstalledCarrot(this.storeRoot, id);
    return carrot ? toInstalledCarrotSnapshot(carrot) : null;
  }

  installFromDirectory(
    options: CarrotInstallFromDirectoryOptions,
  ): InstalledCarrotSnapshot {
    const sourceDir = ensureCarrotSourceDirectory(options.sourceDir);
    const carrot = installPrebuiltCarrot(this.storeRoot, sourceDir, {
      devMode: options.devMode === true,
      permissionsGranted: options.permissionsGranted,
      currentHash: options.currentHash,
      source: { kind: "local", path: sourceDir },
      now: this.now,
    });
    this.emitStoreChanged();
    return toInstalledCarrotSnapshot(carrot);
  }

  uninstall(id: string): CarrotUninstallResult {
    const carrot = loadInstalledCarrot(this.storeRoot, id);
    const entry = carrot ? toCarrotListEntry(carrot) : null;
    if (carrot) {
      this.stopWorker(id);
    }
    const record = uninstallInstalledCarrot(this.storeRoot, id);
    if (record) {
      this.workers.delete(id);
      this.workerEvents.delete(id);
      this.workerEventSequences.delete(id);
      this.emitStoreChanged();
    }
    return { removed: record !== null, carrot: entry };
  }

  startWorker(id: string): CarrotWorkerStatus {
    const existing = this.workers.get(id);
    if (existing?.status.state === "running") return existing.status;
    if (existing?.status.state === "starting") return existing.status;

    const carrot = loadInstalledCarrot(this.storeRoot, id);
    if (!carrot) {
      throw new Error(`Carrot is not installed: ${id}`);
    }

    fs.mkdirSync(carrot.stateDir, { recursive: true });
    if (carrot.install.permissionsGranted.isolation === "isolated-process") {
      logger.warn(
        `[carrots] ${id}: manifest requests isolation:isolated-process but the host runs all carrots as shared-worker today; falling back. Process isolation lands when a Bun.spawn-based runner is wired.`,
      );
    }
    const context = buildCarrotRuntimeContext(
      carrot.currentDir,
      carrot.stateDir,
      carrot.manifest.id,
      carrot.install.permissionsGranted,
    );
    const status: CarrotWorkerStatus = {
      id,
      state: "starting",
      startedAt: this.now(),
      stoppedAt: null,
      error: null,
    };
    const record: CarrotWorkerRecord = {
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
      const handle = this.workerRunner.start(carrot);
      record.handle = handle;
      handle.onMessage((message) =>
        this.handleWorkerMessage(id, handle, message),
      );
      handle.onError((error) => this.markWorkerError(id, handle, error));
      handle.postMessage(buildWorkerInitMessage(carrot, context));
      if (carrot.manifest.mode === "window") {
        record.window = this.openCarrotWindow(carrot);
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
   * Open the carrot's view window. Used for `mode: "window"` carrots; the
   * carrot's `view/index.html` (and friends) is served via Electrobun's
   * `views://` scheme rooted at `carrot.currentDir`. Background carrots
   * never call this.
   *
   * Guarded against test stubs: vitest replaces `electrobun/bun` with a
   * non-constructor stub, so `BrowserWindow` won't be callable in the
   * test environment. We typeof-check before constructing and log a
   * warning if the runtime can't open windows (which is harmless in
   * tests and informative in dev where the host hasn't initialized FFI).
   */
  private openCarrotWindow(
    carrot: InstalledCarrot,
  ): CarrotWindowInstance | null {
    if (
      typeof BrowserWindow !== "function" ||
      typeof BrowserView !== "function"
    ) {
      logger.warn(
        `[carrots] ${carrot.manifest.id}: skipping window-mode open — Electrobun BrowserWindow not available in this runtime (typeof=${typeof BrowserWindow}).`,
      );
      return null;
    }

    const { width, height, title, titleBarStyle, transparent } =
      carrot.manifest.view;
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
        url: carrot.viewUrl,
        viewsRoot: carrot.currentDir,
        renderer: "cef",
        frame: { x: 0, y: 0, width, height },
        windowId: win.id,
      });
      win.on("close", () => {
        this.handleCarrotWindowClosed(carrot.manifest.id);
      });
      return win;
    } catch (error) {
      logger.warn(
        `[carrots] ${carrot.manifest.id}: failed to open window — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private handleCarrotWindowClosed(id: string): void {
    const record = this.workers.get(id);
    if (!record) return;
    record.window = null;
    // Closing the window stops the underlying worker — `mode: "window"`
    // carrots have no UI-less lifetime.
    if (
      record.status.state === "running" ||
      record.status.state === "starting"
    ) {
      this.stopWorker(id);
    }
  }

  stopWorker(id: string): CarrotWorkerStatus {
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
    const status: CarrotWorkerStatus = {
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

  getWorkerStatus(id: string): CarrotWorkerStatus | null {
    const record = this.workers.get(id);
    if (record) return record.status;
    return loadInstalledCarrot(this.storeRoot, id) ? stoppedStatus(id) : null;
  }

  listWorkerStatuses(): CarrotWorkerStatus[] {
    const statuses = new Map<string, CarrotWorkerStatus>();
    for (const carrot of this.listCarrots()) {
      statuses.set(carrot.id, stoppedStatus(carrot.id));
    }
    for (const [id, record] of this.workers) {
      statuses.set(id, record.status);
    }
    return Array.from(statuses.values()).sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  getLogs(id: string, maxBytes = 64 * 1024): CarrotLogsSnapshot {
    const carrot = loadInstalledCarrot(this.storeRoot, id);
    if (!carrot) {
      throw new Error(`Carrot is not installed: ${id}`);
    }
    const context = buildCarrotRuntimeContext(
      carrot.currentDir,
      carrot.stateDir,
      carrot.manifest.id,
      carrot.install.permissionsGranted,
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
      throw new Error("carrot invoke: invalid id.");
    }
    if (options.method.length === 0) {
      throw new Error("carrot invoke: invalid method.");
    }
    const target = this.workers.get(options.id);
    if (!target?.handle || target.status.state !== "running") {
      throw new Error(`carrot invoke: target ${options.id} is not running.`);
    }
    const requestId = ++this.nextInvokeId;
    const timeout = setTimeout(() => {
      const pending = this.pendingDirectInvokes.get(requestId);
      if (!pending) return;
      this.pendingDirectInvokes.delete(requestId);
      pending.reject(
        new Error(
          `carrot invoke: target ${options.id} did not respond within ${INVOKE_TIMEOUT_MS}ms`,
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
  }): CarrotWorkerEventsTailSnapshot {
    const record = this.workers.get(options.id);
    if (!record?.handle || record.status.state !== "running") {
      throw new Error(`carrot events: target ${options.id} is not running.`);
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
    return {
      id: options.id,
      events: selected,
      nextSequence:
        selected.length > 0
          ? selected[selected.length - 1].sequence
          : (afterSequence ?? currentSequence),
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
    handle: CarrotWorkerHandle,
    message: CarrotWorkerMessage,
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

    if (message.action === "stop-carrot") {
      this.stopWorker(id);
      return;
    }

    if (message.action === "emit-carrot-event") {
      this.dispatchEmitCarrotEvent(id, message.payload);
    }
  }

  private dispatchEmitCarrotEvent(
    callerId: string,
    payload: JsonValue | undefined,
  ): void {
    if (!isRecord(payload)) return;
    const targetId = payload.carrotId;
    const name = payload.name;
    if (typeof targetId !== "string" || typeof name !== "string") return;
    const target = this.workers.get(targetId);
    if (!target?.handle || target.status.state !== "running") {
      logger.warn(
        `[carrots] ${callerId} → emit-carrot-event dropped: target ${targetId} is not running.`,
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
    const event: CarrotWorkerEventRecord = {
      carrotId: id,
      satelliteId: id,
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
      throw new Error("carrot events: limit must be positive.");
    }
    return Math.min(Math.floor(limit), MAX_WORKER_EVENT_TAIL_LIMIT);
  }

  private handleHostRequest(
    callerId: string,
    handle: CarrotWorkerHandle,
    request: HostRequestMessage,
  ): void {
    if (request.method === "invoke-carrot") {
      try {
        this.startInvokeCarrot(callerId, handle, request);
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

  private startInvokeCarrot(
    callerId: string,
    callerHandle: CarrotWorkerHandle,
    request: HostRequestMessage,
  ): void {
    this.requireManageCarrots(callerId, "invoke-carrot");
    if (!isRecord(request.params)) {
      throw new Error("invoke-carrot: missing params object.");
    }
    const targetId = request.params.carrotId;
    const method = request.params.method;
    if (typeof targetId !== "string" || targetId.length === 0) {
      throw new Error("invoke-carrot: invalid carrotId.");
    }
    if (typeof method !== "string" || method.length === 0) {
      throw new Error("invoke-carrot: invalid method.");
    }
    const target = this.workers.get(targetId);
    if (!target?.handle || target.status.state !== "running") {
      throw new Error(`invoke-carrot: target ${targetId} is not running.`);
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
        error: `invoke-carrot: target ${targetId} did not respond within ${INVOKE_TIMEOUT_MS}ms`,
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
    const targetRequest: CarrotWorkerMessage = {
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
    handle: CarrotWorkerHandle,
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
            error: response.error ?? "invoke-carrot: target returned failure",
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
        new Error(response.error ?? "carrot invoke: target returned failure"),
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
          error: `invoke-carrot: target ${id} stopped before responding`,
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
        new Error(`carrot invoke: target ${id} stopped before responding`),
      );
    }
  }

  private postHostResponse(
    handle: CarrotWorkerHandle,
    response: HostResponseMessage,
  ): void {
    const record = [...this.workers.values()].find((r) => r.handle === handle);
    if (!record) return;
    handle.postMessage(response);
  }

  private requireManageCarrots(callerId: string, action: string): void {
    const record = this.workers.get(callerId);
    const grant = record?.context?.grantedPermissions ?? null;
    if (!hasHostPermission(grant, "manage-carrots")) {
      throw new Error(
        `${action}: carrot "${callerId}" lacks host:manage-carrots permission`,
      );
    }
  }

  /**
   * Auth-token model (MVP): each carrot worker has its own
   * `context.authToken` stored in-process on the host. `get-auth-token` is
   * lazy — the first call seeds the slot from `resolveApiToken()` so a
   * carrot can call Milady's HTTP API as the user without seeing the
   * underlying env var. `set-auth-token` lets a carrot REPLACE ITS OWN
   * token (Farm-login style flows); cross-carrot exfiltration is prevented
   * by keying read/write off the calling worker's id. The MVP forwards the
   * host token verbatim; the production hook is a per-carrot scoped JWT
   * issued by the auth pairing layer — schema unchanged.
   */
  private async dispatchHostRequest(
    callerId: string,
    method: string,
    params: JsonValue | undefined,
  ): Promise<JsonValue> {
    switch (method) {
      case "list-carrots":
        return this.listCarrots() as unknown as JsonValue;
      case "start-carrot": {
        this.requireManageCarrots(callerId, "start-carrot");
        const targetId = hostRequestStringField(params, "id");
        this.startWorker(targetId);
        return { ok: true };
      }
      case "stop-carrot": {
        this.requireManageCarrots(callerId, "stop-carrot");
        const targetId = hostRequestStringField(params, "id");
        this.stopWorker(targetId);
        return { ok: true };
      }
      case "agent-manager-start":
        this.requireManageCarrots(callerId, "agent-manager-start");
        return (await getAgentManager().start()) as unknown as JsonValue;
      case "agent-manager-stop": {
        this.requireManageCarrots(callerId, "agent-manager-stop");
        await getAgentManager().stop();
        return getAgentManager().getStatus() as unknown as JsonValue;
      }
      case "agent-manager-restart":
        this.requireManageCarrots(callerId, "agent-manager-restart");
        return (await getAgentManager().restart()) as unknown as JsonValue;
      case "agent-manager-status":
        this.requireManageCarrots(callerId, "agent-manager-status");
        return getAgentManager().getStatus() as unknown as JsonValue;
      case "agent-manager-health":
        this.requireManageCarrots(callerId, "agent-manager-health");
        return this.readAgentManagerHealth();
      case "agent-manager-logs-tail":
        this.requireManageCarrots(callerId, "agent-manager-logs-tail");
        return this.readAgentManagerLogsTail(params);
      case "get-auth-token": {
        const record = this.workers.get(callerId);
        if (!record?.context) {
          throw new Error(`Carrot ${callerId} has no runtime context.`);
        }
        if (record.context.authToken === null) {
          record.context.authToken = resolveApiToken();
        }
        return { token: record.context.authToken };
      }
      case "invoke-carrot":
        throw new Error(
          "invoke-carrot must be routed through startInvokeCarrot",
        );
      case "dynamic-view-register":
        this.requireManageCarrots(callerId, "dynamic-view-register");
        return this.requireDynamicViewHost(method).register(params);
      case "dynamic-view-unregister":
        this.requireManageCarrots(callerId, "dynamic-view-unregister");
        return this.requireDynamicViewHost(method).unregister(params);
      case "dynamic-view-list":
        this.requireManageCarrots(callerId, "dynamic-view-list");
        return this.requireDynamicViewHost(method).list();
      case "dynamic-view-open":
        this.requireManageCarrots(callerId, "dynamic-view-open");
        return this.requireDynamicViewHost(method).open(params);
      case "dynamic-view-close":
        this.requireManageCarrots(callerId, "dynamic-view-close");
        return this.requireDynamicViewHost(method).close(params);
      case "dynamic-view-push":
        this.requireManageCarrots(callerId, "dynamic-view-push");
        return this.requireDynamicViewHost(method).push(params);
      case "dynamic-view-sessions":
        this.requireManageCarrots(callerId, "dynamic-view-sessions");
        return this.requireDynamicViewHost(method).sessions();
      case "trace-session-start":
        this.requireManageCarrots(callerId, "trace-session-start");
        return this.requireTraceHost(method).startSession(params);
      case "trace-session-complete":
        this.requireManageCarrots(callerId, "trace-session-complete");
        return this.requireTraceHost(method).completeSession(params);
      case "trace-session-cancel":
        this.requireManageCarrots(callerId, "trace-session-cancel");
        return this.requireTraceHost(method).cancelSession(params);
      case "trace-session-error":
        this.requireManageCarrots(callerId, "trace-session-error");
        return this.requireTraceHost(method).errorSession(params);
      case "trace-event-record":
        this.requireManageCarrots(callerId, "trace-event-record");
        return this.requireTraceHost(method).recordEvent(params);
      case "trace-session-list":
        this.requireManageCarrots(callerId, "trace-session-list");
        return this.requireTraceHost(method).listSessions(params);
      case "trace-session-get":
        this.requireManageCarrots(callerId, "trace-session-get");
        return this.requireTraceHost(method).getSession(params);
      case "trace-session-summary":
        this.requireManageCarrots(callerId, "trace-session-summary");
        return this.requireTraceHost(method).summarizeSession(params);
      case "trace-events-tail":
        this.requireManageCarrots(callerId, "trace-events-tail");
        return this.requireTraceHost(method).tailEvents(params);
      case "trace-events-search":
        this.requireManageCarrots(callerId, "trace-events-search");
        return this.requireTraceHost(method).searchEvents(params);
      case "trace-view-open":
        this.requireManageCarrots(callerId, "trace-view-open");
        return this.requireTraceHost(method).openTraceView(params);
      case "voice-status":
        this.requireManageCarrots(callerId, "voice-status");
        return this.requireVoiceHost(method).status();
      case "voice-components":
        this.requireManageCarrots(callerId, "voice-components");
        return this.requireVoiceHost(method).components();
      case "voice-start":
        this.requireManageCarrots(callerId, "voice-start");
        return this.requireVoiceHost(method).start(params);
      case "voice-stop":
        this.requireManageCarrots(callerId, "voice-stop");
        return this.requireVoiceHost(method).stop(params);
      case "voice-interrupt":
        this.requireManageCarrots(callerId, "voice-interrupt");
        return this.requireVoiceHost(method).interrupt(params);
      case "voice-inject-transcript":
        this.requireManageCarrots(callerId, "voice-inject-transcript");
        return this.requireVoiceHost(method).injectTranscript(params);
      case "voice-speak":
        this.requireManageCarrots(callerId, "voice-speak");
        return this.requireVoiceHost(method).speak(params);
      case "voice-transcribe-audio":
        this.requireManageCarrots(callerId, "voice-transcribe-audio");
        return this.requireVoiceHost(method).transcribeAudio(params);
      case "voice-synthesize-speech":
        this.requireManageCarrots(callerId, "voice-synthesize-speech");
        return this.requireVoiceHost(method).synthesizeSpeech(params);
      case "voice-latency":
        this.requireManageCarrots(callerId, "voice-latency");
        return this.requireVoiceHost(method).latency();
      case "voice-recent-turns":
        this.requireManageCarrots(callerId, "voice-recent-turns");
        return this.requireVoiceHost(method).recentTurns(params);
      case "set-auth-token": {
        const record = this.workers.get(callerId);
        if (!record?.context) {
          throw new Error(`Carrot ${callerId} has no runtime context.`);
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
    handle: CarrotWorkerHandle,
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

  private emitWorkerChanged(status: CarrotWorkerStatus): void {
    this.events.workerChanged?.(status);
  }
}

let activeCarrotManager: CarrotManager | null = null;

export function getCarrotManager(): CarrotManager {
  activeCarrotManager ??= new CarrotManager();
  return activeCarrotManager;
}

export function configureCarrotManagerEvents(
  sendToWebview: SendToWebview,
): void {
  getCarrotManager().setEvents({
    storeChanged: (snapshot) => {
      sendToWebview("carrotStoreChanged", { snapshot });
    },
    workerChanged: (status) => {
      sendToWebview("carrotWorkerChanged", { status });
    },
  });
}

export function resetCarrotManagerForTesting(
  manager: CarrotManager | null = null,
): void {
  activeCarrotManager = manager;
}

export type { CarrotInstallRecord };
