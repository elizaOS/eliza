/**
 * Eliza SSE bridge — the LLM leg of the voice loop.
 *
 * The realtime path does NOT add a new LLM client. It reuses the existing Eliza
 * conversation SSE / `/api/v1/chat/completions` pass-through (contract §7.6 /
 * §10), which already reaches the Cerebras `gemma-4-31b` byte pass-through. This
 * module's only jobs are:
 *   - POST the user's final transcript to that SSE endpoint with the
 *     `X-Eliza-Voice-Trace-Id` header (reusing #15931's trace contract);
 *   - propagate an `AbortSignal` so an interruption cancels the in-flight fetch,
 *     which cancels the upstream provider stream (the route's tee/abort seam);
 *   - decode the OpenAI-shaped SSE `delta.content` tokens into a plain string
 *     stream for the phrase aggregator.
 *
 * It writes NO conversation history and holds NO provider key; the underlying
 * route owns auth, billing, and persistence. `fetchImpl` is injectable so the
 * WS session lifecycle can be tested against a scripted SSE body with the real
 * decoding path, no live model.
 */

export const VOICE_TRACE_HEADER = "X-Eliza-Voice-Trace-Id";
/** Scope headers so the configured endpoint routes the turn to the right agent. */
export const VOICE_AGENT_HEADER = "X-Eliza-Agent-Id";
export const VOICE_CONVERSATION_HEADER = "X-Eliza-Conversation-Id";

export interface ElizaSseBridgeRequest {
  /** Absolute or worker-internal URL of the chat/completions SSE endpoint. */
  endpoint: string;
  /** Bearer token for the existing Eliza session (server-held; never the client's). */
  authorization: string;
  /** Model id — the gemma pass-through id per the integration decision. */
  model: string;
  /** The authoritative user turn (from stt_final). */
  transcript: string;
  /** Agent this session is scoped to (from the verified token claims). */
  agentId: string;
  /** Conversation this session writes into (from the verified token claims). */
  conversationId: string;
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
    response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: request.authorization,
        Accept: "text/event-stream",
        [VOICE_TRACE_HEADER]: request.traceId,
        // Carry the session scope in headers too, so the configured endpoint
        // routes the turn to the selected agent/conversation even if its body
        // schema (e.g. the plain chat/completions ChatRequest) ignores the
        // body fields. `VOICE_REALTIME_ELIZA_ENDPOINT` must point at an
        // endpoint that consumes this scope (agent conversation API or a
        // voice-aware shim), not raw chat/completions, for agent context +
        // persistence.
        [VOICE_AGENT_HEADER]: request.agentId,
        [VOICE_CONVERSATION_HEADER]: request.conversationId,
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        // Scope the turn to the minted agent + conversation so voice traffic
        // routes to the selected agent and persists into the right
        // conversation, rather than a server default.
        agentId: request.agentId,
        conversationId: request.conversationId,
        messages: [
          ...(request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : []),
          { role: "user", content: request.transcript },
        ],
      }),
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
    throw new ElizaSseBridgeError(
      `Eliza SSE upstream returned HTTP ${response.status}`,
      "upstream_error",
      response.status,
    );
  }
  if (!response.body) {
    throw new ElizaSseBridgeError("Eliza SSE response has no body", "no_body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
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
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "") continue;
        if (payload === "[DONE]") {
          return { completed: true, aborted: false };
        }
        const delta = extractDeltaContent(payload);
        if (delta) onDelta(delta);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (ignoredError) {
      void ignoredError;
      // error-policy:J6 best-effort teardown — cancel on an already-ending
      // response body must not mask the loop's real outcome.
    }
  }

  if (request.signal.aborted) return { completed: false, aborted: true };
  return { completed: true, aborted: false };
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
