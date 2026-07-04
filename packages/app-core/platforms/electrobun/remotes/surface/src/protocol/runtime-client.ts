/** Implements Electrobun surface remote runtime client ts boundaries for desktop app-core. */
import type {
  AgentMessageParams,
  AgentMessageResult,
  AgentMessageStreamParams,
  AgentMessageStreamStartResult,
  AgentMessageStreamStatus,
  AgentSummary,
  ApiDiscoveryResult,
  ConversationSummary,
  Eliza1BundleTier,
  Eliza1VoiceComponent,
  FileListParams,
  FileListResult,
  FileReadTextParams,
  FileReadTextResult,
  FileRoot,
  FileSearchParams,
  FileSearchResult,
  FileStat,
  FileWriteTextParams,
  FileWriteTextResult,
  GitAddParams,
  GitBranch,
  GitBranchCreateParams,
  GitBranchDeleteParams,
  GitCheckoutParams,
  GitCommandResult,
  GitCommandRunParams,
  GitCommitParams,
  GitDiffParams,
  GitLogEntry,
  GitLogParams,
  GitOperation,
  GitRemote,
  GitRemoteOperationParams,
  GitRepoInfo,
  GitRepoParams,
  GitRestoreParams,
  GitStatusResult,
  LocalModelActiveSnapshot,
  LocalModelCatalogEntry,
  LocalModelDownloadJob,
  LocalModelEmbeddingParams,
  LocalModelEmbeddingResult,
  LocalModelGenerateParams,
  LocalModelGenerateResult,
  LocalModelHardwareSnapshot,
  LocalModelHubSnapshot,
  LocalModelInstalledEntry,
  LogEntry,
  PtyCommandRunParams,
  PtyCommandRunResult,
  PtyCreateSessionParams,
  PtyCreateSessionResult,
  PtyKillParams,
  PtyOutputTailParams,
  PtyOutputTailResult,
  PtyResizeParams,
  PtySession,
  PtyStatus,
  PtyWriteParams,
  RuntimeState,
} from "./event-types.ts";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export type RuntimeEventHandler = (payload: unknown) => void;

export type RuntimeEventRecord = {
  remotePluginId?: string;
  remotePluginId?: string;
  sequence: number;
  name: string;
  payload: JsonValue | null;
  timestamp: string;
};

export type RuntimeEventTailResult = {
  id: string;
  events: RuntimeEventRecord[];
  nextSequence: number;
};

export type RuntimeRemotePluginBridge = {
  invoke: (
    targetId: string,
    method: string,
    params?: unknown,
  ) => Promise<unknown>;
  tailEvents?: (
    targetId: string,
    afterSequence?: number,
    limit?: number,
  ) => Promise<RuntimeEventTailResult>;
  on?: (eventName: string, handler: RuntimeEventHandler) => () => void;
};

type RuntimeGlobal = typeof globalThis & {
  __ELIZA_SURFACE_RUNTIME_BRIDGE__?: RuntimeRemotePluginBridge;
  __ELIZA_ELECTROBUN_RPC__?: {
    request?: {
      remotePluginInvokeWorker?: (params: {
        id: string;
        method: string;
        params?: JsonValue;
      }) => Promise<JsonValue | null>;
      remotePluginTailWorkerEvents?: (params: {
        id: string;
        afterSequence?: number;
        limit?: number;
      }) => Promise<RuntimeEventTailResult>;
    };
    onMessage?: (eventName: string, handler: RuntimeEventHandler) => void;
    offMessage?: (eventName: string, handler: RuntimeEventHandler) => void;
  };
};

export type SurfaceBridgeError = {
  code: "BRIDGE_UNAVAILABLE" | "BRIDGE_REQUEST_FAILED";
  message: string;
  method?: string;
  details?: unknown;
};

export class RuntimeRemotePluginClient {
  private readonly targetId: string;
  private readonly bridge: RuntimeRemotePluginBridge | null;
  private readonly localHandlers = new Map<string, Set<RuntimeEventHandler>>();
  private tailTimer: ReturnType<typeof setInterval> | null = null;
  private tailNextSequence = 0;
  private tailInFlight = false;

  constructor(
    options: { bridge?: RuntimeRemotePluginBridge; targetId?: string } = {},
  ) {
    this.targetId = options.targetId ?? "eliza.runtime";
    this.bridge = options.bridge ?? createDefaultBridge();
  }

  status(): Promise<RuntimeState> {
    return this.call<RuntimeState>("runtime.status");
  }

  start(): Promise<RuntimeState> {
    return this.call<RuntimeState>("runtime.start");
  }

  stop(): Promise<RuntimeState> {
    return this.call<RuntimeState>("runtime.stop");
  }

  restart(): Promise<RuntimeState> {
    return this.call<RuntimeState>("runtime.restart");
  }

  health(): Promise<unknown> {
    return this.call<unknown>("runtime.health");
  }

  logsTail(limit?: number): Promise<LogEntry[]> {
    return this.call<LogEntry[]>(
      "runtime.logs.tail",
      typeof limit === "number" ? { limit } : undefined,
    );
  }

  discoverApi(): Promise<ApiDiscoveryResult> {
    return this.call<ApiDiscoveryResult>("api.discover");
  }

  apiStatus(): Promise<unknown> {
    return this.call<unknown>("api.status");
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.call<AgentSummary[]>("agent.list");
  }

  getAgent(agentId: string): Promise<unknown> {
    return this.call<unknown>("agent.get", { agentId });
  }

  sendMessage(params: AgentMessageParams): Promise<AgentMessageResult> {
    return this.call<AgentMessageResult>("agent.message", params);
  }

  startMessageStream(
    params: AgentMessageStreamParams,
  ): Promise<AgentMessageStreamStartResult> {
    return this.call<AgentMessageStreamStartResult>(
      "agent.message.stream",
      params,
    );
  }

  cancelMessageStream(streamId: string): Promise<AgentMessageStreamStatus> {
    return this.call<AgentMessageStreamStatus>("agent.message.stream.cancel", {
      streamId,
    });
  }

  getMessageStreamStatus(
    streamId: string,
  ): Promise<AgentMessageStreamStatus | null> {
    return this.call<AgentMessageStreamStatus | null>(
      "agent.message.stream.status",
      { streamId },
    );
  }

  listConversations(): Promise<ConversationSummary[]> {
    return this.call<ConversationSummary[]>("conversation.list");
  }

  getConversation(conversationId: string): Promise<unknown> {
    return this.call<unknown>("conversation.get", { conversationId });
  }

  listPlugins(): Promise<unknown[]> {
    return this.call<unknown[]>("plugin.list");
  }

  searchMemory(params: {
    query: string;
    limit?: number;
    agentId?: string;
  }): Promise<unknown> {
    return this.call<unknown>("memory.search", params);
  }

  getConfig(): Promise<unknown> {
    return this.call<unknown>("config.get");
  }

  fsStatus(): Promise<unknown> {
    return this.call<unknown>("fs.status");
  }

  fsRoots(): Promise<FileRoot[]> {
    return this.call<FileRoot[]>("fs.roots");
  }

  fsStat(path: string): Promise<FileStat> {
    return this.call<FileStat>("fs.stat", { path });
  }

  fsList(params: FileListParams): Promise<FileListResult> {
    return this.call<FileListResult>("fs.list", params);
  }

  fsReadText(params: FileReadTextParams): Promise<FileReadTextResult> {
    return this.call<FileReadTextResult>("fs.readText", params);
  }

  fsSearch(params: FileSearchParams): Promise<FileSearchResult> {
    return this.call<FileSearchResult>("fs.search", params);
  }

  fsWriteText(params: FileWriteTextParams): Promise<FileWriteTextResult> {
    return this.call<FileWriteTextResult>("fs.writeText", params);
  }

  ptyStatus(): Promise<PtyStatus> {
    return this.call<PtyStatus>("pty.status");
  }

  ptyCreateSession(
    params: PtyCreateSessionParams,
  ): Promise<PtyCreateSessionResult> {
    return this.call<PtyCreateSessionResult>("pty.session.create", params);
  }

  ptyListSessions(): Promise<PtySession[]> {
    return this.call<PtySession[]>("pty.session.list");
  }

  ptyGetSession(sessionId: string): Promise<PtySession> {
    return this.call<PtySession>("pty.session.get", { sessionId });
  }

  ptyWrite(params: PtyWriteParams): Promise<PtySession> {
    return this.call<PtySession>("pty.session.write", params);
  }

  ptyResize(params: PtyResizeParams): Promise<PtySession> {
    return this.call<PtySession>("pty.session.resize", params);
  }

  ptyKill(params: PtyKillParams): Promise<PtySession> {
    return this.call<PtySession>("pty.session.kill", params);
  }

  ptyOutputTail(params: PtyOutputTailParams): Promise<PtyOutputTailResult> {
    return this.call<PtyOutputTailResult>("pty.session.output.tail", params);
  }

  ptyOutputClear(sessionId: string): Promise<{ ok: true }> {
    return this.call<{ ok: true }>("pty.session.output.clear", { sessionId });
  }

  ptyCommandRun(params: PtyCommandRunParams): Promise<PtyCommandRunResult> {
    return this.call<PtyCommandRunResult>("pty.command.run", params);
  }

  gitStatus(params: GitRepoParams): Promise<GitStatusResult> {
    return this.call<GitStatusResult>("git.status", params);
  }

  gitRepoInfo(params: GitRepoParams): Promise<GitRepoInfo> {
    return this.call<GitRepoInfo>("git.repo.info", params);
  }

  gitBranches(params: GitRepoParams): Promise<GitBranch[]> {
    return this.call<GitBranch[]>("git.branches", params);
  }

  gitRemotes(params: GitRepoParams): Promise<GitRemote[]> {
    return this.call<GitRemote[]>("git.remotes", params);
  }

  gitLog(params: GitLogParams): Promise<GitLogEntry[]> {
    return this.call<GitLogEntry[]>("git.log", params);
  }

  gitDiff(params: GitDiffParams): Promise<{ raw: string }> {
    return this.call<{ raw: string }>("git.diff", params);
  }

  gitShow(params: {
    cwd?: string;
    ref: string;
    path?: string;
  }): Promise<{ raw: string }> {
    return this.call<{ raw: string }>("git.show", params);
  }

  gitAdd(params: GitAddParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.add", params);
  }

  gitRestore(params: GitRestoreParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.restore", params);
  }

  gitCheckout(params: GitCheckoutParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.checkout", params);
  }

  gitBranchCreate(params: GitBranchCreateParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.branch.create", params);
  }

  gitBranchDelete(params: GitBranchDeleteParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.branch.delete", params);
  }

  gitCommit(params: GitCommitParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.commit", params);
  }

  gitFetch(params: GitRemoteOperationParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.fetch", params);
  }

  gitPull(params: GitRemoteOperationParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.pull", params);
  }

  gitPush(params: GitRemoteOperationParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.push", params);
  }

  gitOperationList(limit?: number): Promise<GitOperation[]> {
    return this.call<GitOperation[]>(
      "git.operation.list",
      typeof limit === "number" ? { limit } : undefined,
    );
  }

  gitOperationGet(operationId: string): Promise<GitOperation> {
    return this.call<GitOperation>("git.operation.get", { operationId });
  }

  gitCommandRun(params: GitCommandRunParams): Promise<GitCommandResult> {
    return this.call<GitCommandResult>("git.command.run", params);
  }

  modelStatus(): Promise<unknown> {
    return this.call<unknown>("model.status");
  }

  modelHub(): Promise<LocalModelHubSnapshot> {
    return this.call<LocalModelHubSnapshot>("model.hub");
  }

  modelCatalog(): Promise<LocalModelCatalogEntry[]> {
    return this.call<LocalModelCatalogEntry[]>("model.catalog");
  }

  modelEliza1Catalog(): Promise<LocalModelCatalogEntry[]> {
    return this.call<LocalModelCatalogEntry[]>("model.catalog.eliza1");
  }

  modelEliza1Tiers(): Promise<Eliza1BundleTier[]> {
    return this.call<Eliza1BundleTier[]>("model.eliza1.tiers");
  }

  modelEliza1Voice(): Promise<Eliza1VoiceComponent[]> {
    return this.call<Eliza1VoiceComponent[]>("model.eliza1.voice");
  }

  modelHfMetadata(): Promise<unknown> {
    return this.call<unknown>("model.hf.metadata");
  }

  modelProviders(): Promise<unknown[]> {
    return this.call<unknown[]>("model.providers");
  }

  modelHardware(): Promise<LocalModelHardwareSnapshot> {
    return this.call<LocalModelHardwareSnapshot>("model.hardware");
  }

  modelInstalled(): Promise<LocalModelInstalledEntry[]> {
    return this.call<LocalModelInstalledEntry[]>("model.installed");
  }

  modelDownloads(): Promise<LocalModelDownloadJob[]> {
    return this.call<LocalModelDownloadJob[]>("model.downloads");
  }

  modelActive(): Promise<LocalModelActiveSnapshot> {
    return this.call<LocalModelActiveSnapshot>("model.active");
  }

  modelActivate(modelId: string): Promise<LocalModelActiveSnapshot> {
    return this.call<LocalModelActiveSnapshot>("model.activate", { modelId });
  }

  modelUnload(): Promise<LocalModelActiveSnapshot> {
    return this.call<LocalModelActiveSnapshot>("model.unload");
  }

  modelStartDownload(modelId: string): Promise<LocalModelDownloadJob> {
    return this.call<LocalModelDownloadJob>("model.download.start", {
      modelId,
    });
  }

  modelCancelDownload(modelId: string): Promise<{ cancelled: boolean }> {
    return this.call<{ cancelled: boolean }>("model.download.cancel", {
      modelId,
    });
  }

  modelAssignments(): Promise<Record<string, string>> {
    return this.call<Record<string, string>>("model.assignments");
  }

  modelSetAssignment(params: {
    slot: string;
    modelId?: string | null;
  }): Promise<Record<string, string>> {
    return this.call<Record<string, string>>("model.assignment.set", params);
  }

  modelRouting(): Promise<unknown> {
    return this.call<unknown>("model.routing");
  }

  modelSetRouting(params: {
    slot: string;
    provider?: string | null;
    policy?: string | null;
  }): Promise<unknown> {
    return this.call<unknown>("model.routing.set", params);
  }

  modelUseLocal(): Promise<unknown> {
    return this.call<unknown>("model.routing.useLocal");
  }

  modelUseCloud(): Promise<unknown> {
    return this.call<unknown>("model.routing.useCloud");
  }

  modelGenerate(
    params: LocalModelGenerateParams,
  ): Promise<LocalModelGenerateResult> {
    return this.call<LocalModelGenerateResult>("model.generate", params);
  }

  modelEmbedding(
    params: LocalModelEmbeddingParams,
  ): Promise<LocalModelEmbeddingResult> {
    return this.call<LocalModelEmbeddingResult>("model.embedding", params);
  }

  modelCapabilities(): Promise<unknown> {
    return this.call<unknown>("model.capabilities");
  }

  on(eventName: string, handler: RuntimeEventHandler): () => void {
    if (this.bridge?.tailEvents) {
      const handlers = this.localHandlers.get(eventName) ?? new Set();
      handlers.add(handler);
      this.localHandlers.set(eventName, handlers);
      this.startEventTail();
      return () => {
        handlers.delete(handler);
        this.stopEventTailIfIdle();
      };
    }

    const bridgeUnsubscribe = this.bridge?.on?.(eventName, handler);
    if (bridgeUnsubscribe) return bridgeUnsubscribe;

    const handlers = this.localHandlers.get(eventName) ?? new Set();
    handlers.add(handler);
    this.localHandlers.set(eventName, handlers);
    return () => handlers.delete(handler);
  }

  emitLocal(eventName: string, payload: unknown): void {
    const handlers = this.localHandlers.get(eventName);
    if (!handlers) return;
    for (const handler of handlers) handler(payload);
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    if (!this.bridge) {
      throw createBridgeError("BRIDGE_UNAVAILABLE", method);
    }

    try {
      const payload = await this.bridge.invoke(this.targetId, method, params);
      return payload as T;
    } catch (error) {
      throw createBridgeError("BRIDGE_REQUEST_FAILED", method, error);
    }
  }

  private startEventTail(): void {
    if (this.tailTimer) return;
    void this.pollEventTail();
    this.tailTimer = setInterval(() => {
      void this.pollEventTail();
    }, 750);
  }

  private stopEventTailIfIdle(): void {
    for (const handlers of this.localHandlers.values()) {
      if (handlers.size > 0) return;
    }
    if (!this.tailTimer) return;
    clearInterval(this.tailTimer);
    this.tailTimer = null;
  }

  private async pollEventTail(): Promise<void> {
    if (!this.bridge?.tailEvents || this.tailInFlight) return;
    this.tailInFlight = true;
    try {
      const snapshot = await this.bridge.tailEvents(
        this.targetId,
        this.tailNextSequence,
        100,
      );
      this.tailNextSequence = snapshot.nextSequence;
      for (const event of snapshot.events) {
        this.emitLocal(event.name, event.payload);
      }
    } catch {
      this.stopEventTailIfIdle();
    } finally {
      this.tailInFlight = false;
    }
  }
}

function createDefaultBridge(): RuntimeRemotePluginBridge | null {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  if (runtimeGlobal.__ELIZA_SURFACE_RUNTIME_BRIDGE__) {
    return runtimeGlobal.__ELIZA_SURFACE_RUNTIME_BRIDGE__;
  }

  const electrobunRpc = runtimeGlobal.__ELIZA_ELECTROBUN_RPC__;
  const invokeWorker = electrobunRpc?.request?.remotePluginInvokeWorker;
  if (invokeWorker) {
    const tailEvents = electrobunRpc.request?.remotePluginTailWorkerEvents;
    return {
      invoke: (targetId, method, params) => {
        const jsonParams = toJsonValue(params);
        return invokeWorker({
          id: targetId,
          method,
          ...(jsonParams === undefined ? {} : { params: jsonParams }),
        });
      },
      tailEvents: tailEvents
        ? (targetId, afterSequence, limit) =>
            tailEvents({
              id: targetId,
              ...(afterSequence === undefined ? {} : { afterSequence }),
              ...(limit === undefined ? {} : { limit }),
            })
        : undefined,
      on:
        electrobunRpc.onMessage && electrobunRpc.offMessage
          ? (eventName, handler) => {
              electrobunRpc.onMessage?.(eventName, handler);
              return () => electrobunRpc.offMessage?.(eventName, handler);
            }
          : undefined,
    };
  }

  return null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }

  for (const propertyValue of Object.values(value)) {
    if (!isJsonValue(propertyValue)) {
      return false;
    }
  }
  return true;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (isJsonValue(value)) return value;
  throw new Error(
    "Runtime RemotePlugin bridge params must be JSON-serializable.",
  );
}

function createBridgeError(
  code: SurfaceBridgeError["code"],
  method: string,
  details?: unknown,
): SurfaceBridgeError {
  return {
    code,
    method,
    message:
      code === "BRIDGE_UNAVAILABLE"
        ? "Runtime RemotePlugin bridge is not available."
        : "Runtime RemotePlugin request failed.",
    details,
  };
}
