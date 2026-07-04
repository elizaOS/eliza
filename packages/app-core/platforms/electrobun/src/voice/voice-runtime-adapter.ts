/** Implements Electrobun desktop voice runtime adapter ts behavior for app-core shell integration. */
import type { JsonValue } from "@elizaos/plugin-remote-manifest";
import { VoiceError } from "./errors";
import type {
  VoiceAsrFinalEvent,
  VoiceAsrPartialEvent,
  VoiceComponentSnapshot,
  VoiceLiveStartParams,
  VoicePlayAudioParams,
  VoicePlaybackEvent,
  VoiceRuntimeErrorEvent,
  VoiceRuntimeHandoffParams,
  VoiceRuntimeHandoffResult,
  VoiceRuntimeStatus,
  VoiceRuntimeStreamHandlers,
  VoiceSynthesisResult,
  VoiceSynthesizeSpeechParams,
  VoiceTestMode,
  VoiceTranscribeAudioParams,
  VoiceTtsChunkEvent,
  VoiceTurnEvent,
  VoiceVadEvent,
} from "./types";
import { discoverStaticVoiceComponents } from "./voice-pipeline";

type Listener<T> = (event: T) => void;

export interface VoiceRuntimeAdapter {
  status(): Promise<VoiceRuntimeStatus>;
  components(): Promise<VoiceComponentSnapshot[]>;
  startListening(params: VoiceLiveStartParams): Promise<VoiceRuntimeStatus>;
  stopListening(params?: { reason?: string }): Promise<VoiceRuntimeStatus>;
  interrupt(params?: { reason?: string }): Promise<VoiceRuntimeStatus>;
  onVad(handler: Listener<VoiceVadEvent>): () => void;
  onTurn(handler: Listener<VoiceTurnEvent>): () => void;
  onAsrPartial(handler: Listener<VoiceAsrPartialEvent>): () => void;
  onAsrFinal(handler: Listener<VoiceAsrFinalEvent>): () => void;
  onTtsChunk?(handler: Listener<VoiceTtsChunkEvent>): () => void;
  onPlayback(handler: Listener<VoicePlaybackEvent>): () => void;
  onError(handler: Listener<VoiceRuntimeErrorEvent>): () => void;
  transcribeAudio?(
    params: VoiceTranscribeAudioParams,
  ): Promise<VoiceAsrFinalEvent>;
  synthesizeSpeech?(
    params: VoiceSynthesizeSpeechParams,
  ): Promise<VoiceSynthesisResult>;
  playAudio?(params: VoicePlayAudioParams): Promise<VoicePlaybackEvent>;
  sendRuntimeMessage?(
    params: VoiceRuntimeHandoffParams,
  ): Promise<VoiceRuntimeHandoffResult>;
  sendRuntimeMessageStream?(
    params: VoiceRuntimeHandoffParams,
    handlers: VoiceRuntimeStreamHandlers,
  ): Promise<VoiceRuntimeHandoffResult>;
}

export type VoiceRuntimeAdapterOptions = {
  apiBase?: string;
  token?: string | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};

type HttpMethod = "GET" | "POST";

type JsonRecord = Record<string, JsonValue>;

const EMPTY_STATUS: Omit<VoiceRuntimeStatus, "mode"> = {
  listening: false,
  asrPartialSupport: false,
  ttsStreamingSupport: false,
  playbackSupport: false,
  playbackAckSupport: false,
  runtimeDraftSupport: false,
  vadSupport: false,
  turnSupport: false,
};

function enabled(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  const value = env[key]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseJsonValue(text: string): JsonValue {
  if (!text.trim()) return null;
  return JSON.parse(text) as JsonValue;
}

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: JsonValue, field: string): string | null {
  if (!isRecord(value)) return null;
  const found = value[field];
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function installationsToComponents(value: JsonValue): VoiceComponentSnapshot[] {
  if (!isRecord(value) || !Array.isArray(value.installations)) return [];
  const components: VoiceComponentSnapshot[] = [];
  for (const item of value.installations) {
    if (!isRecord(item)) continue;
    const id = stringField(item, "id");
    if (!id) continue;
    const installedVersion = stringField(item, "installedVersion");
    const lastError = stringField(item, "lastError");
    components.push({
      id,
      name: id,
      role: roleForVoiceModel(id),
      provider: providerForVoiceModel(id),
      status: installedVersion ? "available" : "missing",
      modelId: installedVersion ? `${id}@${installedVersion}` : undefined,
      error: lastError ?? undefined,
      raw: item,
    });
  }
  return components;
}

function roleForVoiceModel(id: string): VoiceComponentSnapshot["role"] {
  if (id === "vad") return "vad";
  if (id === "asr") return "asr";
  if (id === "kokoro") return "tts";
  if (id.includes("turn")) return "turn-detection";
  if (id.includes("emotion")) return "emotion";
  return "voice";
}

function providerForVoiceModel(id: string): string {
  if (id === "kokoro") return "kokoro";
  if (id === "asr" || id === "vad") return "eliza-1";
  return "local-inference";
}

function mergeComponents(
  staticComponents: VoiceComponentSnapshot[],
  runtimeComponents: VoiceComponentSnapshot[],
): VoiceComponentSnapshot[] {
  const byId = new Map<string, VoiceComponentSnapshot>();
  for (const component of staticComponents) byId.set(component.id, component);
  for (const component of runtimeComponents) {
    const current = byId.get(component.id);
    byId.set(component.id, current ? { ...current, ...component } : component);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export class RuntimeHttpVoiceAdapter implements VoiceRuntimeAdapter {
  private readonly apiBase: string;
  private readonly token: string | null;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: typeof fetch;
  private mode: VoiceTestMode = "mock";
  private listening = false;
  private readonly vadHandlers = new Set<Listener<VoiceVadEvent>>();
  private readonly turnHandlers = new Set<Listener<VoiceTurnEvent>>();
  private readonly asrPartialHandlers = new Set<
    Listener<VoiceAsrPartialEvent>
  >();
  private readonly asrFinalHandlers = new Set<Listener<VoiceAsrFinalEvent>>();
  private readonly playbackHandlers = new Set<Listener<VoicePlaybackEvent>>();
  private readonly errorHandlers = new Set<Listener<VoiceRuntimeErrorEvent>>();

  constructor(options: VoiceRuntimeAdapterOptions = {}) {
    this.env = options.env ?? process.env;
    this.apiBase =
      options.apiBase ??
      this.env.ELIZA_RUNTIME_API_BASE ??
      this.env.ELIZA_DESKTOP_API_BASE ??
      "http://127.0.0.1:31337";
    this.token =
      options.token ??
      this.env.ELIZA_RUNTIME_API_TOKEN ??
      this.env.ELIZA_API_TOKEN ??
      null;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async status(): Promise<VoiceRuntimeStatus> {
    return {
      mode: this.mode,
      ...EMPTY_STATUS,
      listening: this.listening,
      asrPartialSupport: false,
      ttsStreamingSupport: false,
      playbackSupport: false,
      vadSupport: this.liveAudioEnabled(),
      turnSupport: this.liveAudioEnabled(),
    };
  }

  async components(): Promise<VoiceComponentSnapshot[]> {
    if (!this.liveRuntimeEnabled()) return discoverStaticVoiceComponents();
    const voiceModels = await this.jsonRequest(
      "GET",
      "/api/local-inference/voice-models",
    );
    return mergeComponents(
      discoverStaticVoiceComponents(),
      installationsToComponents(voiceModels),
    );
  }

  async startListening(
    params: VoiceLiveStartParams,
  ): Promise<VoiceRuntimeStatus> {
    this.mode = params.mode;
    if (params.mode === "live-audio" && !this.liveAudioEnabled()) {
      throw new VoiceError(
        "VOICE_AUDIO_INPUT_UNAVAILABLE",
        "Live audio is disabled. Set ELIZA_VOICE_LIVE_AUDIO=1 to enable it.",
      );
    }
    if (params.mode === "local-runtime" && !this.liveRuntimeEnabled()) {
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        "Local runtime voice mode is disabled. Set ELIZA_VOICE_LIVE_RUNTIME=1 to enable it.",
      );
    }
    this.listening = true;
    this.emit(this.turnHandlers, {
      status: "started",
      timestamp: new Date().toISOString(),
      metadata: { mode: params.mode },
    });
    return this.status();
  }

  async stopListening(): Promise<VoiceRuntimeStatus> {
    this.listening = false;
    this.emit(this.turnHandlers, {
      status: "ended",
      timestamp: new Date().toISOString(),
    });
    return this.status();
  }

  async interrupt(
    params: { reason?: string } = {},
  ): Promise<VoiceRuntimeStatus> {
    this.listening = false;
    this.emit(this.turnHandlers, {
      status: "cancelled",
      timestamp: new Date().toISOString(),
      reason: params.reason,
    });
    return this.status();
  }

  onVad(handler: Listener<VoiceVadEvent>): () => void {
    return this.register(this.vadHandlers, handler);
  }

  onTurn(handler: Listener<VoiceTurnEvent>): () => void {
    return this.register(this.turnHandlers, handler);
  }

  onAsrPartial(handler: Listener<VoiceAsrPartialEvent>): () => void {
    return this.register(this.asrPartialHandlers, handler);
  }

  onAsrFinal(handler: Listener<VoiceAsrFinalEvent>): () => void {
    return this.register(this.asrFinalHandlers, handler);
  }

  onPlayback(handler: Listener<VoicePlaybackEvent>): () => void {
    return this.register(this.playbackHandlers, handler);
  }

  onError(handler: Listener<VoiceRuntimeErrorEvent>): () => void {
    return this.register(this.errorHandlers, handler);
  }

  async transcribeAudio(
    params: VoiceTranscribeAudioParams,
  ): Promise<VoiceAsrFinalEvent> {
    if (!this.liveAsrEnabled()) {
      throw new VoiceError(
        "VOICE_ASR_UNAVAILABLE",
        "Live ASR is disabled. Set ELIZA_VOICE_LIVE_ASR=1 to enable it.",
      );
    }
    const result = await this.jsonRequest("POST", "/api/asr/local-inference", {
      audioBase64: params.audioBase64,
    });
    const text = stringField(result, "text");
    if (!text) {
      throw new VoiceError(
        "VOICE_ASR_UNAVAILABLE",
        "Local ASR returned no transcript text.",
        result,
      );
    }
    const event: VoiceAsrFinalEvent = {
      text,
      timestamp: new Date().toISOString(),
      metadata: params.metadata,
    };
    this.emit(this.asrFinalHandlers, event);
    return event;
  }

  async synthesizeSpeech(
    params: VoiceSynthesizeSpeechParams,
  ): Promise<VoiceSynthesisResult> {
    if (!this.liveTtsEnabled()) {
      throw new VoiceError(
        "VOICE_TTS_UNAVAILABLE",
        "Live TTS is disabled. Set ELIZA_VOICE_LIVE_TTS=1 to enable it.",
      );
    }
    const body: JsonRecord = { text: params.text };
    if (params.voiceId) body.voiceId = params.voiceId;
    const response = await this.binaryRequest(
      "POST",
      "/api/tts/local-inference",
      body,
    );
    const audioBase64 = Buffer.from(response.bytes).toString("base64");
    return {
      audioBase64,
      mimeType: response.mimeType,
      byteLength: response.bytes.byteLength,
      provider: "local-inference",
      voiceId: params.voiceId,
    };
  }

  async playAudio(): Promise<VoicePlaybackEvent> {
    throw new VoiceError(
      "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
      "Host playback for local TTS bytes is not wired yet; renderer playback must acknowledge first-audio before playback can be marked.",
    );
  }

  /**
   * Build the message body for a voice handoff: a `VOICE_DM` carrying the turn
   * signal / speaker metadata so the server's voice gate (`core.voice_turn_signal`)
   * runs — matching the web `useShellController`. Previously this sent a plain
   * `{ text }` DM, so desktop voice silently bypassed the entire voice gate (#8786).
   */
  private voiceMessageBody(params: VoiceRuntimeHandoffParams): JsonRecord {
    const metadata: JsonRecord = {
      voiceSource: "electrobun",
      ...(params.metadata ?? {}),
    };
    return {
      text: params.text,
      channelType: "VOICE_DM",
      metadata,
    };
  }

  private async createVoiceConversation(): Promise<string> {
    const conversation = await this.jsonRequest("POST", "/api/conversations", {
      title: "Voice",
    });
    const conversationId =
      readId(conversation, ["conversationId", "id"]) ??
      readNestedId(conversation, "conversation", ["id", "conversationId"]);
    if (!conversationId) {
      throw new VoiceError(
        "VOICE_REQUEST_FAILED",
        "Runtime conversation creation returned no id.",
        conversation,
      );
    }
    return conversationId;
  }

  async sendRuntimeMessage(
    params: VoiceRuntimeHandoffParams,
  ): Promise<VoiceRuntimeHandoffResult> {
    if (!this.liveRuntimeEnabled()) {
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        "Runtime handoff is disabled. Set ELIZA_VOICE_LIVE_RUNTIME=1 to enable it.",
      );
    }
    const conversationId = await this.createVoiceConversation();
    const message = await this.jsonRequest(
      "POST",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
      this.voiceMessageBody(params),
    );
    const responseText =
      stringField(message, "text") ??
      stringField(message, "message") ??
      stringField(message, "reply") ??
      stringField(message, "response");
    return {
      conversationId,
      messageId: readId(message, ["messageId", "id"]) ?? undefined,
      firstTokenText: responseText ? responseText.slice(0, 32) : undefined,
      responseText: responseText ?? undefined,
      raw: message,
    };
  }

  /**
   * Streaming runtime handoff: consumes the `/messages/stream` SSE endpoint and
   * fires `onTextDelta` per token as the reply streams, so the caller can begin
   * phrase-by-phrase synthesis before the whole reply is generated (vs.
   * `sendRuntimeMessage`, which awaits the full JSON body). Falls back to the
   * buffered path at the call site if this throws.
   */
  async sendRuntimeMessageStream(
    params: VoiceRuntimeHandoffParams,
    handlers: VoiceRuntimeStreamHandlers,
  ): Promise<VoiceRuntimeHandoffResult> {
    if (!this.liveRuntimeEnabled()) {
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        "Runtime handoff is disabled. Set ELIZA_VOICE_LIVE_RUNTIME=1 to enable it.",
      );
    }
    const conversationId = await this.createVoiceConversation();
    const response = await this.streamRequest(
      "POST",
      `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      this.voiceMessageBody(params),
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        `Voice runtime stream route failed: ${response.status}`,
        { status: response.status, body: text },
      );
    }

    let fullText = "";
    let agentName: string | undefined;
    let messageId: string | undefined;
    for await (const frame of parseVoiceSseStream(response.body)) {
      const type = stringField(frame, "type");
      if (type === "token") {
        // Raw (un-trimmed) delta — inter-token whitespace is significant.
        const delta = rawStringField(frame, "text") ?? "";
        fullText = rawStringField(frame, "fullText") ?? fullText + delta;
        if (delta) handlers.onTextDelta(delta, fullText);
      } else if (type === "done") {
        fullText = rawStringField(frame, "fullText") ?? fullText;
        agentName = stringField(frame, "agentName") ?? agentName;
        messageId = readId(frame, ["messageId", "id"]) ?? messageId;
        handlers.onDone?.({
          fullText,
          ...(agentName ? { agentName } : {}),
        });
        break;
      } else if (type === "error") {
        const message =
          stringField(frame, "message") ?? "Voice runtime stream error";
        throw new VoiceError(
          "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
          message,
          frame,
        );
      }
    }

    return {
      conversationId,
      ...(messageId ? { messageId } : {}),
      firstTokenText: fullText ? fullText.slice(0, 32) : undefined,
      responseText: fullText || undefined,
    };
  }

  private async jsonRequest(
    method: HttpMethod,
    path: string,
    body?: JsonRecord,
  ): Promise<JsonValue> {
    const response = await this.request(method, path, body);
    const text = await response.text();
    const parsed = parseJsonValue(text);
    if (!response.ok) {
      throw new VoiceError(
        "VOICE_LOCAL_INFERENCE_UNAVAILABLE",
        `Voice runtime route failed: ${path}`,
        { status: response.status, payload: parsed },
      );
    }
    return parsed;
  }

  private async binaryRequest(
    method: HttpMethod,
    path: string,
    body: JsonRecord,
  ): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const response = await this.request(method, path, body);
    if (!response.ok) {
      const text = await response.text();
      throw new VoiceError(
        "VOICE_TTS_UNAVAILABLE",
        `Voice runtime route failed: ${path}`,
        { status: response.status, body: text },
      );
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType:
        response.headers.get("content-type")?.split(";")[0]?.trim() ??
        "application/octet-stream",
    };
  }

  private async request(
    method: HttpMethod,
    path: string,
    body?: JsonRecord,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json, audio/*",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    if (body) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await this.fetchImpl(`${stripSlash(this.apiBase)}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Like {@link request} but for SSE: requests `text/event-stream` and uses a
   * generous total timeout (the 10s `request` timeout would abort a long
   * streamed generation mid-reply). `ELIZA_VOICE_STREAM_TIMEOUT_MS` overrides.
   */
  private async streamRequest(
    method: HttpMethod,
    path: string,
    body: JsonRecord,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
    const controller = new AbortController();
    const timeoutMs =
      Number(this.env.ELIZA_VOICE_STREAM_TIMEOUT_MS) > 0
        ? Number(this.env.ELIZA_VOICE_STREAM_TIMEOUT_MS)
        : 120_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${stripSlash(this.apiBase)}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private register<T>(set: Set<Listener<T>>, handler: Listener<T>): () => void {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private emit<T>(set: Set<Listener<T>>, event: T): void {
    for (const handler of set) handler(event);
  }

  private liveRuntimeEnabled(): boolean {
    return (
      enabled(this.env, "ELIZA_VOICE_LIVE_RUNTIME") ||
      enabled(this.env, "ELIZA_VOICE_LIVE_AUDIO")
    );
  }

  private liveAudioEnabled(): boolean {
    return enabled(this.env, "ELIZA_VOICE_LIVE_AUDIO");
  }

  private liveAsrEnabled(): boolean {
    return (
      enabled(this.env, "ELIZA_VOICE_LIVE_ASR") ||
      enabled(this.env, "ELIZA_VOICE_LIVE_AUDIO")
    );
  }

  private liveTtsEnabled(): boolean {
    return (
      enabled(this.env, "ELIZA_VOICE_LIVE_TTS") ||
      enabled(this.env, "ELIZA_VOICE_LIVE_AUDIO")
    );
  }
}

function readId(value: JsonValue, fields: readonly string[]): string | null {
  if (!isRecord(value)) return null;
  for (const field of fields) {
    const found = stringField(value, field);
    if (found) return found;
  }
  return null;
}

function readNestedId(
  value: JsonValue,
  field: string,
  idFields: readonly string[],
): string | null {
  if (!isRecord(value)) return null;
  const nested = value[field];
  return readId(nested, idFields);
}

/** Read a string field WITHOUT trimming (token deltas carry significant
 *  whitespace, unlike {@link stringField} which trims). */
function rawStringField(value: JsonValue, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const found = value[field];
  return typeof found === "string" ? found : undefined;
}

/**
 * Parse an SSE byte stream into each `data:` line's decoded JSON object.
 * Buffers across read() boundaries; ignores comment/blank/non-JSON lines and
 * the terminal `[DONE]`. The voice runtime wire format is
 * `data: {"type":"token","text":<delta>,"fullText":<acc>}` … then
 * `data: {"type":"done","fullText":<final>,"agentName":…}`.
 */
export async function* parseVoiceSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonRecord> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (line: string): JsonRecord | null => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return null;
    try {
      const parsed = JSON.parse(payload) as JsonValue;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const frame = handle(line);
        if (frame) yield frame;
        nl = buffer.indexOf("\n");
      }
    }
    const tail = handle(buffer);
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader already released by an upstream cancel.
    }
  }
}
