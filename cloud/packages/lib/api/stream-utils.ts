import { logger } from "@/lib/utils/logger";

export interface StreamState {
  isClientConnected: boolean;
  lastEventTime: number;
  heartbeatInterval: NodeJS.Timeout | null;
}

export interface StreamWriter {
  sendEvent: (event: string, data: unknown) => Promise<boolean>;
  startHeartbeat: (intervalMs?: number) => void;
  stopHeartbeat: () => void;
  close: () => Promise<void>;
  isConnected: () => boolean;
}

/**
 * Creates a managed SSE stream writer with heartbeat support
 */
export function createStreamWriter(writer: WritableStreamDefaultWriter<Uint8Array>): StreamWriter {
  const encoder = new TextEncoder();
  const state: StreamState = {
    isClientConnected: true,
    lastEventTime: Date.now(),
    heartbeatInterval: null,
  };

  const sendEvent = async (event: string, data: unknown): Promise<boolean> => {
    if (!state.isClientConnected) {
      return false;
    }

    try {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(message));
      state.lastEventTime = Date.now();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("WritableStream") ||
        errorMessage.includes("closed") ||
        errorMessage.includes("aborted")
      ) {
        logger.info("Client disconnected during stream write");
        state.isClientConnected = false;
        return false;
      }
      logger.error("Error writing to stream", { error: errorMessage });
      state.isClientConnected = false;
      return false;
    }
  };

  const stopHeartbeat = () => {
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
    }
  };

  const startHeartbeat = (intervalMs = 15000) => {
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
    }

    state.heartbeatInterval = setInterval(async () => {
      if (!state.isClientConnected) {
        stopHeartbeat();
        return;
      }

      const timeSinceLastEvent = Date.now() - state.lastEventTime;
      if (timeSinceLastEvent >= intervalMs - 1000) {
        const sent = await sendEvent("heartbeat", { timestamp: Date.now() });
        if (!sent) {
          stopHeartbeat();
        }
      }
    }, intervalMs);
  };

  const close = async () => {
    stopHeartbeat();
    state.isClientConnected = false;

    try {
      await writer.close();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("closed") && !errorMessage.includes("aborted")) {
        logger.warn("Error closing stream writer", { error: errorMessage });
      }
    }
  };

  const isConnected = () => state.isClientConnected;

  return { sendEvent, startHeartbeat, stopHeartbeat, close, isConnected };
}

/**
 * Standard SSE response headers
 */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
