/**
 * Whisper tiny.en inference over ONNX Runtime, independent of the host environment.
 * The runtime is injected so the same code runs in the browser worker and in Node tests.
 * This module has no imports: features, decoding and no-speech policy are pure functions.
 */
export const WHISPER = Object.freeze({
  sampleRate: 16000,
  nFft: 400,
  hop: 160,
  mels: 80,
  windowSamples: 480000,
  frames: 3000,
  heads: 6,
  headDim: 64,
  layers: 4,
  maxNewTokens: 220,
  eot: 50256,
  sot: 50257,
  noSpeech: 50361,
  noTimestamps: 50362,
});

export type WhisperTensor = { data: unknown; dims: readonly number[] };
export type WhisperSession = {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(
    feeds: Record<string, WhisperTensor>,
    fetches?: readonly string[],
  ): Promise<Record<string, WhisperTensor>>;
  release?(): Promise<void>;
};
export type WhisperRuntime = {
  InferenceSession: {
    create(
      model: Uint8Array,
      options?: Record<string, unknown>,
    ): Promise<WhisperSession>;
  };
  Tensor: new (
    type: string,
    data: unknown,
    dims: readonly number[],
  ) => WhisperTensor;
};
export type WhisperGeneration = {
  suppress_tokens?: number[];
  begin_suppress_tokens?: number[];
};
export type WhisperTranscript = {
  text: string;
  noSpeechProbability: number;
  averageLogProbability: number;
  tokens: number;
  noSpeech: boolean;
};

/** Slaney-normalized mel filters for a 400-point FFT at 16 kHz (librosa defaults, as Whisper). */
export function melFilterBank(): Float32Array {
  const { sampleRate, nFft, mels } = WHISPER,
    bins = nFft / 2 + 1;
  const fSp = 200 / 3,
    minLogHz = 1000,
    minLogMel = minLogHz / fSp,
    logStep = Math.log(6.4) / 27;
  const toMel = (hz: number) =>
    hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
  const toHz = (mel: number) =>
    mel < minLogMel
      ? mel * fSp
      : minLogHz * Math.exp(logStep * (mel - minLogMel));
  const top = toMel(sampleRate / 2),
    points = Array.from({ length: mels + 2 }, (_, i) =>
      toHz((top * i) / (mels + 1)),
    );
  const filters = new Float32Array(mels * bins);
  for (let m = 0; m < mels; m++) {
    const lower = points[m],
      centre = points[m + 1],
      upper = points[m + 2],
      norm = 2 / (upper - lower);
    for (let k = 0; k < bins; k++) {
      const hz = (k * sampleRate) / nFft;
      const weight = Math.max(
        0,
        Math.min(
          (hz - lower) / (centre - lower),
          (upper - hz) / (upper - centre),
        ),
      );
      filters[m * bins + k] = weight * norm;
    }
  }
  return filters;
}

let tables:
  | {
      cos: Float32Array;
      sin: Float32Array;
      window: Float32Array;
      filters: Float32Array;
    }
  | undefined;
function spectralTables() {
  if (tables) return tables;
  const { nFft } = WHISPER,
    bins = nFft / 2 + 1;
  const cos = new Float32Array(bins * nFft),
    sin = new Float32Array(bins * nFft),
    window = new Float32Array(nFft);
  for (let n = 0; n < nFft; n++)
    window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / nFft); // periodic Hann
  for (let k = 0; k < bins; k++)
    for (let n = 0; n < nFft; n++) {
      const angle = (2 * Math.PI * ((k * n) % nFft)) / nFft;
      cos[k * nFft + n] = Math.cos(angle);
      sin[k * nFft + n] = Math.sin(angle);
    }
  tables = { cos, sin, window, filters: melFilterBank() };
  return tables;
}

/**
 * Whisper log-mel features [80, 3000] for one 30-second window: zero-padded, centred
 * reflect-padded STFT, power spectrum, mel projection, log10 with an 8-decade floor.
 * Frames that only see padding are exactly zero power and skip the transform.
 */
export function logMelSpectrogram(samples: Float32Array): Float32Array {
  const { nFft, hop, mels, frames, windowSamples } = WHISPER,
    bins = nFft / 2 + 1,
    half = nFft / 2;
  const { cos, sin, window, filters } = spectralTables();
  const audio = new Float32Array(windowSamples);
  audio.set(samples.subarray(0, windowSamples));
  const padded = new Float32Array(windowSamples + nFft);
  padded.set(audio, half);
  for (let i = 0; i < half; i++) {
    padded[i] = audio[half - i];
    padded[half + windowSamples + i] = audio[windowSamples - 2 - i];
  }
  let last = 0;
  for (let i = audio.length - 1; i >= 0; i--)
    if (audio[i] !== 0) {
      last = i + 1;
      break;
    }
  const output = new Float32Array(mels * frames),
    frame = new Float32Array(nFft),
    power = new Float32Array(bins);
  const floor = Math.log10(1e-10);
  let maximum = -Infinity;
  for (let t = 0; t < frames; t++) {
    const start = t * hop;
    // Centred frame t covers padded[start, start+nFft) = audio[start-half, start+half).
    // Zero padding past the recording also reflects zeros at the very end of the window.
    const silent = start - half >= last && start + half <= windowSamples;
    if (silent) {
      for (let m = 0; m < mels; m++) output[m * frames + t] = floor;
      if (floor > maximum) maximum = floor;
      continue;
    }
    for (let n = 0; n < nFft; n++) frame[n] = padded[start + n] * window[n];
    for (let k = 0; k < bins; k++) {
      let re = 0,
        im = 0;
      const row = k * nFft;
      for (let n = 0; n < nFft; n++) {
        re += frame[n] * cos[row + n];
        im -= frame[n] * sin[row + n];
      }
      power[k] = re * re + im * im;
    }
    for (let m = 0; m < mels; m++) {
      let sum = 0;
      const row = m * bins;
      for (let k = 0; k < bins; k++) sum += filters[row + k] * power[k];
      const value = Math.log10(Math.max(sum, 1e-10));
      output[m * frames + t] = value;
      if (value > maximum) maximum = value;
    }
  }
  const limit = maximum - 8;
  for (let i = 0; i < output.length; i++)
    output[i] = (Math.max(output[i], limit) + 4) / 4;
  return output;
}

/** Signal level of a mono recording; used to report silence before loading any model. */
export function audioActivity(samples: Float32Array) {
  let sum = 0,
    peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  return { rms: samples.length ? Math.sqrt(sum / samples.length) : 0, peak };
}
/** True when a recording is too quiet to contain speech (digital silence or a muted input). */
export function silentRecording(samples: Float32Array) {
  const { rms, peak } = audioActivity(samples);
  return (
    samples.length < WHISPER.sampleRate / 10 || peak < 0.01 || rms < 0.0015
  );
}

/**
 * Whisper's own rule (likely no speech and low confidence), plus a confident no-speech token
 * (tiny.en emits short fillers such as "you" for near-silence) or nothing but punctuation.
 */
export function noSpeechDecision(
  text: string,
  noSpeechProbability: number,
  averageLogProbability: number,
) {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  if (
    /^\s*[[(]\s*(blank[_ ]audio|silence|no speech|music|inaudible)\s*[\])]\s*$/i.test(
      text,
    )
  )
    return true;
  if (noSpeechProbability > 0.85) return true;
  return noSpeechProbability > 0.6 && averageLogProbability < -1;
}

/** GPT-2 byte-level BPE decoding for Whisper's English vocabulary. */
export function createTokenDecoder(vocab: Record<string, number>) {
  const printable: number[] = [];
  for (let b = 33; b <= 126; b++) printable.push(b);
  for (let b = 161; b <= 172; b++) printable.push(b);
  for (let b = 174; b <= 255; b++) printable.push(b);
  const byteOf = new Map<string, number>();
  let extra = 0;
  for (let b = 0; b < 256; b++)
    byteOf.set(
      String.fromCodePoint(printable.includes(b) ? b : 256 + extra++),
      b,
    );
  const tokens: string[] = [];
  for (const [token, id] of Object.entries(vocab))
    if (Number.isInteger(id) && id >= 0) tokens[id] = token;
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  return (ids: readonly number[]) => {
    const bytes: number[] = [];
    for (const id of ids) {
      if (id >= WHISPER.eot) continue;
      const token = tokens[id];
      if (token === undefined) continue;
      for (const char of token) {
        const byte = byteOf.get(char);
        if (byte !== undefined) bytes.push(byte);
      }
    }
    return utf8.decode(new Uint8Array(bytes));
  };
}

/** Index of the best token after Whisper's suppression rules (no timestamps or specials). */
export function selectToken(
  logits: Float32Array,
  offset: number,
  vocabSize: number,
  suppressed: Set<number>,
  first: boolean,
  beginSuppressed: Set<number>,
) {
  let best = -1,
    bestValue = -Infinity;
  for (let id = 0; id < vocabSize; id++) {
    if (
      id > WHISPER.eot ||
      suppressed.has(id) ||
      (first && beginSuppressed.has(id))
    )
      continue;
    const value = logits[offset + id];
    if (value > bestValue) {
      bestValue = value;
      best = id;
    }
  }
  return best;
}
/** log-softmax of one logit row at the given id, and the softmax probability of another id. */
export function logProbability(
  logits: Float32Array,
  offset: number,
  vocabSize: number,
  id: number,
) {
  let maximum = -Infinity;
  for (let i = 0; i < vocabSize; i++)
    if (logits[offset + i] > maximum) maximum = logits[offset + i];
  let sum = 0;
  for (let i = 0; i < vocabSize; i++)
    sum += Math.exp(logits[offset + i] - maximum);
  return logits[offset + id] - maximum - Math.log(sum);
}
/** True when the token tail is one n-gram repeated at least four times (decoder loop). */
export function repeatingTail(tokens: readonly number[]) {
  for (let size = 1; size <= 8; size++) {
    if (tokens.length < size * 4) break;
    let repeated = true;
    for (let r = 1; r < 4 && repeated; r++)
      for (let i = 0; i < size; i++)
        if (
          tokens[tokens.length - 1 - i] !==
          tokens[tokens.length - 1 - i - r * size]
        ) {
          repeated = false;
          break;
        }
    if (repeated) return size;
  }
  return 0;
}

export type WhisperModels = {
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: Record<string, number>;
  generation: WhisperGeneration;
};
export type WhisperCheck = () => void;

/** Load both sessions once; each transcription decodes greedily with a key/value cache. */
export async function createWhisperRecognizer(
  runtime: WhisperRuntime,
  models: WhisperModels,
  sessionOptions: Record<string, unknown> = {},
) {
  const options = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
    ...sessionOptions,
  };
  const encoder = await runtime.InferenceSession.create(
    models.encoder,
    options,
  );
  let decoder: WhisperSession;
  try {
    decoder = await runtime.InferenceSession.create(models.decoder, options);
  } catch (error) {
    await encoder.release?.();
    throw error;
  }
  const decode = createTokenDecoder(models.vocab);
  const suppressed = new Set(models.generation.suppress_tokens || []);
  const beginSuppressed = new Set(
    models.generation.begin_suppress_tokens || [220, WHISPER.eot],
  );
  const { heads, headDim, layers } = WHISPER;
  const presentNames = Array.from({ length: layers }, (_, i) =>
    ["decoder.key", "decoder.value", "encoder.key", "encoder.value"].map(
      (kind) => `present.${i}.${kind}`,
    ),
  ).flat();
  for (const name of ["input_features"])
    if (!encoder.inputNames.includes(name))
      throw Error("Unexpected Whisper encoder model");
  for (const name of ["input_ids", "encoder_hidden_states", "use_cache_branch"])
    if (!decoder.inputNames.includes(name))
      throw Error("Unexpected Whisper decoder model");
  const empty = () =>
    new runtime.Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]);
  const ids = (values: number[]) =>
    new runtime.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [
      1,
      values.length,
    ]);

  async function window(samples: Float32Array, check: WhisperCheck) {
    check();
    const features = logMelSpectrogram(samples);
    check();
    const encoded = await encoder.run(
      {
        input_features: new runtime.Tensor("float32", features, [
          1,
          WHISPER.mels,
          WHISPER.frames,
        ]),
      },
      ["last_hidden_state"],
    );
    check();
    const hidden = encoded.last_hidden_state;
    const past: Record<string, WhisperTensor> = {};
    for (let i = 0; i < layers; i++)
      for (const kind of [
        "decoder.key",
        "decoder.value",
        "encoder.key",
        "encoder.value",
      ])
        past[`past_key_values.${i}.${kind}`] = empty();
    let input: number[] = [WHISPER.sot, WHISPER.noTimestamps],
      cached = false;
    const tokens: number[] = [];
    let completed = false;
    let logSum = 0,
      noSpeechProbability = 0;
    for (let step = 0; step < WHISPER.maxNewTokens; step++) {
      const output = await decoder.run(
        {
          input_ids: ids(input),
          encoder_hidden_states: hidden,
          use_cache_branch: new runtime.Tensor("bool", [cached], [1]),
          ...past,
        },
        ["logits", ...presentNames],
      );
      check();
      const logits = output.logits.data as Float32Array,
        [, length, vocabSize] = output.logits.dims;
      if (step === 0)
        noSpeechProbability = Math.exp(
          logProbability(logits, 0, vocabSize, WHISPER.noSpeech),
        );
      const offset = (length - 1) * vocabSize,
        token = selectToken(
          logits,
          offset,
          vocabSize,
          suppressed,
          step === 0,
          beginSuppressed,
        );
      if (token < 0) throw Error("Whisper did not produce a valid token");
      logSum += logProbability(logits, offset, vocabSize, token);
      for (let i = 0; i < layers; i++) {
        past[`past_key_values.${i}.decoder.key`] =
          output[`present.${i}.decoder.key`];
        past[`past_key_values.${i}.decoder.value`] =
          output[`present.${i}.decoder.value`];
        // The cross-attention cache is computed once, by the first (uncached) pass.
        if (!cached) {
          past[`past_key_values.${i}.encoder.key`] =
            output[`present.${i}.encoder.key`];
          past[`past_key_values.${i}.encoder.value`] =
            output[`present.${i}.encoder.value`];
        }
      }
      if (token === WHISPER.eot) {
        completed = true;
        tokens.push(token);
        break;
      }
      tokens.push(token);
      const loop = repeatingTail(tokens);
      if (loop)
        throw Error(
          "Whisper could not finish this recording without repeating",
        );
      input = [token];
      cached = true;
    }
    if (!completed)
      throw Error(
        "Whisper exceeded its decoding limit; no partial transcript was returned",
      );
    const text = decode(tokens).trim();
    return {
      text,
      noSpeechProbability,
      averageLogProbability: logSum / Math.max(1, tokens.length),
      tokens: tokens.filter((t) => t !== WHISPER.eot).length,
    };
  }

  return {
    /** English transcript of 16 kHz mono samples, 30-second windows in order. */
    async transcribe(
      samples: Float32Array,
      check: WhisperCheck = () => {},
    ): Promise<WhisperTranscript> {
      const parts: string[] = [];
      let noSpeechProbability = 1,
        logSum = 0,
        tokens = 0;
      for (
        let start = 0;
        start < Math.max(1, samples.length);
        start += WHISPER.windowSamples
      ) {
        const part = samples.subarray(start, start + WHISPER.windowSamples);
        if (start > 0 && silentRecording(part)) continue;
        const result = await window(part, check);
        noSpeechProbability = Math.min(
          noSpeechProbability,
          result.noSpeechProbability,
        );
        logSum += result.averageLogProbability * Math.max(1, result.tokens);
        tokens += result.tokens;
        if (
          !noSpeechDecision(
            result.text,
            result.noSpeechProbability,
            result.averageLogProbability,
          )
        )
          parts.push(result.text);
      }
      const text = parts.join(" ").replace(/\s+/g, " ").trim(),
        averageLogProbability = logSum / Math.max(1, tokens);
      return {
        text,
        noSpeechProbability,
        averageLogProbability,
        tokens,
        noSpeech: !text,
      };
    },
    async release() {
      await Promise.allSettled([encoder.release?.(), decoder.release?.()]);
    },
  };
}
