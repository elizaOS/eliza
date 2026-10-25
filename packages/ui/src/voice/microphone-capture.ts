/** Browser-only capture machinery. The host owns the stream, transcription and interaction policy. */
export interface CumulativeCaptureOptions {
  workletUrl: string;
  processorName: string;
  sampleRate: number;
  maximumSeconds: number;
  previewIntervalMs: number;
  minimumNewSeconds: number;
  speechThreshold: number;
}
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
): Promise<(() => void) | undefined> {
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
  if (
    typeof AudioContext === "undefined" ||
    typeof AudioWorkletNode === "undefined"
  )
    return;
  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: options.sampleRate });
  } catch {
    return;
  }
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const chunks: Float32Array[] = [];
  let samples = 0,
    lastUploaded = 0,
    pending = false,
    closed = false,
    heardSpeech = false;
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
    void context.close().catch(() => {});
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
        samples >= context.sampleRate * options.maximumSeconds ||
        !(data instanceof Float32Array)
      )
        return;
      const remaining = Math.max(
        0,
        Math.floor(context.sampleRate * options.maximumSeconds) - samples,
      );
      if (!remaining || !data.length) return;
      const chunk = data.length > remaining ? data.slice(0, remaining) : data;
      chunks.push(chunk);
      samples += chunk.length;
      const energy = Math.sqrt(
        chunk.reduce((sum, sample) => sum + sample * sample, 0) / chunk.length,
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
      if (
        closed ||
        !active() ||
        !heardSpeech ||
        pending ||
        samples - lastUploaded < context.sampleRate * options.minimumNewSeconds
      )
        return;
      pending = true;
      lastUploaded = samples;
      const snapshot = chunks.slice();
      void (async () => {
        try {
          await receive(snapshot, context.sampleRate);
        } catch {
          /* A failed preview does not discard the caller's final recording. */
        } finally {
          pending = false;
        }
      })();
    }, options.previewIntervalMs);
    return close;
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
  if (typeof AudioContext === "undefined") return () => {};
  let context: AudioContext | undefined,
    source: MediaStreamAudioSourceNode | undefined;
  let interval: ReturnType<typeof setInterval> | undefined,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval);
    source?.disconnect();
    void context?.close().catch(() => {});
  };
  try {
    context = new AudioContext();
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
