// ---------------------------------------------------------------------------
// Chat types — Conversation*, Chat*, Message*, Stream*, Action*, Emote*,
// Document*, Memory*, MCP*, Share*
// ---------------------------------------------------------------------------

import type {
  ConversationMetadata,
  ConversationScope,
} from "./agent-client-type-shim";

// Conversations
export interface Conversation {
  id: string;
  title: string;
  roomId: string;
  metadata?: ConversationMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationGreeting {
  text: string;
  agentName: string;
  generated: boolean;
  persisted?: boolean;
}

export interface CreateConversationOptions {
  includeGreeting?: boolean;
  bootstrapGreeting?: boolean;
  lang?: string;
  metadata?: ConversationMetadata;
}

export type { ConversationMetadata, ConversationScope };

// ── A2UI Content Blocks (Agent-to-UI) ────────────────────────────────

/** A plain text content block. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** An inline config form block — renders ConfigRenderer in chat. */
export interface ConfigFormBlock {
  type: "config-form";
  pluginId: string;
  pluginName?: string;
  schema: Record<string, unknown>;
  hints?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

/** A UiSpec interactive UI block extracted from agent response. */
export interface UiSpecBlock {
  type: "ui-spec";
  spec: Record<string, unknown>;
  raw?: string;
}

/** Union of all content block types. */
export type ContentBlock = TextBlock | ConfigFormBlock | UiSpecBlock;

/** An image attachment to send with a chat message. */
export interface ImageAttachment {
  /** Base64-encoded image data (no data URL prefix). */
  data: string;
  mimeType: string;
  name: string;
}

export interface ConversationMessageReaction {
  emoji: string;
  count: number;
  users?: string[];
}

export type ChatFailureKind =
  | "insufficient_credits"
  | "no_provider"
  | "provider_issue"
  | "local_inference";

export type LocalInferenceChatStatus =
  | "missing"
  | "downloading"
  | "loading"
  | "failed"
  | "no_space"
  | "idle"
  | "ready"
  | "cancelled"
  | "routing";

export interface LocalInferenceChatMetadata {
  intent?:
    | "retry"
    | "resume"
    | "redownload"
    | "download"
    | "cancel"
    | "switch_smaller"
    | "status"
    | "use_cloud"
    | "use_local";
  status: LocalInferenceChatStatus;
  modelId?: string | null;
  activeModelId?: string | null;
  provider?: string;
  error?: string;
  progress?: {
    percent?: number;
    receivedBytes: number;
    totalBytes: number;
    bytesPerSec?: number;
    etaMs?: number | null;
  };
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /** Structured content blocks (A2UI). When present, `text` is the fallback. */
  blocks?: ContentBlock[];
  /** Source channel when forwarded from another channel (e.g. "autonomy"). */
  source?: string;
  /** Concrete action name that produced this assistant turn, when applicable. */
  actionName?: string;
  /** Callback/status lines emitted while the action was running. */
  actionCallbackHistory?: string[];
  /** Username of the sender (e.g. viewer username, discord username). */
  from?: string;
  /** Connector username/handle when available. */
  fromUserName?: string;
  /** Sender avatar URL when the connector can provide one. */
  avatarUrl?: string;
  /** Internal message id this message replies to, when available. */
  replyToMessageId?: string;
  /** Best-effort display name of the replied-to sender. */
  replyToSenderName?: string;
  /** Best-effort username/handle of the replied-to sender. */
  replyToSenderUserName?: string;
  /** Aggregated reactions attached to this message. */
  reactions?: ConversationMessageReaction[];
  /** True when the SSE stream was interrupted before receiving a "done" event. */
  interrupted?: boolean;
  /**
   * When set, this assistant turn is the server's no-provider /
   * provider-issue / insufficient-credits fallback. The renderer can
   * substitute a structured gate UI (e.g. "Connect a provider →
   * Settings") for `failureKind === "no_provider"` instead of rendering
   * the fallback `text` as a normal reply bubble.
   */
  failureKind?: ChatFailureKind;
  /** Structured local-inference status returned with local model command/error replies. */
  localInference?: LocalInferenceChatMetadata;
}

export type ConversationChannelType =
  | "DM"
  | "GROUP"
  | "VOICE_DM"
  | "VOICE_GROUP"
  | "API";

export interface ChatTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  llmCalls?: number;
  model?: string;
}

export type ConversationMode = "simple" | "power";

// Document / Character Knowledge types
export interface DocumentStats {
  documentCount: number;
  fragmentCount: number;
  agentId: string;
}

export type DocumentScope =
  | "global"
  | "owner-private"
  | "user-private"
  | "agent-private";

export type DocumentProvenanceKind =
  | "upload"
  | "learned"
  | "character"
  | "url"
  | "youtube"
  | "bundled"
  | "unknown";

export interface DocumentProvenance {
  kind: DocumentProvenanceKind;
  label: string;
  detail?: string;
}

export interface DocumentRecord {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  fragmentCount: number;
  scope?: DocumentScope;
  scopedToEntityId?: string;
  addedBy?: string;
  addedByRole?: "OWNER" | "ADMIN" | "USER" | "AGENT" | "RUNTIME";
  addedFrom?: string;
  source: DocumentProvenanceKind;
  url?: string;
  provenance: DocumentProvenance;
  canEditText: boolean;
  editabilityReason?: string;
  canDelete: boolean;
  deleteabilityReason?: string;
  content?: { text?: string };
}

export interface DocumentDetail extends DocumentRecord {
  content?: { text?: string };
}

export interface DocumentsResponse {
  documents: DocumentRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface DocumentFragmentRecord {
  id: string;
  text: string;
  position?: number;
  createdAt: number;
}

export interface DocumentFragmentsResponse {
  documentId: string;
  fragments: DocumentFragmentRecord[];
  count: number;
}

export interface DocumentSearchResult {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  documentProvenance?: DocumentProvenance;
  position?: number;
}

export interface DocumentSearchResponse {
  query: string;
  threshold: number;
  results: DocumentSearchResult[];
  count: number;
}

export interface DocumentUploadResult {
  ok: boolean;
  documentId: string;
  fragmentCount: number;
  filename?: string;
  contentType?: string;
  isYouTubeTranscript?: boolean;
  warnings?: string[];
}

export interface DocumentUpdateResult {
  ok: boolean;
  documentId: string;
  fragmentCount: number;
}

export interface DocumentBulkUploadItemResult {
  index: number;
  ok: boolean;
  filename: string;
  documentId?: string;
  fragmentCount?: number;
  error?: string;
  warnings?: string[];
}

export interface DocumentBulkUploadResult {
  ok: boolean;
  total: number;
  successCount: number;
  failureCount: number;
  results: DocumentBulkUploadItemResult[];
}

// Memory / context command types
export interface MemorySearchResult {
  id: string;
  text: string;
  createdAt: number;
  score: number;
}

export interface MemorySearchResponse {
  query: string;
  results: MemorySearchResult[];
  count: number;
  limit: number;
}

export interface MemoryRememberResponse {
  ok: boolean;
  id: string;
  text: string;
  createdAt: number;
}

export interface QuickContextResponse {
  query: string;
  answer: string;
  memories: MemorySearchResult[];
  documents: DocumentSearchResult[];
}

// Memory Viewer types
export interface MemoryBrowseItem {
  id: string;
  type: string;
  text: string;
  entityId: string | null;
  roomId: string | null;
  agentId: string | null;
  createdAt: number;
  metadata: Record<string, unknown> | null;
  source: string | null;
}

export interface MemoryBrowseQuery {
  type?: string;
  entityId?: string;
  /** Comma-joinable entity IDs for multi-identity people. */
  entityIds?: string[];
  roomId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryBrowseResponse {
  memories: MemoryBrowseItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface MemoryFeedQuery {
  type?: string;
  limit?: number;
  before?: number;
}

export interface MemoryFeedResponse {
  memories: MemoryBrowseItem[];
  count: number;
  limit: number;
  hasMore: boolean;
}

export interface MemoryStatsResponse {
  total: number;
  byType: Record<string, number>;
}

// MCP
export interface McpServerConfig {
  type: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpMarketplaceResult {
  name: string;
  description?: string;
  connectionType: string;
  npmPackage?: string;
  dockerImage?: string;
}

export interface McpRegistryServerDetail {
  packages?: Array<{
    environmentVariables: Array<{
      name: string;
      default?: string;
      isRequired?: boolean;
    }>;
    packageArguments?: Array<{ default?: string }>;
  }>;
  remotes?: Array<{
    type?: string;
    url: string;
    headers: Array<{ name: string; isRequired?: boolean }>;
  }>;
}

export interface McpServerStatus {
  name: string;
  connected: boolean;
  error?: string;
}

// Share Ingest
export interface ShareIngestPayload {
  title?: string;
  url?: string;
  text?: string;
  files?: Array<{ name: string }>;
}

export interface ShareIngestItem {
  suggestedPrompt: string;
  files: Array<{ name: string }>;
}

// ── Workflow types ────────────────────────────────────────────────────────────

export type WorkflowMode = "local" | "cloud" | "disabled";
export type WorkflowRuntimeStatus = "ready" | "error";

export interface WorkflowStatusResponse {
  mode: WorkflowMode;
  host: string | null;
  status: WorkflowRuntimeStatus;
  cloudConnected: boolean;
  localEnabled: boolean;
  platform?: "desktop";
  cloudHealth?: "ok" | "degraded" | "unknown";
}

export interface WorkflowDefinitionNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  /** Canvas position — [x, y]. Present on single-workflow GET; absent on list. */
  position?: [number, number];
  /** Node parameters. Present on single-workflow GET; absent on list. */
  parameters?: Record<string, unknown>;
  notes?: string;
  notesInFlow?: boolean;
}

/** A single outbound connection edge from the workflow connection map. */
export interface WorkflowConnection {
  node: string;
  type: "main";
  index: number;
}

/**
 * Workflow connection map shape.
 * Keys are source node names; values group edges by output type.
 * Present on single-workflow GET only — list endpoint stays shallow.
 */
export type WorkflowConnectionMap = Record<
  string,
  { main?: WorkflowConnection[][] }
>;

export interface WorkflowDefinition {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  nodeCount?: number;
  nodes?: WorkflowDefinitionNode[];
  lastExecutionAt?: string;
  /** Connection graph. Present on single-workflow GET; absent on list. */
  connections?: WorkflowConnectionMap;
}

export interface WorkflowExecution {
  id: string;
  status:
    | "success"
    | "error"
    | "running"
    | "waiting"
    | "canceled"
    | "crashed"
    | "new"
    | "unknown";
  startedAt: string;
  stoppedAt?: string | null;
  mode?: string;
  workflowId?: string;
  data?: {
    resultData?: {
      error?: { message?: string };
      lastNodeExecuted?: string;
    };
  };
}

/**
 * One missing credential entry on a workflow generate response. `authUrl` is
 * a `eliza://settings/connectors/<provider>` deep-link the UI may surface.
 */
export interface WorkflowDefinitionMissingCredential {
  credType: string;
  authUrl?: string;
}

/**
 * Returned by `POST /api/workflow/workflows/generate` when the deployed workflow
 * references credentials the user hasn't connected yet. Carries the deployed
 * workflow's identity plus the list of unmet credential requirements so the
 * UI can render a CTA banner.
 */
export interface WorkflowDefinitionMissingCredentialsResponse {
  id: string;
  name: string;
  active: boolean;
  missingCredentials: WorkflowDefinitionMissingCredential[];
  warning: "missing credentials";
}

/**
 * Structured clarification request emitted by the plugin's workflow generator
 * when a node parameter cannot be resolved from the runtime context. The host
 * surfaces these as quick-pick buttons; on click the host calls
 * `/api/workflow/workflows/resolve-clarification` with the chosen value, which
 * patches the draft at `paramPath` and deploys — no LLM regeneration.
 *
 * Mirrors the plugin's `ClarificationRequest` (see
 * @elizaos/plugin-workflow `src/types/index.ts`). Re-declared here to
 * avoid a host → plugin import cycle.
 */
export interface WorkflowClarificationRequest {
  kind:
    | "target_channel"
    | "target_server"
    | "recipient"
    | "value"
    | "free_text";
  platform?: string;
  scope?: { guildId?: string };
  question: string;
  paramPath: string;
}

/** One server / workspace / contact-collection from a connector catalog. */
export interface WorkflowClarificationTargetGroup {
  platform: string;
  groupId: string;
  groupName: string;
  targets: Array<{
    id: string;
    name: string;
    kind: "channel" | "recipient" | "chat";
  }>;
}

/**
 * Returned by `POST /api/workflow/workflows/generate` when the LLM emitted one or
 * more `ClarificationRequest`s and the host needs the user to pick a target
 * before deploying. The `draft` is the unmodified workflow JSON from the
 * plugin (with the unresolved parameters left absent); `catalog` is a
 * snapshot of the relevant connector-target-catalog scoped to the
 * platforms referenced by the clarifications.
 */
export interface WorkflowDefinitionNeedsClarificationResponse {
  status: "needs_clarification";
  draft: Record<string, unknown>;
  clarifications: WorkflowClarificationRequest[];
  catalog: WorkflowClarificationTargetGroup[];
}

/** Resolution payload sent to /api/workflow/workflows/resolve-clarification. */
export interface WorkflowClarificationResolution {
  paramPath: string;
  value: string;
}

export interface WorkflowDefinitionResolveClarificationRequest {
  draft: Record<string, unknown>;
  resolutions: WorkflowClarificationResolution[];
  name?: string;
  workflowId?: string;
}

export type WorkflowDefinitionGenerateResponse =
  | WorkflowDefinition
  | WorkflowDefinitionMissingCredentialsResponse
  | WorkflowDefinitionNeedsClarificationResponse;

export function isMissingCredentialsResponse(
  res: WorkflowDefinitionGenerateResponse,
): res is WorkflowDefinitionMissingCredentialsResponse {
  const candidate = res as WorkflowDefinitionMissingCredentialsResponse;
  return (
    candidate.warning === "missing credentials" &&
    Array.isArray(candidate.missingCredentials)
  );
}

export function isNeedsClarificationResponse(
  res: WorkflowDefinitionGenerateResponse,
): res is WorkflowDefinitionNeedsClarificationResponse {
  const candidate = res as WorkflowDefinitionNeedsClarificationResponse;
  return (
    candidate.status === "needs_clarification" &&
    Array.isArray(candidate.clarifications) &&
    Array.isArray(candidate.catalog) &&
    typeof candidate.draft === "object" &&
    candidate.draft !== null
  );
}

export interface WorkflowDefinitionWriteNode {
  id?: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  color?: string;
  continueOnFail?: boolean;
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: "continueErrorOutput" | "continueRegularOutput" | "stopWorkflow";
}

export interface WorkflowDefinitionWriteRequest {
  name: string;
  nodes: WorkflowDefinitionWriteNode[];
  connections: WorkflowConnectionMap;
  settings?: Record<string, unknown>;
}

export interface WorkflowDefinitionGenerateRequest {
  prompt: string;
  name?: string;
  workflowId?: string;
  /**
   * Optional originating conversation id. When present, the server reads
   * the conversation's tail inbound message metadata and threads platform
   * routing (Discord channelId/guildId, Telegram chatId, etc.) into the
   * workflow generator so the LLM can target "this channel" / "back to
   * here" without the user naming an ID.
   */
  bridgeConversationId?: string;
}
