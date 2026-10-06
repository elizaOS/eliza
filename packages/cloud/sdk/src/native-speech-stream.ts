/** Browser-safe client for the native host's private JSON speech sessions.
 * The host owns credentials and voice identity. Transport failures retain the
 * original identity/cursor; callers may retry explicitly within the session TTL. */
export interface SpeechRenderingInput {
  text: string;
  speed?: number;
  previousText?: string;
  nextText?: string;
  applyTextNormalization?: "auto" | "on" | "off";
}
export interface SpeechCharacterTiming {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}
export interface SpeechAudioFrame {
  type: "audio";
  sequence: number;
  audio: Uint8Array;
  mimeType: "audio/mpeg";
  alignment: SpeechCharacterTiming | null;
  normalizedAlignment: SpeechCharacterTiming | null;
}
export interface SpeechEndFrame {
  type: "done";
  frames: number;
  audioBytes: number;
}
export type NativeSpeechRequest = (
  path: string,
  body: object,
) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid speech response");
  return value as Record<string, unknown>;
};
function timing(value: unknown): SpeechCharacterTiming | null {
  if (value === null) return null;
  const v = record(value),
    c = v.characters,
    s = v.characterStartTimesSeconds,
    e = v.characterEndTimesSeconds;
  if (
    !Array.isArray(c) ||
    !Array.isArray(s) ||
    !Array.isArray(e) ||
    c.length > 50000 ||
    c.length !== s.length ||
    c.length !== e.length
  )
    throw new Error("Invalid speech timing");
  for (let i = 0; i < c.length; i++) {
    if (
      typeof c[i] !== "string" ||
      !c[i].length ||
      c[i].length > 16 ||
      !Number.isFinite(s[i]) ||
      !Number.isFinite(e[i]) ||
      s[i] < 0 ||
      e[i] < s[i] ||
      e[i] > 3600 ||
      (i && (s[i] < s[i - 1] || e[i] < e[i - 1]))
    )
      throw new Error("Invalid speech timing");
  }
  return {
    characters: [...c],
    characterStartTimesSeconds: [...s],
    characterEndTimesSeconds: [...e],
  };
}

export function createNativeSpeechStream(
  request: NativeSpeechRequest,
  input: SpeechRenderingInput,
  {
    signal,
    requestId = globalThis.crypto.randomUUID(),
  }: { signal?: AbortSignal; requestId?: string } = {},
) {
  // Snapshot input so later preference edits cannot change an uncertain request.
  const body = { ...input, requestId };
  const expiresAt = performance.now() + 600000;
  let stopped = false,
    complete = false,
    streamId: string | undefined;
  let renderedSpeed: number | null = null,
    cursor = 0,
    audioBytes = 0,
    characters = 0;
  let opening: Promise<void> | undefined;
  let pulling: Promise<SpeechAudioFrame | SpeechEndFrame> | undefined;
  const current = () => {
    if (performance.now() >= expiresAt) {
      if (!stopped) void cancel().catch(() => {});
      throw new Error("Speech session expired");
    }
    if (stopped || signal?.aborted)
      throw new DOMException("Speech stopped", "AbortError");
  };
  const detach = () => signal?.removeEventListener("abort", abort);
  const cancel = async () => {
    stopped = true;
    detach();
    // The request identity also cancels a start whose reply has not arrived yet.
    await request("/voice/tts/stream/cancel", { requestId });
  };
  const abort = () => {
    void cancel().catch(() => {
      /* Caller already stopped delivery. */
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  async function open() {
    current();
    if (streamId) return;
    if (!opening)
      opening = (async () => {
        const value = await request("/voice/tts/stream/start", body);
        current();
        try {
          const v = record(value);
          if (
            typeof v.streamId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(v.streamId) ||
            v.state !== "open" ||
            !(
              v.renderedSpeed === null ||
              (typeof v.renderedSpeed === "number" &&
                Number.isFinite(v.renderedSpeed) &&
                v.renderedSpeed === body.speed)
            )
          )
            throw new Error("Invalid speech session");
          streamId = v.streamId;
          renderedSpeed = v.renderedSpeed;
        } catch (error) {
          void cancel().catch(() => {});
          throw error;
        }
      })().finally(() => {
        opening = undefined;
      });
    await opening;
  }
  async function pull(): Promise<SpeechAudioFrame | SpeechEndFrame> {
    current();
    if (complete) throw new Error("Speech stream is complete");
    if (pulling) return pulling;
    pulling = (async (): Promise<SpeechAudioFrame | SpeechEndFrame> => {
      await open();
      current();
      const value = await request("/voice/tts/stream/pull", {
        streamId,
        cursor,
      });
      current();
      try {
        const v = record(value),
          f = record(v.frame);
        if (v.cursor !== cursor) throw new Error("Invalid speech cursor");
        if (f.type === "done") {
          if (!audioBytes || f.frames !== cursor || f.audioBytes !== audioBytes)
            throw new Error("Invalid speech completion");
          complete = true;
          detach();
          return { type: "done", frames: cursor, audioBytes };
        }
        if (
          f.type !== "audio" ||
          f.sequence !== cursor ||
          cursor >= 2048 ||
          f.mimeType !== "audio/mpeg" ||
          typeof f.audioBase64 !== "string" ||
          f.audioBase64.length > 11184812 ||
          f.audioBase64.length % 4 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(f.audioBase64)
        )
          throw new Error("Invalid speech audio");
        const raw = atob(f.audioBase64);
        if (btoa(raw) !== f.audioBase64)
          throw new Error("Invalid speech encoding");
        const audio = Uint8Array.from(raw, (c) => c.charCodeAt(0));
        const alignment = timing(f.alignment),
          normalizedAlignment = timing(f.normalizedAlignment);
        const size = audioBytes + audio.byteLength;
        const count =
          characters +
          (alignment?.characters.length ?? 0) +
          (normalizedAlignment?.characters.length ?? 0);
        if (size > 8 * 1024 * 1024 || count > 50000)
          throw new Error("Speech stream is too large");
        audioBytes = size;
        characters = count;
        cursor++;
        return {
          type: "audio",
          sequence: f.sequence as number,
          audio,
          mimeType: "audio/mpeg",
          alignment,
          normalizedAlignment,
        };
      } catch (error) {
        void cancel().catch(() => {});
        throw error;
      }
    })().finally(() => {
      pulling = undefined;
    });
    return pulling;
  }
  return {
    open,
    pull,
    cancel,
    get renderedSpeed() {
      return renderedSpeed;
    },
  };
}
