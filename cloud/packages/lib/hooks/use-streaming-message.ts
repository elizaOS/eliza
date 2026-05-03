"use client";

/**
 * Streaming message structure from SSE events.
 */
export interface StreamingMessage {
  id: string;
  entityId: string;
  agentId?: string;
  content: {
    text: string;
    thought?: string;
    source?: string;
    inReplyTo?: string;
  };
  createdAt: number;
  isAgent: boolean;
  type: "user" | "agent" | "thinking" | "reasoning" | "error";
}

/**
 * Reasoning chunk from planning phase.
 * Streamed in real-time to show LLM's chain-of-thought.
 */
export interface ReasoningChunkData {
  messageId: string;
  chunk: string;
  phase: "planning" | "actions" | "response";
  timestamp: number;
}

interface SSEErrorData {
  message?: string;
  error?: string;
}

/**
 * Chunk data from streaming event.
 */
export interface StreamChunkData {
  messageId: string;
  chunk: string;
  timestamp: number;
}

/**
 * Options for sending a streaming message.
 */
/** Default stream timeout in milliseconds (3 minutes for image generation support) */
const STREAM_TIMEOUT_MS = 180_000;

/** Maximum buffer size to prevent memory exhaustion (1MB) */
const MAX_BUFFER_SIZE = 1024 * 1024;

interface SendMessageOptions {
  /** Room ID where the message is sent. */
  roomId: string;
  /** Message text content. */
  text: string;
  /** Optional model selection override. */
  model?: string;
  /** Anonymous session token from URL (for unauthenticated users). */
  sessionToken?: string;
  /** Whether web search is enabled for this message. */
  webSearchEnabled?: boolean;
  /** Whether image creation is enabled for this message. */
  createImageEnabled?: boolean;
  /** Image model to use when createImageEnabled is true. */
  imageModel?: string;
  /** Callback invoked for each streamed message chunk. */
  onMessage: (message: StreamingMessage) => void;
  /** Callback invoked for each text chunk (real-time streaming). */
  onChunk?: (chunk: StreamChunkData) => void;
  /** Callback invoked for reasoning/chain-of-thought chunks. */
  onReasoning?: (chunk: ReasoningChunkData) => void;
  /** Optional error callback. */
  onError?: (error: string) => void;
  /** Optional completion callback. */
  onComplete?: () => void;
  /** Optional timeout in ms (default: 60000) */
  timeoutMs?: number;
}

/**
 * Sends a message and streams the response via Server-Sent Events (SSE).
 *
 * The entityId is derived from the authenticated user on the server.
 * Single endpoint handles everything - no cross-container issues!
 *
 * @param options - Message sending options including callbacks.
 */
export async function sendStreamingMessage({
  roomId,
  text,
  model,
  sessionToken,
  webSearchEnabled,
  createImageEnabled,
  imageModel,
  onMessage,
  onChunk,
  onReasoning,
  onError,
  onComplete,
  timeoutMs = STREAM_TIMEOUT_MS,
}: SendMessageOptions): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`/api/eliza/rooms/${roomId}/messages/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Include session token as header for anonymous users
        // This ensures session tracking works even if the cookie race condition occurs
        ...(sessionToken && { "X-Anonymous-Session": sessionToken }),
      },
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        text,
        ...(model && { model }), // Include model if provided
        // Also include in body as backup
        ...(sessionToken && { sessionToken }),
        // Always include webSearchEnabled (defaults to true, explicitly false disables)
        webSearchEnabled: webSearchEnabled ?? true,
        // Include createImageEnabled (defaults to false)
        createImageEnabled: createImageEnabled ?? false,
        // Include imageModel if createImageEnabled and model specified
        ...(createImageEnabled && imageModel && { imageModel }),
      }),
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Stream timeout: Request took too long");
    }
    throw error;
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    let errorMessage = "Failed to send message";
    const contentType = response.headers.get("content-type");

    // Try to parse JSON error response, but handle empty/invalid responses gracefully
    if (contentType?.includes("application/json")) {
      try {
        const text = await response.text();
        if (text.trim()) {
          const errorData = JSON.parse(text);
          errorMessage = errorData.error || errorData.message || errorMessage;
        } else {
          errorMessage = `Server returned ${response.status} ${response.statusText}`;
        }
      } catch {
        // If JSON parsing fails, use status text
        errorMessage = `Server returned ${response.status} ${response.statusText}`;
      }
    } else {
      // Non-JSON error response
      try {
        const text = await response.text();
        if (text.trim()) {
          errorMessage = text.substring(0, 200); // Limit error message length
        } else {
          errorMessage = `Server returned ${response.status} ${response.statusText}`;
        }
      } catch {
        errorMessage = `Server returned ${response.status} ${response.statusText}`;
      }
    }

    throw new Error(errorMessage);
  }

  if (!response.body) {
    clearTimeout(timeoutId);
    throw new Error("No response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let completeCalled = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining data in buffer
        if (buffer.trim()) {
          try {
            processSSEMessage(buffer.trim(), onMessage, onChunk, onReasoning, onError, () => {
              completeCalled = true;
              onComplete?.();
            });
          } catch (err) {
            console.error("[Stream] Error processing final buffer:", err);
            onError?.("Stream ended unexpectedly");
          }
        }
        // Always call onComplete when stream ends, if not already called
        if (!completeCalled) {
          onComplete?.();
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Prevent unbounded buffer growth (potential DoS vector)
      if (buffer.length > MAX_BUFFER_SIZE) {
        throw new Error("Stream buffer exceeded maximum size - possible malformed SSE data");
      }

      // Process complete SSE messages (separated by double newline)
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || ""; // Keep incomplete message in buffer

      for (const message of messages) {
        if (!message.trim()) continue;

        try {
          processSSEMessage(message.trim(), onMessage, onChunk, onReasoning, onError, onComplete);
        } catch (err) {
          console.error("[Stream] Error parsing SSE message:", err, message);
          // Continue processing other messages even if one fails
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      onError?.("Stream timeout: Connection took too long");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Parse a single SSE message block and invoke appropriate callbacks.
 * Handles proper SSE format with multi-line data support.
 */
function processSSEMessage(
  message: string,
  onMessage: (message: StreamingMessage) => void,
  onChunk?: (chunk: StreamChunkData) => void,
  onReasoning?: (chunk: ReasoningChunkData) => void,
  onError?: (error: string) => void,
  onComplete?: () => void,
): void {
  const lines = message.split("\n");
  let eventType = "message"; // Default event type
  const dataLines: string[] = [];

  // Parse SSE format: lines can be "event: <type>" or "data: <json>" (data can be multi-line)
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      // Collect all data lines (SSE allows multi-line data)
      dataLines.push(line.slice(6));
    }
  }

  // Skip if no data found
  if (dataLines.length === 0) {
    return;
  }

  // Join multi-line data (SSE spec allows this)
  const dataString = dataLines.join("\n");

  // Parse JSON data with error handling
  let data: unknown;
  try {
    data = JSON.parse(dataString);
  } catch (err) {
    console.error("[Stream] Failed to parse JSON data:", dataString, err);
    throw new Error(
      `Invalid JSON in SSE data: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Handle different event types
  switch (eventType) {
    case "message":
      // Validate message structure before passing to callback
      if (isValidStreamingMessage(data)) {
        onMessage(data);
      } else {
        console.warn("[Stream] Invalid message format:", data);
      }
      break;
    case "chunk":
      // Real-time streaming chunk - call onChunk if provided
      if (onChunk && isValidStreamChunkData(data as StreamChunkData)) {
        onChunk(data as StreamChunkData);
      }
      break;
    case "reasoning":
      // Chain-of-thought reasoning chunk - shows LLM's planning process
      if (onReasoning && isValidReasoningChunkData(data as ReasoningChunkData)) {
        onReasoning(data as ReasoningChunkData);
      }
      break;
    case "error": {
      const errorData = data as SSEErrorData;
      const errorMessage = errorData?.message || errorData?.error || "Unknown error";
      onError?.(errorMessage);
      break;
    }
    case "done":
      onComplete?.();
      break;
    case "connected":
      // Connection confirmation - can be ignored or logged
      console.debug("[Stream] Connected:", data);
      break;
    case "warning": {
      // Warning event - log but don't treat as error
      const warningData = data as SSEErrorData;
      const warningMessage = warningData?.message || "Warning received";
      console.warn("[Stream] Warning:", warningMessage);
      break;
    }
    default:
      console.debug(`[Stream] Unhandled event type: ${eventType}`, data);
  }
}

/**
 * Type guard to validate StreamChunkData structure
 */
function isValidStreamChunkData(data: StreamChunkData): data is StreamChunkData {
  if (!data || typeof data !== "object") return false;
  return (
    typeof data.messageId === "string" &&
    typeof data.chunk === "string" &&
    typeof data.timestamp === "number"
  );
}

/**
 * Type guard to validate ReasoningChunkData structure
 */
function isValidReasoningChunkData(data: ReasoningChunkData): data is ReasoningChunkData {
  if (!data || typeof data !== "object") return false;
  return (
    typeof data.messageId === "string" &&
    typeof data.chunk === "string" &&
    typeof data.phase === "string" &&
    typeof data.timestamp === "number"
  );
}

/**
 * Type guard to validate StreamingMessage structure
 */
function isValidStreamingMessage(data: unknown): data is StreamingMessage {
  if (!data || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (
    typeof msg.id !== "string" ||
    typeof msg.entityId !== "string" ||
    typeof msg.isAgent !== "boolean" ||
    typeof msg.type !== "string" ||
    typeof msg.createdAt !== "number" ||
    !msg.content ||
    typeof msg.content !== "object"
  ) {
    return false;
  }
  const content = msg.content as Record<string, unknown>;
  return typeof content.text === "string";
}
