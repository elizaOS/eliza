/** A microphone stream the host admitted, with its own release. */
export type AdmittedMicrophone = { stream: MediaStream; close(): void };
/** Host inputs: microphone admission policy, optional level meter and foreground state. */
export type BrowserAudioCaptureHost = {
  /** Open the microphone after the host's own policy checks. onLost revokes it later. */
  openMicrophone(onLost: () => void): Promise<AdmittedMicrophone>;
  /** Called when a recording ends without a usable clip, or stops by its deadline. */
  stopped(event: { recordingId: string; durationMs: number | null }): void;
  /** Optional meter over the admitted stream; returns its release. */
  meter?(recordingId: string, stream: MediaStream): () => void;
  /** True while the page is hidden; recording never starts or continues in the background. */
  hidden?(): boolean;
  /** Longest allowed recording. Default 59 seconds. */
  maxDurationMs?: number;
  /** Largest recording kept in memory. Default 16 MB. */
  maxBytes?: number;
  /** Most recent clips retained for transcription or saving. Default 4. */
  retainedClips?: number;
};
type Clip = { recordingId: string; durationMs: number };
type Session = {
  id: string;
  generation: number;
  stream: MediaStream;
  recorder: MediaRecorder;
  started: number;
  stopped?: number;
  done: Promise<Blob>;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  releaseMeter?: () => void;
  finishing?: Promise<Clip>;
  settled: boolean;
  failed?: boolean;
};
const cancelled = () => new DOMException("Recording cancelled", "AbortError");

/**
 * MediaRecorder sessions that each own their stream, deadline timer and stop promise, so a
 * later session can never be finished, saved or reported by an earlier one. Clips stay in
 * memory until retired; nothing is uploaded or persisted here.
 */
export class BrowserAudioCapture {
  private microphone?: AdmittedMicrophone;
  private generation = 0;
  private current?: Session;
  private clips = new Map<string, { blob: Blob; durationMs: number }>();
  constructor(private host: BrowserAudioCaptureHost) {}
  get(id: string) {
    return this.clips.get(id);
  }
  clear() {
    this.cancel();
    this.clips.clear();
  }
  private hidden() {
    return (
      this.host.hidden?.() ??
      (typeof document !== "undefined" && document.hidden)
    );
  }
  cancel() {
    const microphone = this.microphone;
    this.microphone = undefined;
    ++this.generation;
    const session = this.current;
    this.current = undefined;
    microphone?.close();
    if (!session) return;
    session.releaseMeter?.();
    clearTimeout(session.timer);
    session.settled = true;
    session.reject(cancelled());
    try {
      if (session.recorder.state !== "inactive") session.recorder.stop();
    } catch {
      /* Already stopped. */
    }
    session.stream.getTracks().forEach((track) => {
      track.stop();
    });
  }
  async start(input: { maxDurationMs?: number } = {}) {
    this.cancel();
    const generation = this.generation;
    const limit = this.host.maxDurationMs ?? 59000,
      duration = input.maxDurationMs ?? limit,
      maxBytes = this.host.maxBytes ?? 16_000_000;
    if (!Number.isFinite(duration) || duration < 1 || duration > limit)
      throw Error(
        `Recording duration must be between 1 and ${limit} milliseconds.`,
      );
    if (this.hidden()) throw cancelled();
    let released = false;
    const admitted = await this.host.openMicrophone(() => {
      if (released || generation !== this.generation) return;
      const id = this.current?.id;
      this.cancel();
      if (id) this.host.stopped({ recordingId: id, durationMs: null });
    });
    const microphone = {
      stream: admitted.stream,
      close: () => {
        if (released) return;
        released = true;
        admitted.close();
      },
    };
    const { stream } = microphone;
    if (generation !== this.generation || this.hidden()) {
      microphone.close();
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      throw cancelled();
    }
    this.microphone = microphone;
    try {
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(
          stream,
          mimeType ? { mimeType } : undefined,
        ),
        id = crypto.randomUUID();
      let resolve!: (blob: Blob) => void, reject!: (error: Error) => void;
      const done = new Promise<Blob>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void done.catch(() => {});
      const session: Session = {
        id,
        generation,
        stream,
        recorder,
        started: Date.now(),
        done,
        reject,
        settled: false,
      };
      this.current = session;
      const chunks: Blob[] = [];
      let bytes = 0;
      const finish = (error?: Error) => {
        if (session.settled) return;
        session.settled = true;
        session.releaseMeter?.();
        clearTimeout(session.timer);
        microphone.close();
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        if (!error && !bytes) error = Error("Recording contains no audio.");
        if (error) {
          session.failed = true;
          reject(error);
          if (this.current === session && generation === this.generation)
            this.host.stopped({ recordingId: id, durationMs: null });
        } else resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.ondataavailable = (event) => {
        if (session.settled) return;
        bytes += event.data.size;
        if (bytes > maxBytes) {
          finish(Error("Recording exceeded the local size limit."));
          try {
            recorder.stop();
          } catch {
            /* Already stopped. */
          }
          return;
        }
        chunks.push(event.data);
      };
      recorder.onerror = () => {
        finish(Error("Recording interrupted."));
        try {
          recorder.stop();
        } catch {
          /* Already stopped. */
        }
      };
      const automatic = () => {
        if (this.current !== session) return;
        void this.stop()
          .then((clip) => {
            if (generation === this.generation) this.host.stopped(clip);
          })
          .catch(() => {
            if (generation === this.generation)
              this.host.stopped({ recordingId: id, durationMs: null });
          });
      };
      recorder.onstop = () => {
        finish();
        if (session.stopped === undefined && !session.failed) automatic();
      };
      recorder.start(250);
      session.releaseMeter = this.host.meter?.(id, stream);
      session.timer = setTimeout(automatic, duration);
      return { recordingId: id, maxDurationMs: duration };
    } catch (error) {
      microphone.close();
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      if (this.current?.generation === generation) {
        this.current.releaseMeter?.();
        this.current.reject(
          error instanceof Error ? error : Error("Recording failed."),
        );
        this.current = undefined;
      }
      throw error;
    }
  }
  async stop(): Promise<Clip> {
    const session = this.current;
    if (!session) throw Error("Start a recording first.");
    if (session.finishing) return session.finishing;
    const stopped = Date.now();
    session.stopped = stopped;
    clearTimeout(session.timer);
    session.finishing = (async () => {
      try {
        if (session.recorder.state !== "inactive") session.recorder.stop();
        const deadline = setTimeout(
          () => session.reject(Error("Recording did not finish. Try again.")),
          5000,
        );
        let blob: Blob;
        try {
          blob = await session.done;
        } finally {
          clearTimeout(deadline);
        }
        if (this.current !== session || session.generation !== this.generation)
          throw cancelled();
        const durationMs = Math.max(0, stopped - session.started);
        this.clips.set(session.id, { blob, durationMs });
        while (this.clips.size > (this.host.retainedClips ?? 4)) {
          const oldest = this.clips.keys().next();
          if (oldest.done) break;
          this.clips.delete(oldest.value);
        }
        return { recordingId: session.id, durationMs };
      } finally {
        session.releaseMeter?.();
        session.stream.getTracks().forEach((track) => {
          track.stop();
        });
        if (this.current === session) {
          this.microphone?.close();
          this.current = undefined;
        }
      }
    })();
    return session.finishing;
  }
}
