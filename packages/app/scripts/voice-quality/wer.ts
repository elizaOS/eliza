/**
 * Word error rate, text normalization and the small audio helpers the voice
 * quality gates share. Pure functions; no I/O.
 *
 * Normalization (applied to reference and hypothesis alike): lowercase, ASCII
 * folding, apostrophes dropped ("hurlbut's" -> "hurlbuts"), hyphens and other
 * punctuation become spaces, and runs of English number words become digits
 * ("one hundred sixty nine" -> "169", "nineteen ninety seven" -> "1997"), so
 * a recognizer that writes digits and a reference that spells them agree.
 */

const UNITS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = {
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

function isNumberWord(word: string): boolean {
  return word in UNITS || word in TENS || word in SCALES || word === "hundred";
}

/** A value below 100 spelled as one or two words ("nineteen", "ninety seven"). */
function pairValue(words: string[]): number | null {
  if (words.length === 1) {
    const [w] = words as [string];
    if (w in UNITS) return UNITS[w] as number;
    if (w in TENS) return TENS[w] as number;
    return null;
  }
  if (words.length === 2) {
    const [a, b] = words as [string, string];
    if (
      a in TENS &&
      b in UNITS &&
      (UNITS[b] as number) > 0 &&
      (UNITS[b] as number) < 10
    )
      return (TENS[a] as number) + (UNITS[b] as number);
  }
  return null;
}

/** Cardinal value of a run of number words, or null when it does not parse. */
export function parseNumberWords(words: string[]): number | null {
  if (words.length === 0) return null;
  // Years read as two pairs: "nineteen ninety seven", "twenty fifteen".
  if (!words.some((w) => w in SCALES || w === "hundred")) {
    for (let split = 1; split < words.length; split++) {
      const head = pairValue(words.slice(0, split));
      const tail = pairValue(words.slice(split));
      if (head !== null && tail !== null && head >= 10 && tail >= 10) {
        return head * 100 + tail;
      }
    }
  }
  // "oh" only counts inside a year ("nineteen oh five") or alone; never as a
  // standalone cardinal part.
  if (words.includes("oh")) {
    if (words.length === 3 && words[1] === "oh") {
      const head = pairValue([words[0] as string]);
      const tail = pairValue([words[2] as string]);
      if (head !== null && tail !== null && head >= 10 && tail < 10)
        return head * 100 + tail;
    }
    return null;
  }
  let total = 0;
  let current = 0;
  let last: "none" | "unit" | "teen" | "tens" | "hundred" | "scale" = "none";
  for (const w of words) {
    if (w in UNITS) {
      const v = UNITS[w] as number;
      const kind = v < 10 ? "unit" : "teen";
      if (last === "unit" || last === "teen") return null;
      if (last === "tens" && kind === "teen") return null;
      current += v;
      last = kind;
    } else if (w in TENS) {
      if (last === "unit" || last === "teen" || last === "tens") return null;
      current += TENS[w] as number;
      last = "tens";
    } else if (w === "hundred") {
      if (last === "hundred") return null;
      if (current % 100 === 0 && current > 0) return null;
      current = (current === 0 ? 1 : current) * 100;
      last = "hundred";
    } else if (w in SCALES) {
      if (last === "scale") return null;
      total += (current === 0 ? 1 : current) * (SCALES[w] as number);
      current = 0;
      last = "scale";
    } else {
      return null;
    }
  }
  return total + current;
}

/** Replace maximal runs of number words with their digits ("and" may join them). */
function numbersToDigits(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isNumberWord(words[i] as string) || words[i] === "oh") {
      out.push(words[i] as string);
      i++;
      continue;
    }
    let j = i;
    while (
      j < words.length &&
      (isNumberWord(words[j] as string) ||
        (words[j] === "and" &&
          j + 1 < words.length &&
          isNumberWord(words[j + 1] as string) &&
          words[j - 1] === "hundred"))
    ) {
      j++;
    }
    // Shrink from the right until the run parses.
    let end = j;
    let value: number | null = null;
    while (end > i) {
      value = parseNumberWords(words.slice(i, end).filter((w) => w !== "and"));
      if (value !== null) break;
      end--;
    }
    if (value === null || end === i) {
      out.push(words[i] as string);
      i++;
      continue;
    }
    out.push(String(value));
    i = end;
  }
  return out;
}

/** Strip thousands separators, including chained ones ("1,000,000" -> "1000000"). */
function stripThousandsSeparators(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(/(\d),(\d{3})/g, "$1$2");
    if (next === current) return current;
    current = next;
  }
}

/** Normalized word list for WER. */
export function normalizeWords(text: string): string[] {
  const folded = stripThousandsSeparators(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/%/g, " percent ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!folded) return [];
  return numbersToDigits(folded.split(/\s+/));
}

export interface WordErrors {
  readonly edits: number;
  readonly words: number;
  readonly substitutions: number;
  readonly deletions: number;
  readonly insertions: number;
}

/** Word-level Levenshtein alignment of hypothesis against reference. */
export function wordErrors(reference: string, hypothesis: string): WordErrors {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const rows = ref.length + 1;
  const cols = hyp.length + 1;
  const cost = new Uint32Array(rows * cols);
  const op = new Uint8Array(rows * cols); // 0 match, 1 sub, 2 del, 3 ins
  for (let i = 0; i < rows; i++) {
    cost[i * cols] = i;
    op[i * cols] = 2;
  }
  for (let j = 0; j < cols; j++) {
    cost[j] = j;
    op[j] = 3;
  }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      const diag = (cost[(i - 1) * cols + j - 1] as number) + (same ? 0 : 1);
      const del = (cost[(i - 1) * cols + j] as number) + 1;
      const ins = (cost[i * cols + j - 1] as number) + 1;
      let best = diag;
      let which = same ? 0 : 1;
      if (del < best) {
        best = del;
        which = 2;
      }
      if (ins < best) {
        best = ins;
        which = 3;
      }
      cost[i * cols + j] = best;
      op[i * cols + j] = which;
    }
  }
  let i = ref.length;
  let j = hyp.length;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 || j > 0) {
    const which = i === 0 ? 3 : j === 0 ? 2 : (op[i * cols + j] as number);
    if (which === 0 || which === 1) {
      if (which === 1) substitutions++;
      i--;
      j--;
    } else if (which === 2) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  return {
    edits: substitutions + deletions + insertions,
    words: ref.length,
    substitutions,
    deletions,
    insertions,
  };
}

/** Corpus WER: total edits over total reference words. */
export function corpusWer(rows: ReadonlyArray<WordErrors>): number {
  const words = rows.reduce((n, r) => n + r.words, 0);
  const edits = rows.reduce((n, r) => n + r.edits, 0);
  return words === 0 ? (edits === 0 ? 0 : 1) : edits / words;
}

export interface MonoPcm {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** Decode a mono PCM16 (or fp32) RIFF/WAVE buffer. */
export function decodeWav(bytes: Uint8Array): MonoPcm {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE buffer");
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      if (channels !== 1)
        throw new Error(`expected mono WAV, got ${channels} channels`);
      const end = Math.min(bytes.length, body + size);
      if (format === 1 && bits === 16) {
        const n = Math.floor((end - body) / 2);
        const samples = new Float32Array(n);
        for (let k = 0; k < n; k++)
          samples[k] = view.getInt16(body + k * 2, true) / 32768;
        return { samples, sampleRate };
      }
      if (format === 3 && bits === 32) {
        const n = Math.floor((end - body) / 4);
        const samples = new Float32Array(n);
        for (let k = 0; k < n; k++)
          samples[k] = view.getFloat32(body + k * 4, true);
        return { samples, sampleRate };
      }
      throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Encode mono samples as PCM16 WAV. */
export function encodeWav(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let k = 0; k < text.length; k++) out[offset + k] = text.charCodeAt(k);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let k = 0; k < samples.length; k++) {
    // Inverse of decodeWav's /32768, so PCM16 input round-trips bit-exactly.
    const v = Math.round((samples[k] ?? 0) * 32768);
    view.setInt16(44 + k * 2, Math.max(-32768, Math.min(32767, v)), true);
  }
  return out;
}

/**
 * Windowed-sinc resampler (Hann window, 16 zero crossings), the same filter
 * the on-device qualify tests use, for 24 kHz TTS output to 16 kHz ASR input.
 */
export function resample(
  input: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const cutoff = Math.min(1, to / from) * 0.97;
  const half = 16;
  const count = Math.floor(input.length / ratio);
  const out = new Float32Array(count);
  for (let n = 0; n < count; n++) {
    const center = n * ratio;
    const first = Math.max(0, Math.ceil(center - half / cutoff));
    const last = Math.min(input.length - 1, Math.floor(center + half / cutoff));
    let sum = 0;
    for (let k = first; k <= last; k++) {
      const x = (k - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      sum += (input[k] as number) * cutoff * sinc * window;
    }
    out[n] = Math.max(-1, Math.min(1, sum));
  }
  return out;
}
