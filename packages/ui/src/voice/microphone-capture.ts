/** Browser-only capture machinery. The host owns the stream, transcription and interaction policy. */
export interface CumulativeCaptureOptions {
  workletUrl: string;
  processorName: string;
  sampleRate: number;
  maximumSeconds: number;
  previewIntervalMs: number;
  minimumNewSeconds: number;
  speechThreshold: number;
  /** A caller-owned context to capture on, so endpointing can share it. It is never closed
   * here. Create it with `{ sampleRate }` equal to `sampleRate`: a context at another rate
   * (for example a default 48 kHz one) is refused with a RangeError, because it would make
   * every stored chunk and preview several times larger. */
  context?: AudioContext;
  /** RMS level of every worklet block, with the stream sample index where the block ends
   * (time = endSample / sampleRate). Blocks past `maximumSeconds` are still reported. */
  onLevel?: (level: number, endSample: number, sampleRate: number) => void;
}
/** Closes the capture; `snapshot` sends a preview of the speech so far at once (for example at a
 * pause) instead of at the next tick. It waits for a preview in flight and resolves true when
 * `receive` completed, false when there was nothing new or the capture is closed or inactive. */
export type CumulativeCapture = (() => void) & {
  snapshot: () => Promise<boolean>;
};
function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function audioBlobBase64(
  blob: Blob,
  readError: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error(readError));
    reader.readAsDataURL(blob);
  });
}

/** Best-effort cumulative previews; never stops caller-owned tracks or retries a transcription. */
export async function startCumulativeMicrophoneCapture(
  stream: MediaStream,
  receive: (
    chunks: readonly Float32Array[],
    sampleRate: number,
  ) => Promise<void>,
  active: () => boolean,
  options: CumulativeCaptureOptions,
): Promise<CumulativeCapture | undefined> {
  if (
    !options.workletUrl ||
    !options.processorName ||
    ![
      options.sampleRate,
      options.maximumSeconds,
      options.previewIntervalMs,
      options.minimumNewSeconds,
      options.speechThreshold,
    ].every(positive)
  )
    throw new RangeError("Invalid microphone capture policy");
  const shared = options.context;
  if (shared && shared.sampleRate !== options.sampleRate)
    throw new RangeError(
      "The shared AudioContext must run at the capture sample rate",
    );
  if (
    typeof AudioWorkletNode === "undefined" ||
    (!shared && typeof AudioContext === "undefined")
  )
    return;
  let context: AudioContext;
  try {
    context = shared ?? new AudioContext({ sampleRate: options.sampleRate });
  } catch {
    return;
  }
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const chunks: Float32Array[] = [];
  let samples = 0,
    received = 0,
    lastUploaded = 0,
    closed = false,
    heardSpeech = false;
  let inflight: Promise<boolean> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    source?.disconnect();
    processor?.disconnect();
    if (processor) {
      processor.port.onmessage = null;
      processor.port.close();
    }
    chunks.length = 0;
    if (!shared) void context.close().catch(() => {});
  };
  const deliver = (minimumSamples: number): Promise<boolean> | undefined => {
    if (
      closed ||
      !active() ||
      !heardSpeech ||
      inflight ||
      samples - lastUploaded < Math.max(1, minimumSamples)
    )
      return;
    lastUploaded = samples;
    const sending = chunks.slice();
    // The guard is set before `receive` runs, so a synchronous throw cannot leave it stale.
    let settle!: (sentOk: boolean) => void;
    const sent = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    inflight = sent;
    void (async () => {
      let sentOk = false;
      try {
        await receive(sending, context.sampleRate);
        sentOk = true;
      } catch {
        /* A failed preview does not discard the caller's final recording. */
      } finally {
        if (inflight === sent) inflight = undefined;
        settle(sentOk);
      }
    })();
    return sent;
  };
  const snapshot = async (): Promise<boolean> => {
    for (let current = inflight; current; current = inflight) {
      await current;
      if (inflight === current) return false;
    }
    return (await deliver(1)) ?? false;
  };
  try {
    await context.audioWorklet.addModule(options.workletUrl);
    if (!active()) {
      close();
      return;
    }
    source = context.createMediaStreamSource(stream);
    processor = new AudioWorkletNode(context, options.processorName, {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    processor.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
      if (
        closed ||
        !active() ||
        !(data instanceof Float32Array) ||
        !data.length
      )
        return;
      received += data.length;
      const remaining = Math.max(
        0,
        Math.floor(context.sampleRate * options.maximumSeconds) - samples,
      );
      // Without onLevel, blocks past the cap are dropped before any work, as before.
      if (!remaining && !options.onLevel) return;
      const level = Math.sqrt(
        data.reduce((sum, sample) => sum + sample * sample, 0) / data.length,
      );
      options.onLevel?.(level, received, context.sampleRate);
      if (!remaining) return;
      const chunk = data.length > remaining ? data.slice(0, remaining) : data;
      chunks.push(chunk);
      samples += chunk.length;
      const energy =
        chunk === data
          ? level
          : Math.sqrt(
              chunk.reduce((sum, sample) => sum + sample * sample, 0) /
                chunk.length,
            );
      if (energy >= options.speechThreshold) heardSpeech = true;
    };
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
    if (!active()) {
      close();
      return;
    }
    timer = setInterval(() => {
      void deliver(context.sampleRate * options.minimumNewSeconds);
    }, options.previewIntervalMs);
    return Object.assign(close, { snapshot });
  } catch {
    close();
    return;
  }
}

export interface SpeechPauseOptions {
  silenceMs: number;
  speechThreshold: number;
  speechFrames: number;
  pollMs: number;
  fftSize: number;
  /** A caller-owned context (for example the capture's) to observe on; it is never closed here. */
  context?: AudioContext;
}
/** Audio observation only. It cannot submit a message or interpret intent. */
export function observeMicrophonePause(
  stream: MediaStream,
  onPause: () => void,
  options: SpeechPauseOptions,
): () => void {
  if (
    ![options.silenceMs, options.speechThreshold, options.pollMs].every(
      positive,
    ) ||
    !Number.isInteger(options.speechFrames) ||
    options.speechFrames < 1 ||
    !Number.isInteger(options.fftSize) ||
    options.fftSize < 32 ||
    options.fftSize > 32768 ||
    (options.fftSize & (options.fftSize - 1)) !== 0
  )
    throw new RangeError("Invalid speech pause policy");
  const shared = options.context;
  if (!shared && typeof AudioContext === "undefined") return () => {};
  let context: AudioContext | undefined,
    source: MediaStreamAudioSourceNode | undefined;
  let interval: ReturnType<typeof setInterval> | undefined,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    source?.disconnect();
    if (!shared) void context?.close().catch(() => {});
  };
  try {
    context = shared ?? new AudioContext();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = options.fftSize;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let speechFrames = 0,
      heardSpeech = false,
      lastSound = performance.now();
    void context.resume().catch(() => {});
    interval = setInterval(() => {
      if (closed || context?.state !== "running") return;
      analyser.getFloatTimeDomainData(samples);
      const energy = Math.sqrt(
        samples.reduce((sum, sample) => sum + sample * sample, 0) /
          samples.length,
      );
      if (energy >= options.speechThreshold) {
        lastSound = performance.now();
        if (++speechFrames >= options.speechFrames) heardSpeech = true;
      } else {
        speechFrames = 0;
        if (heardSpeech && performance.now() - lastSound >= options.silenceMs) {
          close();
          onPause();
        }
      }
    }, options.pollMs);
  } catch {
    close();
  }
  return close;
}
