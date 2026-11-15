/** Native Cloud speech transport. The host supplies its credential-owning bridge;
 * only text, levels, timing, and lifecycle events enter the renderer. No platform imports. */
import type {
  AssistantCapture,
  AssistantListenHandlers,
} from "./voice-assistant-session.js";

export interface CloudSpeechListenerHandle {
  remove(): Promise<void>;
}
export interface CloudStreamEvent {
  sessionId?: unknown;
  type?: unknown;
  text?: unknown;
  final?: unknown;
  peak?: unknown;
  utteranceId?: unknown;
  code?: unknown;
  data?: unknown;
}
export interface CloudStreamPort {
  startCloudSpeech(input: {
    sessionId: string;
    environment: string;
    credentialId: string;
  }): Promise<{
    sessionId: string;
    sampleRate: number;
    echoCancelled: boolean;
  }>;
  stopCloudSpeech(input: { sessionId: string }): Promise<unknown>;
  setCloudSpeechMuted(input: {
    sessionId: string;
    muted: boolean;
  }): Promise<unknown>;
  speakCloudSpeech(input: {
    sessionId: string;
    utteranceId: string;
    text: string;
  }): Promise<unknown>;
  cancelCloudSpeech(input: {
    sessionId: string;
    utteranceId: string;
  }): Promise<unknown>;
  addListener(
    event: "cloudSpeechEvent",
    callback: (event: CloudStreamEvent) => void,
  ): Promise<CloudSpeechListenerHandle>;
}
const cancelled = () => new DOMException("Cloud speech stopped", "AbortError");

/** The native socket owns credentials and PCM. Only text, levels and lifecycle events enter the renderer. */
export function createCloudStreamingSpeech(
  input: {
    environment: string;
    credentialId: string;
    assertCurrent(): void;
    onInterim?(text: string): void;
  },
  port: CloudStreamPort,
) {
  const sessionId = crypto.randomUUID();
  let handle: CloudSpeechListenerHandle | undefined,
    opening: Promise<void> | undefined,
    stopping: Promise<void> | undefined;
  let opened = false,
    retired = false,
    echoCancelled = false,
    speechActive = false;
  let captureGeneration = 0,
    speechGeneration: number | undefined;
  // `listening` gets the open capture's speech; `lifecycle`, the last listen's handlers, keeps hearing
  // the socket's end after close() (a busy hold through the reply's playback). cancel() drops both.
  let listening: AssistantListenHandlers | undefined,
    lifecycle: AssistantListenHandlers | undefined;
  let ownerSignal: AbortSignal | undefined;
  const ownerAborted = () => {
    void stop().catch(() => {});
  };
  let ended: () => void = () => {};
  const utterances = new Map<
    string,
    {
      started: boolean;
      onStarted(): void;
      resolve(): void;
      reject(error: unknown): void;
    }
  >();
  const check = () => {
    if (retired) throw cancelled();
    input.assertCurrent();
  };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    retired = true;
    opened = false;
    speechActive = false;
    ended();
    ownerSignal?.removeEventListener("abort", ownerAborted);
    ownerSignal = undefined;
    for (const pending of utterances.values()) pending.reject(cancelled());
    utterances.clear();
    stopping = (async () => {
      try {
        await port.stopCloudSpeech({ sessionId });
      } finally {
        await handle?.remove();
        handle = undefined;
      }
    })();
    return stopping;
  };
  const fail = (error: unknown) => {
    const capture = lifecycle;
    listening = lifecycle = undefined;
    for (const pending of utterances.values()) pending.reject(error);
    utterances.clear();
    void stop().catch(() => {});
    capture?.onEnd(error);
  };
  const receive = (event: CloudStreamEvent) => {
    if (retired || event.sessionId !== sessionId) return;
    try {
      check();
      if (event.type === "error") {
        fail(
          Object.assign(
            Error("Cloud streaming speech is unavailable."),
            {
              code:
                typeof event.code === "string" ? event.code : "cloud-stream",
            },
            event.data && typeof event.data === "object"
              ? { data: event.data }
              : {},
          ),
        );
        return;
      }
      if (event.type === "audio-start" || event.type === "audio-end") {
        if (typeof event.utteranceId !== "string") return;
        const pending = utterances.get(event.utteranceId);
        if (!pending) return;
        if (event.type === "audio-start") {
          if (!pending.started) {
            pending.started = true;
            pending.onStarted();
          }
        } else {
          utterances.delete(event.utteranceId);
          pending.started
            ? pending.resolve()
            : pending.reject(Error("Cloud speech ended without audio."));
        }
        return;
      }
      const capture =
        listening && !listening.signal.aborted ? listening : undefined;
      // Keep provider turn ownership even while capture is closed. A buffered
      // turn that began during a busy hold cannot become the reopened capture's turn.
      if (event.type === "speech-start") {
        if (!speechActive) {
          speechActive = true;
          speechGeneration = capture ? captureGeneration : undefined;
          capture?.onSpeechStart(Date.now());
        }
        return;
      }
      if (
        event.type === "speech-end" &&
        typeof event.text === "string" &&
        event.text.length <= 16384
      ) {
        const owns = speechActive && speechGeneration === captureGeneration;
        speechActive = false;
        speechGeneration = undefined;
        if (capture && owns) {
          capture.onSpeechEnd(Date.now());
          capture.onSegment(event.text.trim() || null);
        }
        ended();
        return;
      }
      if (!capture) return;
      if (
        event.type === "level" &&
        typeof event.peak === "number" &&
        Number.isFinite(event.peak)
      ) {
        capture.onLevel?.(Math.max(0, Math.min(1, event.peak)));
        return;
      }
      if (
        event.type === "transcript" &&
        typeof event.text === "string" &&
        event.text.length <= 16384 &&
        speechActive &&
        speechGeneration === captureGeneration
      ) {
        input.onInterim?.(event.text);
        return;
      }
    } catch (error) {
      fail(error);
    }
  };
  const open = () =>
    (opening ??= (async () => {
      try {
        check();
        const registered = await port.addListener("cloudSpeechEvent", receive);
        if (retired) {
          await registered.remove();
          throw cancelled();
        }
        handle = registered;
        check();
        const result = await port.startCloudSpeech({
          sessionId,
          environment: input.environment,
          credentialId: input.credentialId,
        });
        check();
        if (result.sessionId !== sessionId || result.sampleRate !== 16000)
          throw Error("Cloud speech session changed.");
        opened = true;
        echoCancelled = result.echoCancelled === true;
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
    })());
  const muteAndDrain = async () => {
    check();
    const final = speechActive
      ? new Promise<void>((resolve) => (ended = resolve))
      : Promise.resolve();
    // Bound native mute and the provider final together. Repeating an already-muted
    // native call supplies another silence tail without reopening physical input.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        port.setCloudSpeechMuted({ sessionId, muted: true }).then(() => final),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Error("Cloud speech did not confirm the mute in time.")),
            2500,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      ended = () => {};
    }
  };
  return {
    async listen(handlers: AssistantListenHandlers): Promise<AssistantCapture> {
      check();
      handlers.signal.throwIfAborted();
      if (ownerSignal && ownerSignal !== handlers.signal)
        throw Error("Cloud speech owner changed.");
      if (!ownerSignal) {
        ownerSignal = handlers.signal;
        ownerSignal.addEventListener("abort", ownerAborted, { once: true });
      }
      try {
        // An old provider turn can finish after the busy hold. Drain it while
        // still muted, so fresh user audio cannot be merged into that old turn.
        if (speechActive) await muteAndDrain();
        check();
        handlers.signal.throwIfAborted();
        ++captureGeneration;
        listening = lifecycle = handlers;
        speechActive = false;
        await open();
        check();
        handlers.signal.throwIfAborted();
        await port.setCloudSpeechMuted({ sessionId, muted: false });
        check();
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
      return {
        fullDuplex: echoCancelled,
        async close() {
          try {
            await muteAndDrain();
          } finally {
            if (listening === handlers) {
              listening = undefined;
              speechActive = false;
            }
          }
        },
        async cancel() {
          if (listening === handlers) {
            listening = undefined;
            speechActive = false;
          }
          if (lifecycle === handlers) lifecycle = undefined;
          await stop();
        },
      };
    },
    async speak(
      text: string,
      signal: AbortSignal,
      onStarted: () => void,
    ): Promise<void> {
      check();
      signal.throwIfAborted();
      if (!opened) throw Error("Cloud speech is not connected.");
      const value = text.trim();
      if (!value) return;
      if (value.length > 4096) throw Error("Cloud speech phrase is too long.");
      const utteranceId = crypto.randomUUID();
      let reject!: (error: unknown) => void;
      const done = new Promise<void>((resolve, failed) => {
        reject = failed;
        utterances.set(utteranceId, {
          started: false,
          onStarted,
          resolve,
          reject: failed,
        });
      });
      void done.catch(() => {});
      let retiring: Promise<unknown> | undefined;
      const abort = () => {
        if (retiring) return;
        retiring = Promise.resolve()
          .then(() => port.cancelCloudSpeech({ sessionId, utteranceId }))
          .catch(() => {
            throw Object.assign(
              Error("Cloud speech cleanup was not confirmed."),
              { code: "speech-cleanup-unconfirmed" },
            );
          });
        void retiring.then(
          () => reject(signal.reason ?? cancelled()),
          (error) => reject(error),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        signal.throwIfAborted();
        check();
        await port.speakCloudSpeech({ sessionId, utteranceId, text: value });
        await done;
        signal.throwIfAborted();
        check();
      } finally {
        signal.removeEventListener("abort", abort);
        utterances.delete(utteranceId);
        await retiring;
      }
    },
    stop,
  };
}
