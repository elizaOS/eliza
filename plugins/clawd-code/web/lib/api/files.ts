import { nanoid } from "nanoid";
import { ApiError } from "./types";
import type {
  FileEntry,
  SearchResult,
  UploadResult,
  McpRequest,
  McpResponse,
  McpToolResult,
} from "./types";

// ---------------------------------------------------------------------------
// MCP JSON-RPC client for the file system tools
// ---------------------------------------------------------------------------
//
// The MCP server exposes tools at POST /mcp (Streamable HTTP transport).
// We maintain a single session per page load and reinitialize if it expires.

function getBaseUrl(): string {
  return (
    (typeof process !== "undefined" && process.env.NEXT_PUBLIC_API_URL) ||
    "http://localhost:3001"
  );
}

function getApiKey(): string | undefined {
  return typeof process !== "undefined"
    ? process.env.NEXT_PUBLIC_API_KEY
    : undefined;
}

class McpClient {
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extra,
    };
    const key = getApiKey();
    if (key) headers["Authorization"] = `Bearer ${key}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async doInitialize(): Promise<void> {
    const res = await fetch(`${getBaseUrl()}/mcp`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "claude-code-web", version: "1.0.0" },
        },
      } satisfies McpRequest),
    });

    if (!res.ok) {
      this.initPromise = null;
      throw new ApiError(res.status, "MCP session initialization failed");
    }

    this.sessionId = res.headers.get("mcp-session-id");

    // Send "initialized" notification (fire-and-forget)
    if (this.sessionId) {
      fetch(`${getBaseUrl()}/mcp`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }),
      }).catch(() => {
        // non-critical
      });
    }
  }

  private initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInitialize().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  /** Parse an SSE-streamed MCP response and return the first result text. */
  private async parseSseResponse(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const json = JSON.parse(line.slice(6)) as McpResponse<McpToolResult>;
            if (json.result?.content?.[0]?.text != null) {
              result = json.result.content[0].text;
            }
          } catch {
            // skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return result;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.initialize();

    const res = await fetch(`${getBaseUrl()}/mcp`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nanoid(),
        method: "tools/call",
        params: { name, arguments: args },
      } satisfies McpRequest),
    });

    // Session expired — reinitialize once and retry
    if (res.status === 400 || res.status === 404) {
      this.sessionId = null;
      this.initPromise = null;
      await this.initialize();
      return this.callTool(name, args);
    }

    if (!res.ok) {
      throw new ApiError(res.status, `MCP tool "${name}" failed`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      return this.parseSseResponse(res);
    }

    const json = (await res.json()) as McpResponse<McpToolResult>;
    if (json.error) {
      throw new ApiError(500, json.error.message);
    }
    const toolResult = json.result;
    if (toolResult?.isError) {
      throw new ApiError(500, toolResult.content[0]?.text ?? "Tool error");
    }
    return toolResult?.content?.[0]?.text ?? "";
  }
}

const mcpClient = new McpClient();

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseDirectoryListing(basePath: string, text: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const isDir = trimmed.endsWith("/");
    const name = isDir ? trimmed.slice(0, -1) : trimmed;
    const joinedPath = `${basePath.replace(/\/$/, "")}/${name}`;
    entries.push({ name, path: joinedPath, type: isDir ? "directory" : "file" });
  }
  return entries;
}

// Matches: path/to/file.ts:42:  some content
const GREP_LINE_RE = /^([^:]+):(\d+):(.*)$/;

function parseSearchResults(text: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of text.split("\n")) {
    const match = GREP_LINE_RE.exec(line.trim());
    if (!match) continue;
    const [, path, lineStr, content] = match;
    results.push({ path, line: parseInt(lineStr, 10), content: content.trim() });
  }
  return results;
}

// ---------------------------------------------------------------------------
// FileAPI
// ---------------------------------------------------------------------------

export interface ReadOptions {
  offset?: number;
  limit?: number;
}

export interface SearchOptions {
  glob?: string;
}

export interface FileAPI {
  list(path: string): Promise<FileEntry[]>;
  read(path: string, options?: ReadOptions): Promise<string>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  upload(file: File): Promise<UploadResult>;
}

export const fileAPI: FileAPI = {
  async list(path) {
    const text = await mcpClient.callTool("list_directory", { path });
    return parseDirectoryListing(path, text);
  },

  async read(path, opts) {
    const args: Record<string, unknown> = { path };
    if (opts?.offset != null) args.offset = opts.offset;
    if (opts?.limit != null) args.limit = opts.limit;
    return mcpClient.callTool("read_source_file", args);
  },

  async search(query, opts) {
    const args: Record<string, unknown> = { pattern: query };
    if (opts?.glob) args.glob = opts.glob;
    const text = await mcpClient.callTool("search_source", args);
    return parseSearchResults(text);
  },

  async upload(_file) {
    // The MCP server does not expose a file upload endpoint.
    throw new ApiError(501, "File upload is not supported", "server");
  },
};
