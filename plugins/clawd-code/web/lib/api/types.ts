import type { ContentBlock } from "../types";

// ---------------------------------------------------------------------------
// SSE stream events (Anthropic message streaming protocol)
// ---------------------------------------------------------------------------

export type ContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string };

export type StreamEvent =
  | {
      type: "message_start";
      message: {
        id: string;
        role: string;
        model: string;
        usage: { input_tokens: number; output_tokens: number };
      };
    }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: ContentDelta }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: string; stop_sequence: string | null };
      usage: { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "error"; error: { type: string; message: string } }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// API errors
// ---------------------------------------------------------------------------

export type ApiErrorType =
  | "network"
  | "auth"
  | "rate_limit"
  | "server"
  | "timeout"
  | "abort"
  | "not_found";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly type: ApiErrorType = "server",
    /** Retry-After seconds for rate limit errors */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isRetryable(): boolean {
    return this.type === "network" || this.type === "server" || this.status >= 500;
  }
}

// ---------------------------------------------------------------------------
// Shared request / response types
// ---------------------------------------------------------------------------

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  headers?: Record<string, string>;
}

export interface StreamProgress {
  tokensReceived: number;
  elapsedMs: number;
  isComplete: boolean;
}

// ---------------------------------------------------------------------------
// File API types
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: number;
}

export interface SearchResult {
  path: string;
  line: number;
  content: string;
  context?: string[];
}

export interface UploadResult {
  path: string;
  size: number;
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC types
// ---------------------------------------------------------------------------

export interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse<T = unknown> {
  jsonrpc: "2.0";
  id?: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
