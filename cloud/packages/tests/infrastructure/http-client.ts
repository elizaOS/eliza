/**
 * HTTP Client & SSE Utilities for E2E Testing
 *
 * Provides utilities for making HTTP requests and parsing SSE streams
 * in integration tests. Zero mocking - real HTTP requests to real endpoints.
 */

/**
 * SSE Event parsed from a stream
 */
export interface SSEEvent {
  event: string;
  data: unknown;
  raw: string;
}

/**
 * Parsed streaming message events
 */
export interface StreamingMessageEvents {
  connected?: { roomId: string; timestamp: number };
  userMessage?: {
    id: string;
    entityId: string;
    content: { text: string; attachments?: unknown[] };
    createdAt: number;
    isAgent: boolean;
    type: "user";
  };
  thinking?: {
    id: string;
    entityId: string;
    content: { text: string };
    createdAt: number;
    isAgent: boolean;
    type: "thinking";
  };
  chunks: Array<{
    messageId: string;
    chunk: string;
    timestamp: number;
  }>;
  reasoningChunks: Array<{
    messageId: string;
    chunk: string;
    phase: string;
    timestamp: number;
  }>;
  agentMessage?: {
    id: string;
    entityId: string;
    agentId?: string;
    content: {
      text: string;
      source?: string;
      attachments?: unknown[];
      actions?: unknown[];
      thought?: string;
      metadata?: Record<string, unknown>;
    };
    createdAt: number;
    isAgent: boolean;
    type: "agent";
  };
  warning?: { message: string };
  done?: { timestamp: number };
  error?: { message: string };
  allEvents: SSEEvent[];
}

/**
 * Parse a single SSE event from text
 */
function parseSSEEventText(eventText: string): SSEEvent | null {
  const lines = eventText.trim().split("\n");
  let eventType = "message";
  let dataLine = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      dataLine = line.slice(6);
    }
  }

  if (!dataLine) {
    return null;
  }

  try {
    const data = JSON.parse(dataLine);
    return {
      event: eventType,
      data,
      raw: eventText,
    };
  } catch {
    return {
      event: eventType,
      data: dataLine,
      raw: eventText,
    };
  }
}

/**
 * Parse SSE stream from a Response object
 * Yields events as they are received
 */
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<SSEEvent, void, undefined> {
  if (!response.body) {
    throw new Error("Response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining buffer
        if (buffer.trim()) {
          const event = parseSSEEventText(buffer);
          if (event) {
            yield event;
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by double newlines
      const events = buffer.split("\n\n");
      buffer = events.pop() || ""; // Keep incomplete event in buffer

      for (const eventText of events) {
        if (eventText.trim()) {
          const event = parseSSEEventText(eventText);
          if (event) {
            yield event;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Collect all SSE events from a response into an array
 */
export async function collectSSEEvents(response: Response): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of parseSSEStream(response)) {
    events.push(event);
  }
  return events;
}

/**
 * Parse SSE events into structured streaming message events
 */
export async function parseStreamingResponse(response: Response): Promise<StreamingMessageEvents> {
  const result: StreamingMessageEvents = {
    chunks: [],
    reasoningChunks: [],
    allEvents: [],
  };

  for await (const event of parseSSEStream(response)) {
    result.allEvents.push(event);
    const data = event.data as Record<string, unknown>;

    switch (event.event) {
      case "connected":
        result.connected = data as StreamingMessageEvents["connected"];
        break;

      case "message":
        if (data.type === "user") {
          result.userMessage = data as StreamingMessageEvents["userMessage"];
        } else if (data.type === "thinking") {
          result.thinking = data as StreamingMessageEvents["thinking"];
        } else if (data.type === "agent") {
          result.agentMessage = data as StreamingMessageEvents["agentMessage"];
        }
        break;

      case "chunk":
        result.chunks.push(data as StreamingMessageEvents["chunks"][0]);
        break;

      case "reasoning":
        result.reasoningChunks.push(data as StreamingMessageEvents["reasoningChunks"][0]);
        break;

      case "warning":
        result.warning = data as StreamingMessageEvents["warning"];
        break;

      case "done":
        result.done = data as StreamingMessageEvents["done"];
        break;

      case "error":
        result.error = data as StreamingMessageEvents["error"];
        break;
    }
  }

  return result;
}

/**
 * HTTP Client for API testing
 */
export interface TestApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  sessionToken?: string;
  timeout?: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
}

export class TestApiClient {
  private baseUrl: string;
  private apiKey?: string;
  private sessionToken?: string;
  private defaultTimeout: number;

  constructor(options: TestApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.sessionToken = options.sessionToken;
    this.defaultTimeout = options.timeout || 30000;
  }

  /**
   * Get default headers for requests
   */
  private getHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...customHeaders,
    };

    if (this.apiKey) {
      headers["X-API-Key"] = this.apiKey;
    }

    if (this.sessionToken) {
      headers["X-Anonymous-Session"] = this.sessionToken;
    }

    return headers;
  }

  /**
   * Make a GET request
   */
  async get(path: string, options?: RequestOptions): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout || this.defaultTimeout);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: this.getHeaders(options?.headers),
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Make a POST request
   */
  async post(path: string, body: unknown, options?: RequestOptions): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout || this.defaultTimeout);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.getHeaders(options?.headers),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Make a DELETE request
   */
  async delete(path: string, options?: RequestOptions): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options?.timeout || this.defaultTimeout);

    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: this.getHeaders(options?.headers),
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a streaming message and get parsed events
   */
  async sendStreamingMessage(
    roomId: string,
    text: string,
    options?: {
      model?: string;
      agentMode?: { mode: string; metadata?: Record<string, unknown> };
      attachments?: unknown[];
      appId?: string;
      appPromptConfig?: Record<string, unknown>;
      webSearchEnabled?: boolean;
      timeout?: number;
    },
  ): Promise<StreamingMessageEvents> {
    const response = await this.post(
      `/api/eliza/rooms/${roomId}/messages/stream`,
      {
        text,
        model: options?.model,
        agentMode: options?.agentMode,
        attachments: options?.attachments,
        appId: options?.appId,
        appPromptConfig: options?.appPromptConfig,
        webSearchEnabled: options?.webSearchEnabled,
      },
      { timeout: options?.timeout || 60000 },
    );

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new StreamingError(
        `Streaming request failed: ${response.status}`,
        response.status,
        errorBody,
      );
    }

    return parseStreamingResponse(response);
  }

  /**
   * Create a new room
   * API returns: { success, roomId, characterId, createdAt }
   */
  async createRoom(options?: {
    characterId?: string;
    name?: string;
  }): Promise<{ id: string; characterId?: string; createdAt: number }> {
    const response = await this.post("/api/eliza/rooms", {
      characterId: options?.characterId,
      name: options?.name,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw new Error(`Failed to create room: ${response.status} - ${JSON.stringify(errorBody)}`);
    }

    const data = await response.json();
    // Map roomId to id for convenience
    return {
      id: data.roomId,
      characterId: data.characterId,
      createdAt: data.createdAt,
    };
  }

  /**
   * Get room details
   */
  async getRoom(roomId: string): Promise<Response> {
    return this.get(`/api/eliza/rooms/${roomId}`);
  }

  /**
   * Delete a room
   */
  async deleteRoom(roomId: string): Promise<Response> {
    return this.delete(`/api/eliza/rooms/${roomId}`);
  }

  /**
   * Update client with new session token
   */
  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  /**
   * Update client with new API key
   */
  setApiKey(key: string): void {
    this.apiKey = key;
  }
}

/**
 * Custom error for streaming failures
 */
export class StreamingError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "StreamingError";
  }
}

/**
 * Create a test API client
 */
export function createTestApiClient(options: TestApiClientOptions): TestApiClient {
  return new TestApiClient(options);
}

/**
 * Assert that a streaming response completed successfully
 */
export function assertStreamingSuccess(events: StreamingMessageEvents): void {
  if (events.error) {
    throw new Error(`Streaming failed with error: ${events.error.message}`);
  }

  if (!events.connected) {
    throw new Error("Missing connected event");
  }

  if (!events.done) {
    throw new Error("Missing done event");
  }
}

/**
 * Assert that streaming received expected events in order
 */
export function assertStreamingOrder(events: StreamingMessageEvents): void {
  const eventOrder = events.allEvents.map((e) => e.event);

  // Expected order: connected -> message(user) -> message(thinking) -> chunks -> message(agent) -> done
  const connectedIdx = eventOrder.indexOf("connected");
  const doneIdx = eventOrder.lastIndexOf("done");

  if (connectedIdx === -1) {
    throw new Error("Missing connected event");
  }

  if (doneIdx === -1) {
    throw new Error("Missing done event");
  }

  if (connectedIdx !== 0) {
    throw new Error("Connected event must be first");
  }

  if (doneIdx !== eventOrder.length - 1) {
    throw new Error("Done event must be last");
  }
}

/**
 * Get full text from streaming chunks
 */
export function getFullTextFromChunks(events: StreamingMessageEvents): string {
  return events.chunks.map((c) => c.chunk).join("");
}

const httpClient = {
  parseSSEStream,
  collectSSEEvents,
  parseStreamingResponse,
  createTestApiClient,
  TestApiClient,
  StreamingError,
  assertStreamingSuccess,
  assertStreamingOrder,
  getFullTextFromChunks,
};

export default httpClient;
