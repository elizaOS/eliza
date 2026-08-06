import { apiClient } from "./client";
import { parseStream } from "./stream";
import { ApiError } from "./types";
import type { StreamEvent, StreamProgress } from "./types";
import type { Message } from "../types";
import { DEFAULT_MODEL } from "../constants";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Combine any number of AbortSignals into one. */
function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

function toApiMessages(
  messages: Message[]
): Array<{ role: string; content: unknown }> {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

// ---------------------------------------------------------------------------
// Per-conversation abort controllers (for stop())
// ---------------------------------------------------------------------------

const activeControllers = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// MessageAPI
// ---------------------------------------------------------------------------

export interface SendOptions {
  model?: string;
  maxTokens?: number;
  files?: File[];
  signal?: AbortSignal;
  onProgress?: (progress: StreamProgress) => void;
}

export interface MessageAPI {
  /**
   * Send a user message in a conversation and stream the assistant response.
   * The caller is responsible for reading the conversation history from the
   * store and providing it in `history`.
   */
  send(
    conversationId: string,
    content: string,
    history: Message[],
    opts?: SendOptions
  ): AsyncGenerator<StreamEvent>;

  /**
   * Retry an assistant message. Sends everything up to and including the
   * user message that preceded `messageId`.
   */
  retry(
    conversationId: string,
    messagesUpToAssistant: Message[],
    opts?: SendOptions
  ): AsyncGenerator<StreamEvent>;

  /**
   * Edit a user message and regenerate the assistant response.
   * `historyBefore` should contain only the messages before the edited one.
   */
  edit(
    conversationId: string,
    newContent: string,
    historyBefore: Message[],
    opts?: SendOptions
  ): AsyncGenerator<StreamEvent>;

  /** Cancel any in-progress stream for this conversation. */
  stop(conversationId: string): Promise<void>;
}

async function* streamRequest(
  conversationId: string,
  body: Record<string, unknown>,
  opts?: SendOptions
): AsyncGenerator<StreamEvent> {
  // Cancel any existing stream for this conversation
  activeControllers.get(conversationId)?.abort();
  const controller = new AbortController();
  activeControllers.set(conversationId, controller);

  const signal = combineSignals(opts?.signal, controller.signal);

  try {
    const res = await apiClient.postStream("/api/chat", body, { signal });
    yield* parseStream(res, { signal, onProgress: opts?.onProgress });
  } catch (err) {
    if (err instanceof ApiError && err.type === "abort") return; // stop() was called
    throw err;
  } finally {
    if (activeControllers.get(conversationId) === controller) {
      activeControllers.delete(conversationId);
    }
  }
}

export const messageAPI: MessageAPI = {
  async *send(conversationId, content, history, opts) {
    const model = opts?.model ?? DEFAULT_MODEL;
    const messages = [
      ...toApiMessages(history),
      { role: "user", content },
    ];
    yield* streamRequest(
      conversationId,
      { messages, model, stream: true, max_tokens: opts?.maxTokens },
      opts
    );
  },

  async *retry(conversationId, messagesUpToAssistant, opts) {
    const model = opts?.model ?? DEFAULT_MODEL;
    const messages = toApiMessages(messagesUpToAssistant);
    yield* streamRequest(
      conversationId,
      { messages, model, stream: true },
      opts
    );
  },

  async *edit(conversationId, newContent, historyBefore, opts) {
    const model = opts?.model ?? DEFAULT_MODEL;
    const messages = [
      ...toApiMessages(historyBefore),
      { role: "user", content: newContent },
    ];
    yield* streamRequest(
      conversationId,
      { messages, model, stream: true },
      opts
    );
  },

  async stop(conversationId) {
    activeControllers.get(conversationId)?.abort();
    activeControllers.delete(conversationId);
  },
};
