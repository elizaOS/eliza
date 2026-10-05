export type RecordingPhase =
  | "idle"
  | "connecting"
  | "recording"
  | "transcribing";
export interface RecordedTranscriptionState {
  phase: RecordingPhase;
  error: unknown | null;
}
export class RecordedTranscriptionError extends Error {
  readonly code:
    | "unavailable"
    | "recording"
    | "too-large"
    | "empty-audio"
    | "empty-transcript";
  constructor(code: RecordedTranscriptionError["code"]) {
    super(code);
    this.code = code;
  }
}
export interface RecordedTranscriptionOptions {
  authorize: () => Promise<void>;
  encode: (blob: Blob) => Promise<string>;
  transcribe: (audioBase64: string, mimeType: string) => Promise<unknown>;
  preview: (
    stream: MediaStream,
    receive: (blob: Blob) => Promise<void>,
    active: () => boolean,
  ) => Promise<(() => void) | undefined>;
  changed: (state: RecordedTranscriptionState) => void;
  maximumBytes: number;
  maximumMs: number;
  timesliceMs: number;
  constraints: MediaStreamConstraints;
  mimeTypes: readonly string[];
  environment?: {
    acquire: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    recorder: (
      stream: MediaStream,
      mimeTypes: readonly string[],
    ) => MediaRecorder;
  };
}
interface Recording {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  timer?: ReturnType<typeof setTimeout>;
  endpoint?: () => void;
  live?: () => void;
  chunks: Blob[];
  bytes: number;
  previews: boolean;
  ended: boolean;
  transcript: (text: string, final: boolean) => void;
}
function safely(close: () => void): void {
  try {
    close();
  } catch {
    /* Continue releasing the other owned microphone resources. */
  }
}
/** Records a bounded utterance; finalization produces review text, never sends a message. */
export class RecordedTranscriptionController {
  private options: RecordedTranscriptionOptions;
  private current: Recording | null = null;
  private phase: RecordingPhase = "idle";
  constructor(options: RecordedTranscriptionOptions) {
    for (const n of [
      options.maximumBytes,
      options.maximumMs,
      options.timesliceMs,
    ])
      if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647)
        throw new Error("Invalid recording bound");
    this.options = { ...options, mimeTypes: [...options.mimeTypes] };
  }
  get pending(): boolean {
    return this.current !== null;
  }
  get recording(): boolean {
    return this.phase === "recording";
  }
  private publish(phase: RecordingPhase, error: unknown | null = null): void {
    this.phase = phase;
    this.options.changed({ phase, error });
  }
  private release(s: Recording): void {
    s.previews = false;
    clearTimeout(s.timer);
    const live = s.live,
      endpoint = s.endpoint,
      recorder = s.recorder,
      stream = s.stream;
    s.live = undefined;
    s.endpoint = undefined;
    s.recorder = undefined;
    s.stream = undefined;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
    }
    if (live) safely(live);
    if (endpoint) safely(endpoint);
    if (recorder && recorder.state !== "inactive")
      safely(() => recorder.stop());
    if (stream)
      for (const track of stream.getTracks()) safely(() => track.stop());
  }
  cancel(): void {
    const s = this.current;
    this.current = null;
    if (s) {
      this.release(s);
      s.chunks.length = 0;
    }
    this.publish("idle");
  }
  finish(): void {
    const s = this.current;
    if (s?.recorder?.state === "recording") {
      s.previews = false;
      try {
        s.recorder.stop();
      } catch (error) {
        this.fail(s, error);
      }
    }
  }
  private fail(s: Recording, error: unknown): void {
    if (this.current !== s) return;
    this.current = null;
    this.release(s);
    s.chunks.length = 0;
    this.publish("idle", error);
  }
  async start(
    transcript: (text: string, final: boolean) => void,
    observePause: (stream: MediaStream, finish: () => void) => () => void,
  ): Promise<void> {
    if (this.current) return;
    const s: Recording = {
      chunks: [],
      bytes: 0,
      previews: true,
      ended: false,
      transcript,
    };
    this.current = s;
    this.publish("connecting");
    const active = () => this.current === s;
    const previews = () => active() && s.previews;
    try {
      if (!active()) return;
      await this.options.authorize();
      if (!active()) return;
      const environment = this.options.environment ?? {
        acquire: async (constraints: MediaStreamConstraints) => {
          if (
            !navigator.mediaDevices?.getUserMedia ||
            typeof MediaRecorder === "undefined"
          )
            throw new RecordedTranscriptionError("unavailable");
          return navigator.mediaDevices.getUserMedia(constraints);
        },
        recorder: (stream: MediaStream, mimeTypes: readonly string[]) => {
          const mimeType = mimeTypes.find((type) =>
            MediaRecorder.isTypeSupported(type),
          );
          return new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        },
      };
      const stream = await environment.acquire(this.options.constraints);
      if (!active()) {
        for (const track of stream.getTracks()) safely(() => track.stop());
        return;
      }
      s.stream = stream;
      const recorder = environment.recorder(stream, this.options.mimeTypes);
      s.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!active() || s.ended) return;
        s.bytes += event.data.size;
        s.chunks.push(event.data);
        if (s.bytes > this.options.maximumBytes) this.finish();
      };
      recorder.onerror = () =>
        this.fail(s, new RecordedTranscriptionError("recording"));
      recorder.onstop = () => {
        if (!active() || s.ended) return;
        s.ended = true;
        const mimeType = recorder.mimeType;
        this.release(s);
        this.publish("transcribing");
        void this.finalize(s, mimeType);
      };
      recorder.start(this.options.timesliceMs);
      if (!active() || s.ended) return;
      s.timer = setTimeout(() => {
        if (active()) this.finish();
      }, this.options.maximumMs);
      const endpoint = observePause(stream, () => {
        if (active()) this.finish();
      });
      if (!active() || s.ended) {
        safely(endpoint);
        return;
      }
      s.endpoint = endpoint;
      this.publish("recording");
      if (!previews()) return;
      const live = await this.options.preview(
        stream,
        async (blob) => {
          if (!previews()) return;
          const encoded = await this.options.encode(blob);
          if (!previews()) return;
          const result = await this.options.transcribe(
            encoded,
            blob.type || "audio/wav",
          );
          const text = (result as { text?: unknown } | null)?.text;
          if (previews() && typeof text === "string" && text.trim())
            s.transcript(text, false);
        },
        previews,
      );
      if (!previews()) {
        if (live) safely(live);
      } else s.live = live;
    } catch (error) {
      if (!s.ended) this.fail(s, error);
    }
  }
  private async finalize(s: Recording, mimeType: string): Promise<void> {
    try {
      if (this.current !== s) return;
      if (s.bytes > this.options.maximumBytes)
        throw new RecordedTranscriptionError("too-large");
      if (!s.bytes) throw new RecordedTranscriptionError("empty-audio");
      const blob = new Blob(s.chunks, { type: mimeType });
      s.chunks.length = 0;
      const encoded = await this.options.encode(blob);
      if (this.current !== s) return;
      const result = await this.options.transcribe(encoded, mimeType);
      if (this.current !== s) return;
      const text = (result as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || !text.trim())
        throw new RecordedTranscriptionError("empty-transcript");
      s.transcript(text, true);
      if (this.current === s) {
        this.current = null;
        this.publish("idle");
      }
    } catch (error) {
      this.fail(s, error);
    } finally {
      s.chunks.length = 0;
    }
  }
}
