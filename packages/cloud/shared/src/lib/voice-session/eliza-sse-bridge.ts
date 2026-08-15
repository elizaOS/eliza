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
 *     `delta.content` frames into one authoritative text stream for phrase
 *     aggregation. Action-callback frames are explicitly provisional, so they
 *     stay buffered until a model replacement or the terminal frame selects
 *     the one reply TTS may speak.
 *
 * It holds no provider key; the canonical route owns auth, billing, and
 * persistence. `fetchImpl` is injectable so the
 * WS session lifecycle can be tested against a scripted SSE body with the real
 * decoding path, no live model.
 */

import {
  type ChatTurnStatus,
  REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX,
  REALTIME_VOICE_CLIENT_TRANSPORT,
  type VoiceOutputPolicy,
} from "@elizaos/shared";

export const VOICE_TRACE_HEADER = "X-Eliza-Voice-Trace-Id";
export const VOICE_CLIENT_MESSAGE_ID_PREFIX = REALTIME_VOICE_CLIENT_MESSAGE_ID_PREFIX;
export const MAX_VOICE_CLIENT_MESSAGE_ID_CHARS = 128;
/** Scope headers so the configured endpoint routes the turn to the right agent. */
export const VOICE_AGENT_HEADER = "X-Eliza-Agent-Id";
export const VOICE_CONVERSATION_HEADER = "X-Eliza-Conversation-Id";
export const VOICE_ORGANIZATION_HEADER = "X-Eliza-Organization-Id";
export const VOICE_USER_HEADER = "X-Eliza-User-Id";
export const VOICE_STREAM_PROTOCOL = "delta-v2" as const;

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
  /** Content-free canonical phase updates used by bounded voice progress. */
  onStatus?: (status: ChatTurnStatus) => void;
  /** Abort → cancels the fetch → cancels the upstream provider stream. */
  signal: AbortSignal;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ElizaSseBridgeResult {
  /** True only after an explicit `[DONE]` or structured terminal frame. */
  completed: boolean;
  /** True if the stream was aborted (interruption / disconnect). */
  aborted: boolean;
  /** Successful model-selected VIEWS handoff carried by the terminal frame. */
  viewHandoff?: ElizaVoiceViewHandoff;
  /**
   * Optional, terminal-only speech policy. Display text stays the canonical
   * `fullText`; this directive can never replace or hide persisted output.
   */
  outputDirective?: ElizaVoiceOutputDirective;
}

export interface ElizaVoiceOutputDirective {
  policy: VoiceOutputPolicy;
  /** Explicit concise speech; omitted means conservatively project fullText. */
  spoken?: string;
}

export interface ElizaVoiceViewHandoff {
  viewId: string;
  viewPath?: string;
  subview?: string;
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
 * Correlate the canonical chat request with its realtime voice turn. The same
 * id is used by the local runtime's exact abort endpoint, so cancellation can
 * target one request without guessing from room-level activity.
 */
export function voiceClientMessageIdForTrace(traceId: string): string {
  const normalized = traceId.trim();
  const clientMessageId = `${VOICE_CLIENT_MESSAGE_ID_PREFIX}${normalized}`;
  if (
    normalized.length === 0 ||
    normalized !== traceId ||
    clientMessageId.length > MAX_VOICE_CLIENT_MESSAGE_ID_CHARS
  ) {
    throw new ElizaSseBridgeError(
      "Eliza voice trace cannot be represented as a client message id",
      "protocol_error",
      undefined,
      undefined,
      false,
    );
  }
  return clientMessageId;
}

/**
 * Stream LLM text deltas for a turn. Invokes `onDelta` for each non-empty
 * content token as it arrives. Resolves on an explicit terminal frame or abort;
 * an unframed EOF is a protocol failure because it cannot authorize snapshots.
 */
export async function streamElizaConversation(
  request: ElizaSseBridgeRequest,
  onDelta: (text: string) => void,
): Promise<ElizaSseBridgeResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const clientMessageId = voiceClientMessageIdForTrace(request.traceId);
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
      body: JSON.stringify({
        text: request.transcript,
        clientMessageId,
        metadata: {
          clientTransport: REALTIME_VOICE_CLIENT_TRANSPORT,
        },
        // Snapshot-only action replies must remain distinguishable from model
        // deltas. The local loopback adapter preserves this exact negotiation.
        streamProtocol: VOICE_STREAM_PROTOCOL,
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
  let emittedText = "";
  let pendingProvisionalText: string | null = null;
  const emitDelta = (text: string): void => {
    if (!text) return;
    emittedText += text;
    onDelta(text);
  };
  const authorizeText = (authoritativeText: string): void => {
    pendingProvisionalText = null;
    if (!authoritativeText.startsWith(emittedText)) {
      throw new ElizaSseBridgeError(
        "Eliza agent authoritative reply diverged from text already emitted by the canonical stream",
        "protocol_error",
      );
    }
    emitDelta(authoritativeText.slice(emittedText.length));
  };
  const applyTextUpdate = (update: VoiceTextUpdate): void => {
    if (update.provisional) {
      pendingProvisionalText =
        update.kind === "snapshot"
          ? update.text
          : `${pendingProvisionalText ?? emittedText}${update.text}`;
      return;
    }

    if (update.kind === "delta") {
      // A delta extends the current wire buffer, so its non-provisional frame
      // authorizes the held prefix as well. A snapshot below replaces it.
      authorizeText(`${pendingProvisionalText ?? emittedText}${update.text}`);
      return;
    }
    authorizeText(update.text);
  };
  const finishAuthoritativeText = (payload: string): void => {
    const terminal = extractTerminalText(payload);
    const terminalText = terminal.present ? terminal.text : pendingProvisionalText;
    if (terminalText === null) return;
    authorizeText(terminalText);
  };
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
        const payloadType = extractPayloadType(payload);
        if (payload === "[DONE]" || eventType === "done" || payloadType === "done") {
          finishAuthoritativeText(payload);
          const viewHandoff = payload === "[DONE]" ? null : extractViewHandoff(payload);
          const outputDirective =
            payload === "[DONE]" ? null : extractVoiceOutputDirective(payload);
          return {
            completed: true,
            aborted: false,
            ...(viewHandoff ? { viewHandoff } : {}),
            ...(outputDirective ? { outputDirective } : {}),
          };
        }
        if (eventType === "error" || payloadType === "error") {
          throw new ElizaSseBridgeError(
            `Eliza agent stream error: ${extractErrorMessage(payload)}`,
            "upstream_error",
          );
        }
        if (payloadType === "status") {
          const status = extractChatTurnStatus(payload);
          if (status) request.onStatus?.(status);
          continue;
        }
        const update = extractTextUpdate(payload);
        if (update) applyTextUpdate(update);
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
  throw new ElizaSseBridgeError(
    "Eliza agent stream ended before its terminal reply",
    "protocol_error",
  );
}

const CHAT_TURN_STATUS_KINDS = new Set<ChatTurnStatus["kind"]>([
  "thinking",
  "streaming",
  "running_action",
  "running_tool",
  "evaluating",
  "waking",
  "speaking",
]);

/** Parse only the bounded, content-free status fields voice progress needs. */
function extractChatTurnStatus(payload: string): ChatTurnStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "status") return null;
  const kind = parsed.kind;
  if (typeof kind !== "string" || !CHAT_TURN_STATUS_KINDS.has(kind as ChatTurnStatus["kind"])) {
    return null;
  }
  const label = readBoundedString(parsed.label);
  const actionName = readBoundedString(parsed.actionName);
  const toolName = readBoundedString(parsed.toolName);
  if (
    (parsed.label !== undefined && !label) ||
    (parsed.actionName !== undefined && !actionName) ||
    (parsed.toolName !== undefined && !toolName)
  ) {
    return null;
  }
  return {
    kind: kind as ChatTurnStatus["kind"],
    ...(label ? { label } : {}),
    ...(actionName ? { actionName } : {}),
    ...(toolName ? { toolName } : {}),
  };
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

function extractPayloadType(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : null;
  } catch (ignoredError) {
    void ignoredError;
    // error-policy:J3 untrusted SSE payloads without JSON have no typed control
    // meaning; token extraction and explicit event labels still handle them.
    return null;
  }
}

type VoiceTextUpdate =
  | { kind: "delta"; text: string; provisional: boolean }
  | { kind: "snapshot"; text: string; provisional: boolean };

function extractTextUpdate(payload: string): VoiceTextUpdate | null {
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
  const provisional = (parsed as { provisional?: unknown }).provisional === true;
  // Canonical agent message streams emit event:chunk with a top-level chunk.
  const canonicalChunk = (parsed as { chunk?: unknown }).chunk;
  if (typeof canonicalChunk === "string" && canonicalChunk.length > 0) {
    return { kind: "delta", text: canonicalChunk, provisional };
  }
  const localToken = parsed as {
    type?: unknown;
    text?: unknown;
    fullText?: unknown;
  };
  // Delta-v2 checkpoints may carry both the latest delta and accumulated text.
  // The snapshot is canonical; consuming both would duplicate the latest chunk.
  if (
    localToken.type === "token" &&
    typeof localToken.fullText === "string" &&
    localToken.fullText.length > 0
  ) {
    return { kind: "snapshot", text: localToken.fullText, provisional };
  }
  if (
    localToken.type === "token" &&
    typeof localToken.text === "string" &&
    localToken.text.length > 0
  ) {
    return { kind: "delta", text: localToken.text, provisional };
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { delta?: { content?: unknown }; text?: unknown };
  const content = first?.delta?.content;
  if (typeof content === "string" && content.length > 0) {
    return { kind: "delta", text: content, provisional };
  }
  // Some providers stream `text` on legacy completions; accept it too.
  if (typeof first?.text === "string" && first.text.length > 0) {
    return { kind: "delta", text: first.text, provisional };
  }
  return null;
}

function extractTerminalText(payload: string): {
  present: boolean;
  text: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (ignoredError) {
    void ignoredError;
    // error-policy:J3 terminal SSE text is untrusted; malformed JSON cannot
    // become authoritative output.
    return { present: false, text: "" };
  }
  if (!isRecord(parsed)) return { present: false, text: "" };
  if (typeof parsed.fullText === "string") {
    return { present: true, text: parsed.fullText };
  }
  if (typeof parsed.text === "string") {
    return { present: true, text: parsed.text };
  }
  return { present: false, text: "" };
}

function extractViewHandoff(payload: string): ElizaVoiceViewHandoff | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (ignoredError) {
    void ignoredError;
    // error-policy:J3 terminal SSE metadata is untrusted input; malformed JSON
    // produces an explicit absent handoff and never a fabricated navigation.
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.actionResults)) return null;

  for (let index = parsed.actionResults.length - 1; index >= 0; index--) {
    const candidate = parsed.actionResults[index];
    if (!isRecord(candidate) || candidate.success !== true) continue;
    const data = isRecord(candidate.data) ? candidate.data : null;
    const actionName =
      typeof candidate.actionName === "string"
        ? candidate.actionName
        : typeof data?.actionName === "string"
          ? data.actionName
          : null;
    if (actionName?.toUpperCase() !== "VIEWS" || !isRecord(candidate.values)) {
      continue;
    }
    const mode = readBoundedString(candidate.values.mode)?.toLowerCase();
    const viewId = readBoundedString(candidate.values.viewId);
    if ((mode !== "show" && mode !== "open") || !viewId) continue;
    const viewPath = readBoundedString(candidate.values.viewPath);
    const subview = readBoundedString(candidate.values.subview);
    return {
      viewId,
      ...(viewPath ? { viewPath } : {}),
      ...(subview ? { subview } : {}),
    };
  }
  return null;
}

const VOICE_OUTPUT_POLICIES = new Set<VoiceOutputPolicy>(["say", "show", "both", "never_speak"]);
const MAX_EXPLICIT_SPOKEN_TEXT_CHARS = 2_000;

/**
 * Read the additive terminal `voiceOutput` directive. The canonical route does
 * not emit it for legacy turns, which intentionally defaults at the session
 * boundary. If the field is present it must be fully valid; malformed policy
 * must never degrade to speech-enabled behavior.
 */
function extractVoiceOutputDirective(payload: string): ElizaVoiceOutputDirective | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (ignoredError) {
    void ignoredError;
    // The terminal parser already rejects malformed terminal semantics. This
    // field has no meaning on a non-object payload.
    return null;
  }
  if (!isRecord(parsed) || !("voiceOutput" in parsed)) return null;
  const directive = parsed.voiceOutput;
  if (!isRecord(directive)) {
    throw new ElizaSseBridgeError(
      "Eliza agent terminal voiceOutput directive is invalid",
      "protocol_error",
      undefined,
      undefined,
      false,
    );
  }
  const policy = directive.policy;
  const spoken = directive.spoken;
  if (
    typeof policy !== "string" ||
    !VOICE_OUTPUT_POLICIES.has(policy as VoiceOutputPolicy) ||
    (spoken !== undefined &&
      (typeof spoken !== "string" || spoken.length > MAX_EXPLICIT_SPOKEN_TEXT_CHARS))
  ) {
    throw new ElizaSseBridgeError(
      "Eliza agent terminal voiceOutput directive is invalid",
      "protocol_error",
      undefined,
      undefined,
      false,
    );
  }
  return {
    policy: policy as VoiceOutputPolicy,
    ...(typeof spoken === "string" ? { spoken } : {}),
  };
}

function readBoundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
