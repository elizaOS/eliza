/**
 * Server-Sent Events (SSE) Parser utility
 *
 * This module provides a reusable SSE stream parser for app-builder operations.
 */

export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
}

export interface SSEParserOptions {
  onEvent: (event: SSEEvent) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

/**
 * Parses an SSE stream from a Response object
 * @param response - The fetch Response with SSE stream
 * @param options - Parser options including event handlers
 */
export async function parseSSEStream(
  response: Response,
  options: SSEParserOptions,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7);
        } else if (line.startsWith("data: ") && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            options.onEvent({ type: eventType, data });
          } catch (e) {
            // SyntaxError from JSON.parse - skip malformed data
            if (!(e instanceof SyntaxError)) {
              throw e;
            }
          }
          eventType = "";
        }
      }
    }
    options.onComplete?.();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    options.onError?.(err);
    throw err;
  }
}

/**
 * Type guard for checking SSE event types
 */
export function isSSEEventType<T extends string>(
  event: SSEEvent,
  type: T,
): event is SSEEvent & { type: T } {
  return event.type === type;
}

// Common event data types for app-builder
export interface ProgressEventData {
  step: string;
  message?: string;
}

export interface ToolUseEventData {
  tool: string;
  input?: Record<string, unknown>;
}

export interface CompleteEventData {
  session?: {
    id: string;
    sandboxId: string;
    sandboxUrl: string;
    expiresAt: string | null;
    appId?: string;
    githubRepo?: string | null;
    messages?: unknown[];
    examplePrompts?: string[];
  };
  output?: string;
  filesAffected?: string[];
  success?: boolean;
  error?: string;
  hasInitialPrompt?: boolean;
}

export interface RestoreProgressEventData {
  current: number;
  total: number;
  filePath: string;
}

export interface ErrorEventData {
  error: string;
}
