import type {
  SpeechAudioFrame,
  SpeechEndFrame,
} from "@elizaos/cloud-sdk/native-speech-stream";

export interface ProgressiveSpeechSource {
  open(): Promise<void>;
  pull(): Promise<SpeechAudioFrame | SpeechEndFrame>;
  cancel(): Promise<void>;
  readonly renderedSpeed: number | null;
}
export interface CompletedSpeechAudio {
  audio: Blob;
  renderedSpeed: number | null;
  frames: SpeechAudioFrame[];
}

/** Attach one MP3 stream to an owned audio element. The caller controls play,
 * volume, playback rate and captions. Unsupported MSE falls back to the same
 * response's complete clip, never a second synthesis. Dispose on Stop/unmount. */
export function attachProgressiveSpeech(
  player: HTMLAudioElement,
  source: ProgressiveSpeechSource,
  options: {
    signal?: AbortSignal;
    onReady: (renderedSpeed: number | null) => void;
    onFrame?: (frame: SpeechAudioFrame) => void;
  },
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const media =
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported("audio/mpeg")
      ? new MediaSource()
      : null;
  let url: string | undefined;
  let completed = false;
  let disposed = false;
  const stopped = () => {
    if (signal.aborted) throw new DOMException("Speech stopped", "AbortError");
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    options.signal?.removeEventListener("abort", dispose);
    if (!completed) void source.cancel().catch(() => {});
    if (url) {
      if (player.src === url) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
      URL.revokeObjectURL(url);
      url = undefined;
    }
  };
  options.signal?.addEventListener("abort", dispose, { once: true });
  function event(
    target: EventTarget,
    success: string,
    begin?: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clean();
        reject(new Error("Speech media timed out"));
      }, 30000);
      const clean = () => {
        clearTimeout(timeout);
        target.removeEventListener(success, finish);
        target.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const finish = () => {
        clean();
        resolve();
      };
      const failed = () => {
        clean();
        reject(new Error("Speech media failed"));
      };
      const aborted = () => {
        clean();
        reject(new DOMException("Speech stopped", "AbortError"));
      };
      target.addEventListener(success, finish, { once: true });
      target.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      try {
        stopped();
        begin?.();
      } catch (error) {
        clean();
        reject(error);
      }
    });
  }
  const loaded = (async (): Promise<CompletedSpeechAudio> => {
    if (options.signal?.aborted) dispose();
    stopped();
    let buffer: SourceBuffer | undefined;
    if (media) {
      // Subscribe before assigning src: an already open source must not be missed.
      await event(media, "sourceopen", () => {
        url = URL.createObjectURL(media);
        player.src = url;
      });
      stopped();
      buffer = media.addSourceBuffer("audio/mpeg");
    }
    await source.open();
    stopped();
    const frames: SpeechAudioFrame[] = [];
    const parts: ArrayBuffer[] = [];
    let ready = false;
    for (;;) {
      const frame = await source.pull();
      stopped();
      if (frame.type === "done") break;
      const bytes = new Uint8Array(frame.audio).buffer;
      parts.push(bytes);
      frames.push(frame);
      if (buffer && bytes.byteLength) {
        await event(buffer, "updateend", () => buffer?.appendBuffer(bytes));
        stopped();
      }
      options.onFrame?.(frame);
      if (buffer && bytes.byteLength && !ready) {
        ready = true;
        options.onReady(source.renderedSpeed);
      }
    }
    const audio = new Blob(parts, { type: "audio/mpeg" });
    if (media) media.endOfStream();
    else {
      url = URL.createObjectURL(audio);
      player.src = url;
    }
    stopped();
    completed = true;
    if (!ready) options.onReady(source.renderedSpeed);
    return { audio, renderedSpeed: source.renderedSpeed, frames };
  })().catch((error) => {
    dispose();
    throw error;
  });
  return { loaded, dispose, progressive: media !== null };
}
