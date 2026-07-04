/** Implements Electrobun desktop session manager ts behavior for app-core shell integration. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { DynamicViewError } from "./errors";
import type { DynamicViewRegistry } from "./registry";
import type {
  DynamicViewCloseParams,
  DynamicViewManifest,
  DynamicViewMetadata,
  DynamicViewOpenParams,
  DynamicViewPlacement,
  DynamicViewPushParams,
  DynamicViewSession,
  DynamicViewSessionId,
} from "./types";

interface DynamicViewCanvasWindowOptions {
  url?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  title?: string;
  transparent?: boolean;
  alwaysOnTop?: boolean;
}

interface DynamicViewCanvas {
  createWindow(
    options: DynamicViewCanvasWindowOptions,
  ): Promise<{ id: string }>;
  destroyWindow(options: { id: string }): Promise<void>;
  a2uiPush(options: { id: string; payload: JsonValue }): Promise<void>;
}

interface DynamicViewWorkerStatus {
  state: string;
}

interface DynamicViewWorkerStatusProvider {
  getWorkerStatus(id: string): DynamicViewWorkerStatus | null;
}

interface DynamicViewSessionManagerOptions {
  registry: DynamicViewRegistry;
  canvas: DynamicViewCanvas;
  workerStatusProvider?: DynamicViewWorkerStatusProvider;
  now?: () => Date;
  sessionIdFactory?: () => string;
  maxSessionHistory?: number;
  entrypointBaseDir?: string;
  /**
   * Placements this canvas can render. Defaults to native-window placements
   * (`canvas`/`floating`/`debug`). The kiosk in-window canvas widens this to
   * also mount `panel`/`chat-inline` views as in-canvas surfaces.
   */
  supportedPlacements?: readonly DynamicViewPlacement[];
}

const DEFAULT_SUPPORTED_CANVAS_PLACEMENTS: readonly DynamicViewPlacement[] = [
  "canvas",
  "floating",
  "debug",
] as const;

const DEFAULT_MAX_SESSION_HISTORY = 200;
const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 520;
const DYNAMIC_VIEW_DIR = path.dirname(fileURLToPath(import.meta.url));

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function cloneMetadata(
  metadata: DynamicViewMetadata | undefined,
): DynamicViewMetadata | undefined {
  if (metadata === undefined) return undefined;
  return { ...metadata };
}

function metadataWithInitialState(
  metadata: DynamicViewMetadata | undefined,
  initialState: JsonValue | undefined,
): DynamicViewMetadata {
  return {
    ...(metadata ?? {}),
    initialState: initialState ?? null,
  };
}

function isLocalEntrypointUrl(url: URL): boolean {
  if (url.protocol === "file:") return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function resolveEntrypoint(entrypoint: string, baseDir: string): string {
  let parsed: URL | null = null;
  try {
    parsed = new URL(entrypoint);
  } catch {
    parsed = null;
  }

  if (parsed) {
    if (!isLocalEntrypointUrl(parsed)) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_UNSUPPORTED_ENTRYPOINT",
        `Dynamic view entrypoint must be local: ${entrypoint}`,
      );
    }
    if (parsed.protocol === "file:" && !fs.existsSync(fileURLToPath(parsed))) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE",
        `Dynamic view entrypoint does not exist: ${entrypoint}`,
      );
    }
    return parsed.href;
  }

  const filePath = path.resolve(baseDir, entrypoint);
  if (!fs.existsSync(filePath)) {
    throw new DynamicViewError(
      "DYNAMIC_VIEW_ENTRYPOINT_UNAVAILABLE",
      `Dynamic view entrypoint does not exist: ${entrypoint}`,
    );
  }
  return pathToFileURL(filePath).href;
}

function createSessionPayload(
  session: DynamicViewSession,
  manifest: DynamicViewManifest,
  initialState: JsonValue | undefined,
): JsonValue {
  return {
    type: "dynamic-view.session.opened",
    sessionId: session.sessionId,
    viewId: session.viewId,
    placement: session.placement,
    title: session.title,
    initialState: initialState ?? null,
    manifest: {
      id: manifest.id,
      title: manifest.title,
      source: manifest.source,
      placement: manifest.placement,
      requiredRemotes: manifest.requiredRemotes ?? [],
      eventSubscriptions: (manifest.eventSubscriptions ?? []).map(
        (subscription) => ({
          remoteId: subscription.remoteId,
          events: subscription.events ?? [],
        }),
      ),
      invokeTargets: manifest.invokeTargets ?? [],
    },
    metadata: session.metadata ?? null,
  };
}

function createEventPayload(params: DynamicViewPushParams): JsonValue {
  return {
    type: "dynamic-view.event",
    sessionId: params.sessionId,
    event: params.event,
    payload: params.payload ?? null,
  };
}

export class DynamicViewSessionManager {
  private readonly registry: DynamicViewRegistry;
  private readonly canvas: DynamicViewCanvas;
  private readonly workerStatusProvider: DynamicViewWorkerStatusProvider | null;
  private readonly now: () => Date;
  private readonly sessionIdFactory: () => string;
  private readonly maxSessionHistory: number;
  private readonly entrypointBaseDir: string;
  private readonly supportedPlacements: readonly DynamicViewPlacement[];
  private readonly sessions = new Map<
    DynamicViewSessionId,
    DynamicViewSession
  >();

  constructor(options: DynamicViewSessionManagerOptions) {
    this.registry = options.registry;
    this.canvas = options.canvas;
    this.workerStatusProvider = options.workerStatusProvider ?? null;
    this.now = options.now ?? (() => new Date());
    this.sessionIdFactory = options.sessionIdFactory ?? (() => randomUUID());
    this.maxSessionHistory =
      options.maxSessionHistory ?? DEFAULT_MAX_SESSION_HISTORY;
    this.entrypointBaseDir = options.entrypointBaseDir ?? DYNAMIC_VIEW_DIR;
    this.supportedPlacements =
      options.supportedPlacements ?? DEFAULT_SUPPORTED_CANVAS_PLACEMENTS;
  }

  async open(params: DynamicViewOpenParams): Promise<DynamicViewSession> {
    const manifest = this.registry.get(params.viewId);
    if (!manifest) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_NOT_FOUND",
        `Dynamic view is not registered: ${params.viewId}`,
      );
    }
    const placement = params.placement ?? manifest.placement;
    this.assertPlacementSupported(placement);
    this.assertRequiredRemotesAvailable(manifest);
    const url = resolveEntrypoint(manifest.entrypoint, this.entrypointBaseDir);
    const timestamp = nowIso(this.now);
    const session: DynamicViewSession = {
      sessionId: `dynamic-view-${this.sessionIdFactory()}`,
      viewId: manifest.id,
      title: params.title ?? manifest.title,
      placement,
      status: "opening",
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: metadataWithInitialState(params.metadata, params.initialState),
    };
    this.sessions.set(session.sessionId, session);
    this.pruneSessionHistory();

    try {
      const canvasWindow = await this.canvas.createWindow({
        url,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        title: session.title,
        transparent: placement === "debug",
        alwaysOnTop: placement === "floating",
      });
      session.canvasWindowId = canvasWindow.id;
      session.status = "open";
      session.updatedAt = nowIso(this.now);
      await this.canvas.a2uiPush({
        id: canvasWindow.id,
        payload: createSessionPayload(session, manifest, params.initialState),
      });
      return { ...session, metadata: cloneMetadata(session.metadata) };
    } catch (error) {
      session.status = "error";
      session.error = error instanceof Error ? error.message : String(error);
      session.updatedAt = nowIso(this.now);
      throw new DynamicViewError("DYNAMIC_VIEW_OPEN_FAILED", session.error);
    }
  }

  async close(params: DynamicViewCloseParams): Promise<DynamicViewSession> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_SESSION_NOT_FOUND",
        `Dynamic view session was not found: ${params.sessionId}`,
      );
    }
    if (session.status === "closed") {
      return { ...session, metadata: cloneMetadata(session.metadata) };
    }
    if (session.canvasWindowId) {
      await this.canvas.destroyWindow({ id: session.canvasWindowId });
    }
    const timestamp = nowIso(this.now);
    session.status = "closed";
    session.updatedAt = timestamp;
    session.closedAt = timestamp;
    return { ...session, metadata: cloneMetadata(session.metadata) };
  }

  async push(params: DynamicViewPushParams): Promise<{ ok: true }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_SESSION_NOT_FOUND",
        `Dynamic view session was not found: ${params.sessionId}`,
      );
    }
    if (!session.canvasWindowId || session.status !== "open") {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_PUSH_FAILED",
        `Dynamic view session is not open: ${params.sessionId}`,
      );
    }
    await this.canvas.a2uiPush({
      id: session.canvasWindowId,
      payload: createEventPayload(params),
    });
    session.updatedAt = nowIso(this.now);
    return { ok: true };
  }

  list(): DynamicViewSession[] {
    return [...this.sessions.values()].map((session) => ({
      ...session,
      metadata: cloneMetadata(session.metadata),
    }));
  }

  get(sessionId: string): DynamicViewSession | null {
    const session = this.sessions.get(sessionId);
    return session
      ? { ...session, metadata: cloneMetadata(session.metadata) }
      : null;
  }

  private assertPlacementSupported(placement: DynamicViewPlacement): void {
    if (!this.supportedPlacements.includes(placement)) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_UNSUPPORTED_PLACEMENT",
        `Dynamic view placement is not supported yet: ${placement}`,
      );
    }
  }

  private assertRequiredRemotesAvailable(manifest: DynamicViewManifest): void {
    const requiredRemotes = manifest.requiredRemotes ?? [];
    if (requiredRemotes.length === 0) return;
    if (!this.workerStatusProvider) {
      throw new DynamicViewError(
        "DYNAMIC_VIEW_REQUIRED_REMOTE_UNAVAILABLE",
        "Dynamic view requires Remote status checks, but no provider is configured.",
      );
    }
    for (const remoteId of requiredRemotes) {
      const status = this.workerStatusProvider.getWorkerStatus(remoteId);
      if (status?.state !== "running") {
        throw new DynamicViewError(
          "DYNAMIC_VIEW_REQUIRED_REMOTE_UNAVAILABLE",
          `Required Remote is not running: ${remoteId}`,
        );
      }
    }
  }

  private pruneSessionHistory(): void {
    if (this.sessions.size <= this.maxSessionHistory) return;
    const closedSession = [...this.sessions.values()].find(
      (session) => session.status === "closed",
    );
    const sessionToRemove =
      closedSession ?? this.sessions.values().next().value;
    if (sessionToRemove) {
      this.sessions.delete(sessionToRemove.sessionId);
    }
  }
}
