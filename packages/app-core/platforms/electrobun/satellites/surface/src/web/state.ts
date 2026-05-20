import type {
  AgentMessageStreamEvent,
  AgentSummary,
  ApiDiscoveryResult,
  ConversationSummary,
  FileListResult,
  FileReadTextResult,
  FileRoot,
  FileSearchResult,
  GitBranch,
  GitLogEntry,
  GitOperation,
  GitRemote,
  GitRepoInfo,
  GitStatusResult,
  Eliza1BundleTier,
  Eliza1VoiceComponent,
  LocalModelActiveSnapshot,
  LocalModelCatalogEntry,
  LocalModelDownloadJob,
  LocalModelHardwareSnapshot,
  LocalModelHubSnapshot,
  LocalModelInstalledEntry,
  PtyOutputEntry,
  PtySession,
  PtyStatus,
  LogEntry,
  RuntimeState,
} from "../protocol/event-types.ts";

export type SurfaceRuntimeStatus = {
  runtimeState: RuntimeState | null;
  health: unknown | null;
  apiDiscovery: ApiDiscoveryResult | null;
  agents: AgentSummary[];
  conversations: ConversationSummary[];
  plugins: unknown[];
  config: unknown | null;
  fileStatus: unknown | null;
  fileRoots: FileRoot[];
  fileList: FileListResult | null;
  fileText: FileReadTextResult | null;
  fileSearch: FileSearchResult | null;
  ptyStatus: PtyStatus | null;
  ptySessions: PtySession[];
  activePtySessionId: string | null;
  ptyOutput: PtyOutputEntry[];
  ptyNextSequence: number;
  gitStatus: GitStatusResult | null;
  gitRepo: GitRepoInfo | null;
  gitRepoStatus: GitStatusResult | null;
  gitBranches: GitBranch[];
  gitRemotes: GitRemote[];
  gitLog: GitLogEntry[];
  gitDiff: string;
  gitShow: string;
  gitOperations: GitOperation[];
  modelHub: LocalModelHubSnapshot | null;
  modelCatalog: LocalModelCatalogEntry[];
  modelEliza1Tiers: Eliza1BundleTier[];
  modelVoiceComponents: Eliza1VoiceComponent[];
  modelHfMetadata: unknown | null;
  modelProviders: unknown[];
  modelHardware: LocalModelHardwareSnapshot | null;
  modelInstalled: LocalModelInstalledEntry[];
  modelDownloads: LocalModelDownloadJob[];
  modelActive: LocalModelActiveSnapshot | null;
  modelAssignments: Record<string, string>;
  modelRouting: unknown | null;
  logs: LogEntry[];
  selectedAgentId: string | null;
  selectedConversationId: string | null;
  activeStreamId: string | null;
  chatMessages: SurfaceChatMessage[];
  actionTimeline: SurfaceActionEvent[];
  errors: SurfaceError[];
  output: unknown | null;
};

export type SurfaceChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  streamId?: string;
  status?: "pending" | "streaming" | "done" | "cancelled" | "error";
  createdAt: string;
  updatedAt: string;
};

export type SurfaceActionEvent = {
  id: string;
  streamId?: string;
  kind: "snapshot" | "action" | "error" | "done" | "cancelled";
  title?: string;
  text?: string;
  payload?: unknown;
  createdAt: string;
};

export type SurfaceError = {
  id: string;
  message: string;
  details?: unknown;
  createdAt: string;
};

export function createInitialState(): SurfaceRuntimeStatus {
  return {
    runtimeState: null,
    health: null,
    apiDiscovery: null,
    agents: [],
    conversations: [],
    plugins: [],
    config: null,
    fileStatus: null,
    fileRoots: [],
    fileList: null,
    fileText: null,
    fileSearch: null,
    ptyStatus: null,
    ptySessions: [],
    activePtySessionId: null,
    ptyOutput: [],
    ptyNextSequence: 0,
    gitStatus: null,
    gitRepo: null,
    gitRepoStatus: null,
    gitBranches: [],
    gitRemotes: [],
    gitLog: [],
    gitDiff: "",
    gitShow: "",
    gitOperations: [],
    modelHub: null,
    modelCatalog: [],
    modelEliza1Tiers: [],
    modelVoiceComponents: [],
    modelHfMetadata: null,
    modelProviders: [],
    modelHardware: null,
    modelInstalled: [],
    modelDownloads: [],
    modelActive: null,
    modelAssignments: {},
    modelRouting: null,
    logs: [],
    selectedAgentId: null,
    selectedConversationId: null,
    activeStreamId: null,
    chatMessages: [],
    actionTimeline: [],
    errors: [],
    output: null,
  };
}

export function addUserMessage(
  state: SurfaceRuntimeStatus,
  text: string,
): SurfaceChatMessage {
  const now = new Date().toISOString();
  const message = {
    id: createId("user"),
    role: "user" as const,
    text,
    status: "done" as const,
    createdAt: now,
    updatedAt: now,
  };
  state.chatMessages.push(message);
  return message;
}

export function addAssistantStreamMessage(
  state: SurfaceRuntimeStatus,
  streamId: string,
): SurfaceChatMessage {
  const now = new Date().toISOString();
  const message = {
    id: createId("assistant"),
    role: "assistant" as const,
    text: "",
    streamId,
    status: "streaming" as const,
    createdAt: now,
    updatedAt: now,
  };
  state.activeStreamId = streamId;
  state.chatMessages.push(message);
  return message;
}

function applyRuntimeStateEvent(
  state: SurfaceRuntimeStatus,
  eventName: string,
  payload: unknown,
): boolean {
  if (
    (eventName === "runtime.statusChanged" ||
      eventName === "runtime.started" ||
      eventName === "runtime.stopped") &&
    isRuntimeState(payload)
  ) {
    state.runtimeState = payload;
    return true;
  }
  return false;
}

function clearActiveStream(
  state: SurfaceRuntimeStatus,
  streamId: string,
): void {
  if (state.activeStreamId === streamId) state.activeStreamId = null;
}

function applyStreamEvent(
  state: SurfaceRuntimeStatus,
  eventName: string,
  payload: AgentMessageStreamEvent,
): void {
  if (eventName === "agent.message.stream.started") {
    state.activeStreamId = payload.streamId;
    ensureAssistantStreamMessage(state, payload.streamId);
    return;
  }
  if (eventName === "agent.message.stream.delta") {
    appendDelta(state, payload);
    return;
  }
  if (eventName === "agent.message.stream.snapshot") {
    addTimelineEvent(state, payload, "snapshot");
    return;
  }
  if (eventName === "agent.message.stream.action") {
    addTimelineEvent(state, payload, "action");
    return;
  }
  if (eventName === "agent.message.stream.done") {
    setAssistantStatus(state, payload.streamId, "done");
    addTimelineEvent(state, payload, "done");
    clearActiveStream(state, payload.streamId);
    return;
  }
  if (eventName === "agent.message.stream.cancelled") {
    setAssistantStatus(state, payload.streamId, "cancelled");
    addTimelineEvent(state, payload, "cancelled");
    clearActiveStream(state, payload.streamId);
    return;
  }
  if (eventName !== "agent.message.stream.error") return;
  setAssistantStatus(state, payload.streamId, "error");
  addTimelineEvent(state, payload, "error");
  addError(state, payload.text ?? "Streaming message failed.", payload);
  clearActiveStream(state, payload.streamId);
}

export function applyRuntimeEvent(
  state: SurfaceRuntimeStatus,
  eventName: string,
  payload: unknown,
): void {
  if (applyRuntimeStateEvent(state, eventName, payload)) return;
  if (eventName === "runtime.log" && isLogEntry(payload)) {
    state.logs = [...state.logs.slice(-199), payload];
    return;
  }

  if (eventName === "runtime.error") {
    addError(state, "Runtime Satellite error.", payload);
    return;
  }

  if (!isStreamEvent(payload)) return;
  applyStreamEvent(state, eventName, payload);
}

export function addError(
  state: SurfaceRuntimeStatus,
  message: string,
  details?: unknown,
): void {
  state.errors = [
    {
      id: createId("error"),
      message,
      details,
      createdAt: new Date().toISOString(),
    },
    ...state.errors,
  ].slice(0, 20);
}

export function selectAgent(
  state: SurfaceRuntimeStatus,
  agentId: string | null,
): void {
  state.selectedAgentId = agentId && agentId.length > 0 ? agentId : null;
}

export function selectConversation(
  state: SurfaceRuntimeStatus,
  conversationId: string | null,
): void {
  state.selectedConversationId =
    conversationId && conversationId.length > 0 ? conversationId : null;
}

export function setPtySession(
  state: SurfaceRuntimeStatus,
  session: PtySession,
): void {
  const existingIndex = state.ptySessions.findIndex(
    (existing) => existing.id === session.id,
  );
  if (existingIndex === -1) state.ptySessions.push(session);
  else state.ptySessions[existingIndex] = session;
  state.activePtySessionId = session.id;
}

export function setPtyOutput(
  state: SurfaceRuntimeStatus,
  entries: PtyOutputEntry[],
  nextSequence: number,
): void {
  state.ptyOutput = entries;
  state.ptyNextSequence = nextSequence;
}

export function appendPtyOutput(
  state: SurfaceRuntimeStatus,
  entries: PtyOutputEntry[],
  nextSequence: number,
): void {
  state.ptyOutput = [...state.ptyOutput, ...entries].slice(-1000);
  state.ptyNextSequence = nextSequence;
}

function appendDelta(
  state: SurfaceRuntimeStatus,
  event: AgentMessageStreamEvent,
): void {
  const message = ensureAssistantStreamMessage(state, event.streamId);
  message.text += event.delta ?? "";
  message.updatedAt = event.timestamp;
}

function ensureAssistantStreamMessage(
  state: SurfaceRuntimeStatus,
  streamId: string,
): SurfaceChatMessage {
  const existing = state.chatMessages.find(
    (message) => message.role === "assistant" && message.streamId === streamId,
  );
  if (existing) return existing;
  return addAssistantStreamMessage(state, streamId);
}

function setAssistantStatus(
  state: SurfaceRuntimeStatus,
  streamId: string,
  status: NonNullable<SurfaceChatMessage["status"]>,
): void {
  const message = ensureAssistantStreamMessage(state, streamId);
  message.status = status;
  message.updatedAt = new Date().toISOString();
}

function addTimelineEvent(
  state: SurfaceRuntimeStatus,
  event: AgentMessageStreamEvent,
  kind: SurfaceActionEvent["kind"],
): void {
  const title =
    event.actionName ??
    event.toolName ??
    (kind === "snapshot" ? "Callback snapshot" : kind);
  state.actionTimeline = [
    {
      id: createId(kind),
      streamId: event.streamId,
      kind,
      title,
      text: event.text,
      payload: event.payload ?? event.raw,
      createdAt: event.timestamp,
    },
    ...state.actionTimeline,
  ].slice(0, 100);
}

function isRuntimeState(value: unknown): value is RuntimeState {
  if (!isRecord(value)) return false;
  return (
    typeof value.mode === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.command)
  );
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.timestamp === "string" &&
    typeof value.stream === "string" &&
    typeof value.line === "string"
  );
}

function isStreamEvent(value: unknown): value is AgentMessageStreamEvent {
  if (!isRecord(value)) return false;
  return typeof value.streamId === "string" && typeof value.kind === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  const random =
    cryptoApi && "randomUUID" in cryptoApi
      ? cryptoApi.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}
