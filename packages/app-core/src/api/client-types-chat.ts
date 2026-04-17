// ---------------------------------------------------------------------------
// Chat types — Conversation*, Chat*, Message*, Stream*, Action*, Emote*,
// Knowledge*, Memory*, MCP*, Share*
// ---------------------------------------------------------------------------

// Conversations
export interface Conversation {
  id: string;
  title: string;
  roomId: string;
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
}

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

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  /** Structured content blocks (A2UI). When present, `text` is the fallback. */
  blocks?: ContentBlock[];
  /** Source channel when forwarded from another channel (e.g. "autonomy"). */
  source?: string;
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

// Knowledge types
export interface KnowledgeStats {
  documentCount: number;
  fragmentCount: number;
  agentId: string;
}

export interface KnowledgeDocument {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  fragmentCount: number;
  source: string;
  url?: string;
  content?: { text?: string };
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  content: { text?: string };
}

export interface KnowledgeDocumentsResponse {
  documents: KnowledgeDocument[];
  total: number;
  limit: number;
  offset: number;
}

export interface KnowledgeFragment {
  id: string;
  text: string;
  position?: number;
  createdAt: number;
}

export interface KnowledgeFragmentsResponse {
  documentId: string;
  fragments: KnowledgeFragment[];
  count: number;
}

export interface KnowledgeSearchResult {
  id: string;
  text: string;
  similarity: number;
  documentId?: string;
  documentTitle?: string;
  position?: number;
}

export interface KnowledgeSearchResponse {
  query: string;
  threshold: number;
  results: KnowledgeSearchResult[];
  count: number;
}

export interface KnowledgeUploadResult {
  ok: boolean;
  documentId: string;
  fragmentCount: number;
  filename?: string;
  contentType?: string;
  isYouTubeTranscript?: boolean;
  warnings?: string[];
}

export interface KnowledgeBulkUploadItemResult {
  index: number;
  ok: boolean;
  filename: string;
  documentId?: string;
  fragmentCount?: number;
  error?: string;
  warnings?: string[];
}

export interface KnowledgeBulkUploadResult {
  ok: boolean;
  total: number;
  successCount: number;
  failureCount: number;
  results: KnowledgeBulkUploadItemResult[];
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
  knowledge: KnowledgeSearchResult[];
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

// ── n8n Workflow types ────────────────────────────────────────────────────────

export type N8nMode = "cloud" | "local" | "disabled";
export type N8nSidecarStatus = "stopped" | "starting" | "ready" | "error";

export interface N8nStatusResponse {
  mode: N8nMode;
  host: string | null;
  status: N8nSidecarStatus;
  cloudConnected: boolean;
  localEnabled: boolean;
}

export interface N8nWorkflowNode {
  id: string;
  name: string;
  type: string;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  nodeCount?: number;
  nodes?: N8nWorkflowNode[];
  lastExecutionAt?: string;
}
