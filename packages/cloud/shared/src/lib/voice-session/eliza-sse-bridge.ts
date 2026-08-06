/**
 * Eliza SSE bridge — the LLM leg of the voice loop.
 *
 * The realtime path does NOT add a new LLM client. It reuses the existing Eliza
 * canonical agent conversation message stream. That route executes the selected
 * agent and persists the turn before streaming its reply. This module's only jobs are:
 *   - POST the user's final transcript to that conversation endpoint with the
 *     `X-Eliza-Voice-Trace-Id` header (reusing #15931's trace contract);
 *   - propagate an `AbortSignal` so an interruption cancels the in-flight fetch,
 *     which cancels the upstream provider stream (the route's tee/abort seam);
 *   - decode canonical `chunk`, local runtime `type=token`, and OpenAI-shaped
 *     `delta.content` frames into a plain string stream for phrase aggregation.
 *
 * It holds no provider key; the canonical route owns auth, billing, and
 * persistence. `fetchImpl` is injectable so the
 * WS session lifecycle can be tested against a scripted SSE body with the real
 * decoding path, no live model.
 */

export const VOICE_TRACE_HEADER = "X-Eliza-Voice-Trace-Id";
/** Scope headers so the configured endpoint routes the turn to the right agent. */
export const VOICE_AGENT_HEADER = "X-Eliza-Agent-Id";
export const VOICE_CONVERSATION_HEADER = "X-Eliza-Conversation-Id";
export const VOICE_ORGANIZATION_HEADER = "X-Eliza-Organization-Id";
export const VOICE_USER_HEADER = "X-Eliza-User-Id";

export interface ElizaSseBridgeRequest {
  /** API origin hosting the canonical agent conversation routes. */
  endpoint: string;
  /** Bearer token for the existing Eliza session (server-held; never the client's). */
  authorization: string;
  /** Retained for config compatibility; canonical agent routing selects its own model. */
  model: string;
  /** The authoritative user turn (from stt_final). */
  transcript: string;
  /** Agent this session is scoped to (from the verified token claims). */
  agentId: string;
  /** Conversation this session writes into (from the verified token claims). */
  conversationId: string;
  /** Verified voice-token tenancy, accepted only with the server-held credential. */
  organizationId?: string;
  userId?: string;
  /** Optional system prompt; the route applies its own default if omitted. */
  systemPrompt?: string;
  /** Per-turn trace id, propagated via the voice trace header. */
  traceId: string;
  /** Abort → cancels the fetch → cancels the upstream provider stream. */
  signal: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ElizaSseBridgeResult {
  /** True if the stream completed normally (saw `[DONE]` or clean end). */
  completed: boolean;
  /** True if the stream was aborted (interruption / disconnect). */
  aborted: boolean;
}

export class ElizaSseBridgeError extends Error {
  constructor(
    message: string,
    readonly code: "upstream_error" | "no_body" | "protocol_error",
    readonly status?: number,
    /** Canonical route error code, safe to forward to the voice client. */
    readonly upstreamCode?: string,
    /** Whether retrying the turn can succeed without user action. */
    readonly retryable = true,
    /** Bounded canonical-route message safe for a public voice error frame. */
    readonly upstreamMessage?: string,
    /** Bounded non-JSON upstream body prefix safe for diagnostics. */
    readonly upstreamSnippet?: string,
  ) {
    super(message);
    this.name = "ElizaSseBridgeError";
  }
}

/**
 * Stream LLM text deltas for a turn. Invokes `onDelta` for each non-empty
 * content token as it arrives. Resolves when the stream ends or is aborted.
 */
export async function streamElizaConversation(
  request: ElizaSseBridgeRequest,
  onDelta: (text: string) => void,
): Promise<ElizaSseBridgeResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  let response: Response;
  try {
    const endpoint = canonicalConversationStreamUrl(
      request.endpoint,
      request.agentId,
      request.conversationId,
    );
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: request.authorization,
        // Lets the same-worker subrequest pass the global programmatic-auth gate;
        // the leaf still timing-safe-validates Authorization against its env secret.
        "X-Service-Key": request.authorization,
        Accept: "text/event-stream",
        [VOICE_TRACE_HEADER]: request.traceId,
        [VOICE_AGENT_HEADER]: request.agentId,
        [VOICE_CONVERSATION_HEADER]: request.conversationId,
        ...(request.organizationId ? { [VOICE_ORGANIZATION_HEADER]: request.organizationId } : {}),
        ...(request.userId ? { [VOICE_USER_HEADER]: request.userId } : {}),
      },
      // This is the canonical message contract. Agent and conversation identity
      // are structural URL segments, so the route cannot silently discard them;
      // sharedRestMessageSend/bridgeStream executes and persists this turn.
      body: JSON.stringify({ text: request.transcript }),
      signal: request.signal,
    });
  } catch (error) {
    // error-policy:J2 context-adding rethrow — abort is a designed non-error
    // outcome; anything else becomes a typed upstream_error for the session's
    // turn boundary to translate.
    if (isAbortError(error) || request.signal.aborted) {
      return { completed: false, aborted: true };
    }
    throw new ElizaSseBridgeError(
      `Eliza SSE request failed: ${error instanceof Error ? error.message : String(error)}`,
      "upstream_error",
    );
  }

  if (!response.ok) {
    const upstreamError = await readUpstreamError(response);
    throw new ElizaSseBridgeError(
      upstreamError.message
        ? `Eliza SSE upstream returned HTTP ${response.status}: ${upstreamError.message}`
        : `Eliza SSE upstream returned HTTP ${response.status}`,
      "upstream_error",
      response.status,
      upstreamError.code,
      upstreamError.retryable,
      upstreamError.message,
      upstreamError.snippet,
    );
  }
  if (!response.body) {
    throw new ElizaSseBridgeError("Eliza SSE response has no body", "no_body");
  }

  const reader = response.body.getReader();
  let abortCancellation: Promise<void> | null = null;
  const cancelReaderOnAbort = () => {
    abortCancellation = reader.cancel(request.signal.reason).catch((error) => {
      void error;
      // error-policy:J6 best-effort teardown — the aborted voice turn remains
      // the authoritative outcome even if an already-failed body rejects cancel.
    });
  };
  if (request.signal.aborted) {
    cancelReaderOnAbort();
  } else {
    request.signal.addEventListener("abort", cancelReaderOnAbort, { once: true });
  }
  const decoder = new TextDecoder();
  let buffered = "";
  let eventType = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // error-policy:J2 abort discrimination — an aborted read is the
        // designed barge-in outcome; real stream errors rethrow to the caller.
        if (isAbortError(error) || request.signal.aborted) {
          return { completed: false, aborted: true };
        }
        throw error;
      }
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });

      let newlineIndex: number;
      // SSE events are separated by blank lines; a single event may carry
      // multiple `data:` lines. We process line-by-line and only act on
      // `data:` payloads, which is what the OpenAI-shaped stream emits.
      while ((newlineIndex = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newlineIndex).trimEnd();
        buffered = buffered.slice(newlineIndex + 1);
        if (line === "") {
          eventType = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "") continue;
        if (payload === "[DONE]" || eventType === "done") {
          return { completed: true, aborted: false };
        }
        if (eventType === "error") {
          throw new ElizaSseBridgeError(
            `Eliza agent stream error: ${extractErrorMessage(payload)}`,
            "upstream_error",
          );
        }
        const delta = extractDeltaContent(payload);
        if (delta) onDelta(delta);
      }
    }
  } finally {
    request.signal.removeEventListener("abort", cancelReaderOnAbort);
    if (abortCancellation) {
      await abortCancellation;
    } else {
      try {
        await reader.cancel();
      } catch (ignoredError) {
        void ignoredError;
        // error-policy:J6 best-effort teardown — cancel on an already-ending
        // response body must not mask the loop's real outcome.
      }
    }
  }

  if (request.signal.aborted) return { completed: false, aborted: true };
  return { completed: true, aborted: false };
}

function canonicalConversationStreamUrl(
  apiOrigin: string,
  agentId: string,
  conversationId: string,
): string {
  const url = new URL(apiOrigin);
  url.pathname = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

const MAX_UPSTREAM_ERROR_BYTES = 4096;
const SAFE_UPSTREAM_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_PUBLIC_UPSTREAM_MESSAGES = new Set([
  "Agent not found",
  "Invalid request body",
  "Message text is required",
  "Missing request body",
]);

function isSafePublicUpstreamMessage(message: string): boolean {
  return (
    SAFE_PUBLIC_UPSTREAM_MESSAGES.has(message) ||
    message === "Insufficient credits" ||
    message.startsWith("Insufficient credits. ")
  );
}

async function readUpstreamError(response: Response): Promise<{
  code?: string;
  message?: string;
  snippet?: string;
  retryable: boolean;
}> {
  const fallbackRetryable =
    response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.body) return { retryable: fallbackRetryable };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  try {
    while (bytesRead < MAX_UPSTREAM_ERROR_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = MAX_UPSTREAM_ERROR_BYTES - bytesRead;
      const bytes = chunk.value.subarray(0, remaining);
      bytesRead += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
      if (chunk.value.byteLength > remaining) break;
    }
    text += decoder.decode();
  } catch {
    // error-policy:J3 untrusted upstream body: preserve the status-derived fallback.
    return { retryable: fallbackRetryable };
  } finally {
    try {
      await reader.cancel();
    } catch (ignoredError) {
      void ignoredError;
      // error-policy:J6 best-effort response teardown must not mask the HTTP error.
    }
  }

  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    const rawCode = typeof parsed.code === "string" ? parsed.code : "";
    const rawMessage =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.message === "string"
          ? parsed.message
          : "";
    return {
      ...(SAFE_UPSTREAM_CODE.test(rawCode) ? { code: rawCode } : {}),
      ...(isSafePublicUpstreamMessage(rawMessage.trim())
        ? { message: rawMessage.trim().slice(0, 512) }
        : rawMessage.trim()
          ? { snippet: "Upstream request failed" }
          : {}),
      retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : fallbackRetryable,
    };
  } catch {
    // error-policy:J3 malformed/truncated upstream JSON: use status semantics.
    return {
      ...(text.trim() ? { snippet: "Upstream returned a non-JSON error" } : {}),
      retryable: fallbackRetryable,
    };
  }
}

function extractErrorMessage(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  } catch (error) {
    // Preserve a bounded raw payload when the canonical route returns malformed JSON.
    return payload.slice(0, 256) || `unknown agent stream error: ${String(error)}`;
  }
  return payload.slice(0, 256) || "unknown agent stream error";
}

function extractDeltaContent(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (ignoredError) {
    void ignoredError;
    // error-policy:J3 untrusted-input sanitizing — a non-JSON data line
    // (keepalive comment, etc.) is not a protocol error; the explicit null
    // means "no delta", never a fabricated delta.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // Canonical agent message streams emit event:chunk with a top-level chunk.
  const canonicalChunk = (parsed as { chunk?: unknown }).chunk;
  if (typeof canonicalChunk === "string" && canonicalChunk.length > 0) return canonicalChunk;
  const localToken = parsed as { type?: unknown; text?: unknown };
  if (
    localToken.type === "token" &&
    typeof localToken.text === "string" &&
    localToken.text.length > 0
  ) {
    return localToken.text;
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { delta?: { content?: unknown }; text?: unknown };
  const content = first?.delta?.content;
  if (typeof content === "string" && content.length > 0) return content;
  // Some providers stream `text` on legacy completions; accept it too.
  if (typeof first?.text === "string" && first.text.length > 0) return first.text;
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
