export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageStatus = "pending" | "streaming" | "complete" | "error";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent;

export interface Message {
  id: string;
  role: MessageRole;
  content: ContentBlock[] | string;
  status: MessageStatus;
  createdAt: number;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  model?: string;
  tags?: string[]; // ConversationTag IDs
  isPinned?: boolean;
}

// ─── Export ──────────────────────────────────────────────────────────────────

export type ExportFormat = "markdown" | "json" | "html" | "pdf" | "plaintext";

export interface ExportOptions {
  format: ExportFormat;
  includeToolUse: boolean;
  includeThinking: boolean;
  includeTimestamps: boolean;
  includeFileContents: boolean;
  dateRange?: { start: number; end: number };
}

// ─── Share ────────────────────────────────────────────────────────────────────

export type ShareVisibility = "public" | "unlisted" | "password";
export type ShareExpiry = "1h" | "24h" | "7d" | "30d" | "never";

export interface ShareOptions {
  visibility: ShareVisibility;
  password?: string;
  expiry: ShareExpiry;
}

export interface ShareLink {
  id: string;
  conversationId: string;
  visibility: ShareVisibility;
  hasPassword: boolean;
  expiry: ShareExpiry;
  expiresAt?: number;
  createdAt: number;
  url: string;
}

export interface SharedConversation {
  id: string;
  title: string;
  messages: Message[];
  model?: string;
  createdAt: number;
  shareCreatedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MCPServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface AppSettings {
  // General
  theme: "light" | "dark" | "system";
  fontSize: { chat: number; code: number };
  sendOnEnter: boolean;
  showTimestamps: boolean;
  compactMode: boolean;

  // Model
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;

  // API
  apiUrl: string;
  apiKey: string;
  streamingEnabled: boolean;

  // Provider
  provider: "zai" | "xai" | "anthropic" | "openrouter" | "deepseek";
  providerKeys: Record<string, string>;

  // Permissions
  permissions: {
    autoApprove: Record<string, boolean>;
    restrictedDirs: string[];
  };

  // MCP
  mcpServers: MCPServerConfig[];

  // Telegram relay
  telegram: {
    botToken: string;
    allowedChatId: string;
  };

  // Keybindings
  keybindings: Record<string, string>;

  // Privacy
  telemetryEnabled: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
  isPinned: boolean;
  hasActiveTools: boolean;
}

export interface ConversationTag {
  id: string;
  label: string;
  color: string; // "blue" | "green" | "red" | "yellow" | "purple" | "pink" | "orange" | "teal" | "cyan" | "indigo"
}

export interface SearchFilters {
  dateFrom?: number;
  dateTo?: number;
  role?: MessageRole | null;
  conversationId?: string | null;
  contentType?: "text" | "code" | "tool_use" | "file" | null;
  model?: string | null;
  tagIds?: string[];
}

export interface SearchResultMatch {
  messageId: string;
  role: MessageRole;
  excerpt: string;     // plain text excerpt around the match
  highlighted: string; // HTML string with <mark> tags
  score: number;
}

export interface SearchResult {
  conversationId: string;
  conversationTitle: string;
  conversationDate: number;
  conversationModel?: string;
  matches: SearchResultMatch[];
  totalScore: number;
}

export type GitFileStatus = "M" | "A" | "?" | "D" | "R";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  gitStatus?: GitFileStatus | null;
}
