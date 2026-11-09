/**
 * Plan only finalized, already-sanitized reply text. A short first phrase lets
 * batch Cloud speech start without synthesizing the whole reply first. Later
 * pieces stay large to avoid a network request for every sentence.
 *
 * This does not stream tokens or prepare speculative audio. Each piece uses the
 * caller's existing owned speaker and is fully retired before the next starts.
 */
export const CLOUD_FIRST_SPEECH_CHARS = 220;
export const CLOUD_SPEECH_REQUEST_CHARS = 5000;
const MIN_FIRST_PHRASE_CHARS = 20;
const abbreviation =
  /\b(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|approx|Prof|Rev|Gen|Sgt|Lt|Col|Maj|Capt|Corp|Pvt|Ave|Blvd|dept|est|govt|assn)\.$/i;

function naturalBoundary(text: string, limit: number, first: boolean): number {
  let phrase = -1,
    sentence = -1;
  for (const match of text.matchAll(/([.!?;:,]+["')\]]?)(?=\s|$)/g)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > limit) break;
    if (end < (first ? MIN_FIRST_PHRASE_CHARS : limit / 2)) continue;
    if (match[1] === "." && abbreviation.test(text.slice(0, end))) continue;
    if (/^[.!?]/.test(match[1])) {
      sentence = end;
      if (first) return end;
    } else phrase = end;
  }
  return sentence > 0 ? sentence : phrase;
}

/** All whitespace is normalized; joining the pieces with one space preserves every word. */
export function planCloudSpeechChunks(input: string): string[] {
  if (typeof input !== "string")
    throw new TypeError("Cloud speech requires text.");
  let rest = input.replace(/\s+/g, " ").trim();
  const chunks: string[] = [];
  while (rest) {
    const first = chunks.length === 0;
    const limit = first ? CLOUD_FIRST_SPEECH_CHARS : CLOUD_SPEECH_REQUEST_CHARS;
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    let boundary = naturalBoundary(rest, limit, first);
    if (boundary < 1) boundary = rest.lastIndexOf(" ", limit);
    // Do not split a lexical unit or silently drop it. An unusually long first
    // word may exceed the initial target, but every request stays under 5000.
    if (boundary < 1) boundary = rest.indexOf(" ");
    if (boundary < 1) boundary = rest.length;
    if (boundary > CLOUD_SPEECH_REQUEST_CHARS)
      throw new RangeError("A word is too long for Cloud speech.");
    chunks.push(rest.slice(0, boundary));
    rest = rest.slice(boundary).trimStart();
  }
  return chunks;
}

export type CloudSpeechChunkPorts = {
  /** Final reply text, after the caller's action and reply-binding checks. */
  text: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Must settle only after playback and owned media cleanup, including abort. */
  speak: (
    text: string,
    signal: AbortSignal,
    onStarted: () => void,
  ) => Promise<void>;
  onStarted?: () => void;
};

/** Sequential batch playback, with one first-audio notification for the whole reply. */
export async function speakCloudSpeechChunks(
  input: CloudSpeechChunkPorts,
): Promise<void> {
  const check = () => {
    input.signal.throwIfAborted();
    input.assertCurrent();
  };
  check();
  // Plan the complete reply before sending any part, including validation of
  // later pieces. This helper never turns a partial reply into authorization.
  const chunks = planCloudSpeechChunks(input.text);
  let started = false;
  for (const text of chunks) {
    check();
    let active = true;
    try {
      await input.speak(text, input.signal, () => {
        if (!active) return;
        check();
        if (!started) {
          started = true;
          input.onStarted?.();
        }
      });
      check();
    } finally {
      active = false;
    }
  }
}
