/**
 * Options for Signal RPC requests
 */
export interface SignalRpcOptions {
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * Signal RPC error structure
 */
export interface SignalRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

/**
 * Signal RPC response structure
 */
export interface SignalRpcResponse<T> {
  jsonrpc?: string;
  result?: T;
  error?: SignalRpcError;
  id?: string | number | null;
}

/**
 * Signal SSE event structure
 */
export interface SignalSseEvent {
  event?: string;
  data?: string;
  id?: string;
}

/**
 * Result of a Signal health check
 */
export interface SignalCheckResult {
  ok: boolean;
  status?: number | null;
  error?: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Normalizes a base URL for Signal CLI HTTP server
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().slice(0, 2048);
  if (!trimmed) {
    throw new Error("Signal base URL is required");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/{1,256}$/, "");
  }
  return `http://${trimmed}`.replace(/\/{1,256}$/, "");
}

/**
 * Generates a UUID for RPC request IDs
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Fetches with a timeout
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Makes a JSON-RPC request to the Signal CLI HTTP server
 */
export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions
): Promise<T> {
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const id = generateId();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id,
  });

  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/rpc`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  // 201 indicates success with no response body
  if (res.status === 201) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    throw new Error(`Signal RPC empty response (status ${res.status})`);
  }

  const parsed = JSON.parse(text) as SignalRpcResponse<T>;
  if (parsed.error) {
    const code = parsed.error.code ?? "unknown";
    const msg = parsed.error.message ?? "Signal RPC error";
    throw new Error(`Signal RPC ${code}: ${msg}`);
  }

  return parsed.result as T;
}

/**
 * Checks if the Signal CLI HTTP server is available
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<SignalCheckResult> {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const res = await fetchWithTimeout(`${normalized}/api/v1/check`, { method: "GET" }, timeoutMs);
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, error: null };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Gets the current Signal version from the CLI
 */
export async function signalGetVersion(opts: SignalRpcOptions): Promise<string> {
  return signalRpcRequest<string>("version", undefined, opts);
}

/**
 * Lists all registered Signal accounts
 */
export async function signalListAccounts(
  opts: SignalRpcOptions
): Promise<Array<{ number: string; uuid: string }>> {
  return signalRpcRequest<Array<{ number: string; uuid: string }>>("listAccounts", undefined, opts);
}

/**
 * Gets contacts for a Signal account
 */
export async function signalListContacts(
  account: string,
  opts: SignalRpcOptions
): Promise<
  Array<{
    number: string;
    uuid: string;
    name?: string;
    profileName?: string;
    blocked?: boolean;
  }>
> {
  return signalRpcRequest("listContacts", { account }, opts);
}

/**
 * Gets groups for a Signal account
 */
export async function signalListGroups(
  account: string,
  opts: SignalRpcOptions
): Promise<
  Array<{
    id: string;
    name: string;
    description?: string;
    isMember: boolean;
    isBlocked: boolean;
    members: Array<{ uuid: string; number?: string }>;
  }>
> {
  return signalRpcRequest("listGroups", { account }, opts);
}

/**
 * Sends a message to a recipient or group
 */
export async function signalSend(
  params: {
    account: string;
    recipients?: string[];
    groupId?: string;
    message?: string;
    attachments?: string[];
    quote?: { timestamp: number; author: string };
  },
  opts: SignalRpcOptions
): Promise<{ timestamp: number }> {
  return signalRpcRequest("send", params, opts);
}

/**
 * Sends a reaction to a message
 */
export async function signalSendReaction(
  params: {
    account: string;
    recipient?: string;
    groupId?: string;
    emoji: string;
    targetAuthor: string;
    targetTimestamp: number;
    remove?: boolean;
  },
  opts: SignalRpcOptions
): Promise<void> {
  return signalRpcRequest("sendReaction", params, opts);
}

/**
 * Sends a typing indicator
 */
export async function signalSendTyping(
  params: {
    account: string;
    recipient?: string;
    groupId?: string;
    stop?: boolean;
  },
  opts: SignalRpcOptions
): Promise<void> {
  return signalRpcRequest("sendTyping", params, opts);
}

/**
 * Sends a read receipt
 */
export async function signalSendReadReceipt(
  params: {
    account: string;
    recipient: string;
    targetTimestamp: number;
  },
  opts: SignalRpcOptions
): Promise<void> {
  return signalRpcRequest("sendReadReceipt", params, opts);
}

/**
 * Streams SSE events from the Signal CLI HTTP server
 */
export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  onEvent: (event: SignalSseEvent) => void;
}): Promise<void> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const url = new URL(`${baseUrl}/api/v1/events`);
  if (params.account) {
    url.searchParams.set("account", params.account);
  }

  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    signal: params.abortSignal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Signal SSE failed (${res.status} ${res.statusText || "error"})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: SignalSseEvent = {};

  const flushEvent = () => {
    if (!currentEvent.data && !currentEvent.event && !currentEvent.id) {
      return;
    }
    params.onEvent({
      event: currentEvent.event,
      data: currentEvent.data,
      id: currentEvent.id,
    });
    currentEvent = {};
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");

    while (lineEnd !== -1) {
      let line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      // Empty line means end of event
      if (line === "") {
        flushEvent();
        lineEnd = buffer.indexOf("\n");
        continue;
      }

      // Comment line
      if (line.startsWith(":")) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }

      // Parse field: value
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        lineEnd = buffer.indexOf("\n");
        continue;
      }

      const field = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }

      if (field === "event") {
        currentEvent.event = value;
      } else if (field === "data") {
        currentEvent.data = currentEvent.data ? `${currentEvent.data}\n${value}` : value;
      } else if (field === "id") {
        currentEvent.id = value;
      }

      lineEnd = buffer.indexOf("\n");
    }
  }

  // Flush any remaining event
  flushEvent();
}

/**
 * Parses an SSE data field as JSON
 */
export function parseSignalEventData<T>(data: string | undefined): T | null {
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Creates an SSE event handler with reconnection logic
 */
export function createSignalEventStream(params: {
  baseUrl: string;
  account?: string;
  onEvent: (event: SignalSseEvent) => void;
  onError?: (error: Error) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}): {
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
} {
  let abortController: AbortController | null = null;
  let running = false;
  let reconnectDelay = params.reconnectDelayMs ?? 1000;
  const maxDelay = params.maxReconnectDelayMs ?? 30000;

  const connect = async () => {
    if (!running) {
      return;
    }

    abortController = new AbortController();

    try {
      params.onConnect?.();
      reconnectDelay = params.reconnectDelayMs ?? 1000;

      await streamSignalEvents({
        baseUrl: params.baseUrl,
        account: params.account,
        abortSignal: abortController.signal,
        onEvent: params.onEvent,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      params.onDisconnect?.();
    }

    // Reconnect with exponential backoff
    if (running) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    }
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      connect();
    },
    stop: () => {
      running = false;
      abortController?.abort();
      abortController = null;
    },
    isRunning: () => running,
  };
}
