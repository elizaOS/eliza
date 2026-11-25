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
  /** `ready` and the start result: whether the microphone is closed. */
  muted?: unknown;
  /** `audio-start`: milliseconds from the speak request to the first frame. */
  elapsedMs?: unknown;
  /** `progress`, `audio-end`: milliseconds of this utterance's audio played so far (final on `audio-end`). */
  playedMs?: unknown;
  /** `progress`: milliseconds of this utterance's audio received; `playedMs` never passes it. */
  receivedMs?: unknown;
  /** `audio-end`: the utterance produced no audible sample. */
  silent?: unknown;
  /** `audio-end`: set (to the reason, `audio-focus-lost`) when a transient focus loss stopped the utterance. */
  interrupted?: unknown;
}
export interface CloudStreamPort {
  /** `muted: true` starts with the microphone closed and asks for no microphone permission. */
  startCloudSpeech(input: {
    sessionId: string;
    environment: string;
    credentialId: string;
    muted?: boolean;
  }): Promise<{
    sessionId: string;
    sampleRate: number;
    echoCancelled: boolean;
    muted?: boolean;
  }>;
  stopCloudSpeech(input: { sessionId: string }): Promise<unknown>;
  setCloudSpeechOutputMuted?(input: {
    sessionId: string;
    muted: boolean;
  }): Promise<unknown>;
  /** An unmute without the microphone permission rejects with code `permission-required`. */
  setCloudSpeechMuted(input: {
    sessionId: string;
    muted: boolean;
  }): Promise<unknown>;
  /** `pace` from 0.5 to 2 (default 1) is applied on the device at the same pitch. */
  speakCloudSpeech(input: {
    sessionId: string;
    utteranceId: string;
    text: string;
    pace?: number;
  }): Promise<unknown>;
  cancelCloudSpeech(input: {
    sessionId: string;
    utteranceId: string;
  }): Promise<{ playedMs?: number } | undefined>;
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
  let sessionId = crypto.randomUUID();
  let handle: CloudSpeechListenerHandle | undefined,
    opening: Promise<void> | undefined,
    stopping: Promise<void> | undefined,
    closingTransport: Promise<unknown> | undefined,
    recoveringExpiry: Promise<void> | undefined;
  let opened = false,
    retired = false,
    outputMuted = false,
    echoCancelled = false,
    speechActive = false,
    closingCapture = false,
    expiryRecovered = false;
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
      text: string;
      signal: AbortSignal;
      transportId: string;
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
        await (closingTransport ?? port.stopCloudSpeech({ sessionId }));
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
    if (retired || closingTransport || event.sessionId !== sessionId) return;
    try {
      check();
      if (event.type === "error") {
        if (
          event.code === "expired" &&
          !expiryRecovered &&
          [...utterances.values()].every((pending) => !pending.started)
        ) {
          expiryRecovered = true;
          const capture = listening;
          const recovery = (async () => {
            await replaceMutedTransport();
            check();
            // The agent turn already ran. Resubmit only synthesis that never reached the speaker.
            for (const [utteranceId, pending] of utterances) {
              if (pending.signal.aborted) continue;
              pending.transportId = sessionId;
              await port.speakCloudSpeech({
                sessionId,
                utteranceId,
                text: pending.text,
              });
              check();
            }
            if (capture && capture === listening && !closingCapture && !capture.signal.aborted)
              await port.setCloudSpeechMuted({ sessionId, muted: false });
          })();
          recoveringExpiry = recovery;
          void recovery.then(
            () => { if (recoveringExpiry === recovery) recoveringExpiry = undefined; },
            (error) => {
              if (recoveringExpiry === recovery) recoveringExpiry = undefined;
              if (!retired) fail(error);
            },
          );
          return;
        }
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
          if (typeof event.interrupted === "string")
            pending.reject(
              Object.assign(Error("Cloud speech was interrupted."), {
                code: event.interrupted,
              }),
            );
          else if (pending.started) pending.resolve();
          else pending.reject(Error("Cloud speech ended without audio."));
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
  const open = (muted = false) =>
    (opening ??= (async () => {
      try {
        check();
        if (!handle) {
          const registered = await port.addListener(
            "cloudSpeechEvent",
            receive,
          );
          if (retired) {
            await registered.remove();
            throw cancelled();
          }
          handle = registered;
        }
        check();
        const result = await port.startCloudSpeech({
          sessionId,
          environment: input.environment,
          credentialId: input.credentialId,
          ...(muted ? { muted } : {}),
        });
        check();
        if (result.sessionId !== sessionId || result.sampleRate !== 16000)
          throw Error("Cloud speech session changed.");
        if (outputMuted) {
          await port.setCloudSpeechOutputMuted?.({ sessionId, muted: true });
          check();
        }
        opened = true;
        echoCancelled = result.echoCancelled === true;
      } catch (error) {
        await stop().catch(() => {});
        throw error;
      }
    })());
  const replaceMutedTransport = async () => {
    check();
    // A late final cannot be attributed safely on this socket. Confirm the
    // old transport is stopped before starting a new, muted one.
    const previousId = sessionId;
    const capture = listening;
    const stalled = speechActive && speechGeneration === captureGeneration;
    speechActive = false;
    speechGeneration = undefined;
    if (stalled && capture && !capture.signal.aborted) {
      capture.onSpeechEnd(Date.now());
      capture.onSegment(null);
    }
    opened = false;
    opening = undefined;
    const close = (closingTransport ??= port.stopCloudSpeech({
      sessionId: previousId,
    }));
    try {
      await close;
    } finally {
      if (closingTransport === close) closingTransport = undefined;
    }
    check();
    if (sessionId !== previousId) return;
    sessionId = crypto.randomUUID();
    await open(true);
  };
  const muteAndDrain = async () => {
    check();
    const final = speechActive
      ? new Promise<void>((resolve) => (ended = resolve))
      : Promise.resolve();
    // Bound native mute and the provider final together. Repeating an already-muted
    // native call supplies another silence tail without reopening physical input.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nativeMuted = false;
    try {
      const drained = await Promise.race([
        port.setCloudSpeechMuted({ sessionId, muted: true }).then(async () => {
          nativeMuted = true;
          await final;
          return true;
        }),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2500);
        }),
      ]);
      if (drained) return;
      if (!nativeMuted)
        throw Error("Cloud speech did not confirm the mute in time.");
      if (utterances.size)
        throw Error(
          "Cloud speech could not settle the capture during playback.",
        );
      await replaceMutedTransport();
    } finally {
      if (timer) clearTimeout(timer);
      ended = () => {};
    }
  };
  return {
    async setOutputMuted(muted: boolean): Promise<void> {
      check();
      if (!opened || !port.setCloudSpeechOutputMuted)
        throw Error("Speaker mute is unavailable.");
      await port.setCloudSpeechOutputMuted({ sessionId, muted });
      check();
      outputMuted = muted;
    },
    async listen(handlers: AssistantListenHandlers): Promise<AssistantCapture> {
      await recoveringExpiry;
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
          closingCapture = true;
          try {
            await recoveringExpiry;
            await muteAndDrain();
          } finally {
            if (listening === handlers) {
              listening = undefined;
              speechActive = false;
            }
            closingCapture = false;
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
      await recoveringExpiry;
      check();
      signal.throwIfAborted();
      if (!opened) throw Error("Cloud speech is not connected.");
      const value = text.trim();
      if (!value) return;
      if (value.length > 4096) throw Error("Cloud speech phrase is too long.");
      const utteranceId = crypto.randomUUID();
      const utteranceSessionId = sessionId;
      let reject!: (error: unknown) => void;
      const done = new Promise<void>((resolve, failed) => {
        reject = failed;
        utterances.set(utteranceId, {
          text: value,
          signal,
          transportId: utteranceSessionId,
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
          .then(() =>
            port.cancelCloudSpeech({
              sessionId: utterances.get(utteranceId)?.transportId ?? utteranceSessionId,
              utteranceId,
            }),
          )
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
        await port.speakCloudSpeech({
          sessionId: utteranceSessionId,
          utteranceId,
          text: value,
        });
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
