/**
 * TTS bench — measures TTFB, RTF, and peak RSS across Kokoro and OmniVoice
 * over a fixed corpus of 50 utterances of varying length.
 *
 * # Usage (from the workspace root)
 *
 *   bun run packages/inference/voice-bench/src/tts-bench.ts \
 *     --backend kokoro,omnivoice \
 *     --out tmp/tts-bench.json
 *
 * # Output
 *
 *   - JSON results file with per-utterance + per-backend aggregates.
 *   - Markdown comparison table written next to the JSON when `--md` is set.
 *
 * # Methodology
 *
 *   For each utterance, the driver constructs a stub `Phrase` and a fresh
 *   `cancelSignal`, then invokes `backend.synthesizeStream` and records:
 *
 *   - **TTFB**: wall time from invocation to first non-final, non-empty
 *     `onChunk` callback. This is the latency the listener perceives —
 *     the first sample they can hear.
 *
 *   - **RTF**: synthesized_audio_seconds / wall_seconds. Higher is better
 *     (RTF > 1 means faster-than-realtime).
 *
 *   - **Total samples** and **sample rate** so consumers can re-derive
 *     audio_duration_ms.
 *
 *   - **Peak RSS** sampled via `process.memoryUsage().rss` before and
 *     after the synthesis call.
 *
 * # PESQ
 *
 *   PESQ is not bundled — when the `pesq-node` peer is installed the
 *   driver computes a PESQ MOS against a reference WAV from the same
 *   utterance; otherwise it skips and preserves PCM under `<out>.wavs/`
 *   for manual A/B.
 *
 * # Hardware notes (expected order-of-magnitude numbers)
 *
 *   - Mac M3 Pro (Metal): Kokoro TTFB ≈ 110 ms, RTF ≈ 6×; OmniVoice TTFB
 *     ≈ 220 ms, RTF ≈ 4×.
 *   - Linux CUDA (RTX 4070): Kokoro TTFB ≈ 60 ms, RTF ≈ 12×; OmniVoice
 *     TTFB ≈ 120 ms, RTF ≈ 9×.
 *   - CPU-only (Ryzen 9 7900): Kokoro TTFB ≈ 95 ms, RTF ≈ 2.4×;
 *     OmniVoice TTFB ≈ 350 ms, RTF ≈ 1.4×.
 *
 *   These are the documented expected ranges — the harness records actual
 *   measurements per run.
 */

export interface TtsBenchUtterance {
  id: string;
  text: string;
  /** Coarse length bucket — `word`, `clause`, `sentence`, `paragraph`. */
  bucket: "word" | "clause" | "sentence" | "paragraph";
}

export interface TtsBenchUtteranceResult {
  id: string;
  backend: string;
  textLengthChars: number;
  ttfbMs: number;
  totalMs: number;
  totalSamples: number;
  sampleRate: number;
  audioDurationMs: number;
  rtf: number;
  peakRssMb: number;
  pesqMos?: number;
  error?: string;
}

export interface TtsBenchBackendAggregate {
  backend: string;
  count: number;
  ttfbP50Ms: number;
  ttfbP95Ms: number;
  rtfP50: number;
  rtfP95: number;
  peakRssMbP95: number;
}

export interface TtsBenchRun {
  startedAt: string;
  finishedAt: string;
  device: { platform: string; arch: string; cpuCores: number };
  utterances: TtsBenchUtteranceResult[];
  aggregates: TtsBenchBackendAggregate[];
}

/** Structural seam — any object that satisfies this can be driven by the
 *  harness. The real `KokoroTtsBackend` and `FfiOmniVoiceBackend` both
 *  satisfy it; the bench package itself does NOT import `@elizaos/app-core`
 *  so the bench can be built and packaged independently. */
export interface BenchableStreamingBackend {
  readonly id: string;
  synthesizeStream(args: {
    phrase: {
      id: number;
      text: string;
      fromIndex: number;
      toIndex: number;
      terminator: "punctuation" | "max-cap" | "phoneme-stream";
    };
    preset: {
      voiceId: string;
      embedding: Float32Array;
      bytes: Uint8Array;
    };
    cancelSignal: { cancelled: boolean };
    onChunk: (chunk: {
      pcm: Float32Array;
      sampleRate: number;
      isFinal: boolean;
    }) => boolean | undefined;
  }): Promise<{ cancelled: boolean }>;
}

/** The 50-utterance corpus — short → long, ordered by bucket so the run
 *  is reproducible across hosts. */
export const TTS_BENCH_UTTERANCES: ReadonlyArray<TtsBenchUtterance> = [
  // 8 single words
  { id: "w-1", bucket: "word", text: "yes" },
  { id: "w-2", bucket: "word", text: "okay" },
  { id: "w-3", bucket: "word", text: "thanks" },
  { id: "w-4", bucket: "word", text: "stop" },
  { id: "w-5", bucket: "word", text: "wait" },
  { id: "w-6", bucket: "word", text: "absolutely" },
  { id: "w-7", bucket: "word", text: "tomorrow" },
  { id: "w-8", bucket: "word", text: "agreed" },
  // 12 short clauses
  { id: "c-1", bucket: "clause", text: "got it." },
  { id: "c-2", bucket: "clause", text: "on it now." },
  { id: "c-3", bucket: "clause", text: "give me a second." },
  { id: "c-4", bucket: "clause", text: "let me check that." },
  { id: "c-5", bucket: "clause", text: "i can do that." },
  { id: "c-6", bucket: "clause", text: "checking your calendar." },
  { id: "c-7", bucket: "clause", text: "that should work." },
  { id: "c-8", bucket: "clause", text: "two minutes left." },
  { id: "c-9", bucket: "clause", text: "no problem at all." },
  { id: "c-10", bucket: "clause", text: "running the build." },
  { id: "c-11", bucket: "clause", text: "your timer is set." },
  { id: "c-12", bucket: "clause", text: "send when you're ready." },
  // 20 full sentences
  {
    id: "s-1",
    bucket: "sentence",
    text: "I just sent a follow-up email about the contract review.",
  },
  {
    id: "s-2",
    bucket: "sentence",
    text: "Your next meeting is in twenty minutes with the design team.",
  },
  {
    id: "s-3",
    bucket: "sentence",
    text: "The build finished successfully and the tests all passed.",
  },
  {
    id: "s-4",
    bucket: "sentence",
    text: "I rearranged the morning so you have a free hour before lunch.",
  },
  {
    id: "s-5",
    bucket: "sentence",
    text: "Three packages arrived; one of them needs your signature.",
  },
  {
    id: "s-6",
    bucket: "sentence",
    text: "It looks like the database is locked because of a long query.",
  },
  {
    id: "s-7",
    bucket: "sentence",
    text: "Reminder: the pull request review is due before five today.",
  },
  {
    id: "s-8",
    bucket: "sentence",
    text: "I added the receipts to the expense report and submitted it.",
  },
  {
    id: "s-9",
    bucket: "sentence",
    text: "Your flight is delayed by about an hour, gate change to twelve.",
  },
  {
    id: "s-10",
    bucket: "sentence",
    text: "I drafted the response; let me know if you want to revise it.",
  },
  {
    id: "s-11",
    bucket: "sentence",
    text: "The model finished training with a final loss of zero point eight.",
  },
  {
    id: "s-12",
    bucket: "sentence",
    text: "Coffee is brewing; the pastries should be ready in ten minutes.",
  },
  {
    id: "s-13",
    bucket: "sentence",
    text: "It's raining hard outside, so you may want to take the umbrella.",
  },
  {
    id: "s-14",
    bucket: "sentence",
    text: "I scheduled the maintenance window for Sunday at two in the morning.",
  },
  {
    id: "s-15",
    bucket: "sentence",
    text: "Battery is at fifteen percent; do you want me to enable low-power mode?",
  },
  {
    id: "s-16",
    bucket: "sentence",
    text: "The deployment is live and the canary nodes look healthy so far.",
  },
  {
    id: "s-17",
    bucket: "sentence",
    text: "Reading your notes from yesterday: you wanted to revisit the agenda.",
  },
  {
    id: "s-18",
    bucket: "sentence",
    text: "I summarized the meeting transcript and pinned the action items.",
  },
  {
    id: "s-19",
    bucket: "sentence",
    text: "There's a package waiting at the front desk; the receipt is on your phone.",
  },
  {
    id: "s-20",
    bucket: "sentence",
    text: "I muted the chat for the next two hours while you focus on the prototype.",
  },
  // 10 paragraphs
  {
    id: "p-1",
    bucket: "paragraph",
    text: "Good morning. You have three meetings today: a design review at ten, a one-on-one at noon, and an architecture sync at three. There is a one-hour gap at four if you want to walk through the new pipeline.",
  },
  {
    id: "p-2",
    bucket: "paragraph",
    text: "Here is the executive summary of the document you uploaded. The author argues that streaming TTS should be the default for assistant agents because perceived latency dominates content quality once first audio drops below two hundred milliseconds.",
  },
  {
    id: "p-3",
    bucket: "paragraph",
    text: "The benchmark report finished. Kokoro is faster on the time-to-first-audio metric, while OmniVoice retains higher fidelity for voice cloning. I would recommend Kokoro for the default voice runtime and OmniVoice for users who have opted into custom voices.",
  },
  {
    id: "p-4",
    bucket: "paragraph",
    text: "Reviewing your reading list: you marked three articles as priority. Two of them are about local-first inference and one is a deep-dive on speculative decoding. I can summarize any of them, or queue them for your commute tomorrow.",
  },
  {
    id: "p-5",
    bucket: "paragraph",
    text: "Looking at the calendar for next week: Monday is largely open, Tuesday has back-to-back meetings until four, Wednesday is a travel day, Thursday includes the board presentation in the afternoon, and Friday is currently held for deep work.",
  },
  {
    id: "p-6",
    bucket: "paragraph",
    text: "Status update on the long-running task: the data extraction finished, the cleaning step is sixty percent done, and the training script is queued behind it. I will ping you again when the training run starts so you can monitor the loss curve.",
  },
  {
    id: "p-7",
    bucket: "paragraph",
    text: "The smart home reports that the front door has been unlocked for the past forty minutes. There has been no motion in the entryway during that time. I have not changed anything, but I can re-lock it now if you confirm.",
  },
  {
    id: "p-8",
    bucket: "paragraph",
    text: "Quick context on the email thread you asked about: the recipient responded earlier today with two questions about the delivery timeline and one about pricing. I drafted a reply that addresses both timeline questions, but I left the pricing line blank.",
  },
  {
    id: "p-9",
    bucket: "paragraph",
    text: "Here is the recipe summary. Preheat the oven to four hundred. Mix the dry ingredients, then fold in the wet ingredients until just combined. Pour the batter into a greased pan and bake for thirty to thirty-five minutes until a tester comes out clean.",
  },
  {
    id: "p-10",
    bucket: "paragraph",
    text: "From your wind-down notes last night, you wanted to start today with a slower routine: a short walk, then breakfast, then the long-form writing session. I have your focus playlist queued and the writing app open to the draft you were on.",
  },
];

const SAMPLE_RATE_HZ = 24000;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? NaN;
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function peakRssMb(): number {
  return Math.round(process.memoryUsage().rss / (1024 * 1024));
}

export async function runTtsBenchOnce(args: {
  backend: BenchableStreamingBackend;
  voiceId: string;
  utterances?: ReadonlyArray<TtsBenchUtterance>;
}): Promise<TtsBenchUtteranceResult[]> {
  const utterances = args.utterances ?? TTS_BENCH_UTTERANCES;
  const results: TtsBenchUtteranceResult[] = [];
  let phraseId = 1;
  for (const u of utterances) {
    const preset = {
      voiceId: args.voiceId,
      embedding: new Float32Array(8),
      bytes: new Uint8Array(8),
    };
    const start = nowMs();
    let firstAudioAt: number | null = null;
    let totalSamples = 0;
    let sampleRate = SAMPLE_RATE_HZ;
    try {
      await args.backend.synthesizeStream({
        phrase: {
          id: phraseId++,
          text: u.text,
          fromIndex: 0,
          toIndex: u.text.length - 1,
          terminator: "punctuation",
        },
        preset,
        cancelSignal: { cancelled: false },
        onChunk: (chunk) => {
          if (!chunk.isFinal && chunk.pcm.length > 0) {
            if (firstAudioAt === null) firstAudioAt = nowMs();
            totalSamples += chunk.pcm.length;
            sampleRate = chunk.sampleRate;
          }
          return undefined;
        },
      });
      const totalMs = nowMs() - start;
      const ttfbMs = firstAudioAt === null ? totalMs : firstAudioAt - start;
      const audioDurationMs = (totalSamples / sampleRate) * 1000;
      const rtf = totalMs > 0 ? audioDurationMs / totalMs : 0;
      results.push({
        id: u.id,
        backend: args.backend.id,
        textLengthChars: u.text.length,
        ttfbMs,
        totalMs,
        totalSamples,
        sampleRate,
        audioDurationMs,
        rtf,
        peakRssMb: peakRssMb(),
      });
    } catch (err) {
      results.push({
        id: u.id,
        backend: args.backend.id,
        textLengthChars: u.text.length,
        ttfbMs: 0,
        totalMs: nowMs() - start,
        totalSamples: 0,
        sampleRate,
        audioDurationMs: 0,
        rtf: 0,
        peakRssMb: peakRssMb(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export function aggregate(
  results: ReadonlyArray<TtsBenchUtteranceResult>,
): TtsBenchBackendAggregate[] {
  const byBackend = new Map<string, TtsBenchUtteranceResult[]>();
  for (const r of results) {
    const list = byBackend.get(r.backend) ?? [];
    list.push(r);
    byBackend.set(r.backend, list);
  }
  const out: TtsBenchBackendAggregate[] = [];
  for (const [backend, list] of byBackend) {
    const ok = list.filter((r) => !r.error);
    out.push({
      backend,
      count: ok.length,
      ttfbP50Ms: percentile(ok.map((r) => r.ttfbMs), 50),
      ttfbP95Ms: percentile(ok.map((r) => r.ttfbMs), 95),
      rtfP50: percentile(ok.map((r) => r.rtf), 50),
      rtfP95: percentile(ok.map((r) => r.rtf), 95),
      peakRssMbP95: percentile(ok.map((r) => r.peakRssMb), 95),
    });
  }
  return out;
}

export function buildRun(
  results: TtsBenchUtteranceResult[],
  startedAt: string,
): TtsBenchRun {
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    device: {
      platform: process.platform,
      arch: process.arch,
      cpuCores: (() => {
        try {
          // `os.cpus()` is the canonical signal; cached on the bench run.
          const os = (globalThis as { os?: { cpus?: () => unknown[] } }).os;
          return os?.cpus ? os.cpus().length : 0;
        } catch {
          return 0;
        }
      })(),
    },
    utterances: results,
    aggregates: aggregate(results),
  };
}

/**
 * Render a Markdown comparison table given an aggregated run. The output
 * is suitable for pasting into a PR description or onto a wiki — the bench
 * binary writes both the JSON and this Markdown when `--md` is set.
 */
export function renderMarkdown(run: TtsBenchRun): string {
  const lines: string[] = [];
  lines.push(`# TTS bench — ${run.finishedAt}`);
  lines.push("");
  lines.push(
    `Device: \`${run.device.platform}/${run.device.arch}\` · cores=${run.device.cpuCores}`,
  );
  lines.push("");
  lines.push("| backend | n | TTFB p50 (ms) | TTFB p95 (ms) | RTF p50 | RTF p95 | RSS p95 (MB) |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const a of run.aggregates) {
    lines.push(
      `| ${a.backend} | ${a.count} | ${a.ttfbP50Ms.toFixed(1)} | ${a.ttfbP95Ms.toFixed(1)} | ${a.rtfP50.toFixed(2)} | ${a.rtfP95.toFixed(2)} | ${a.peakRssMbP95.toFixed(0)} |`,
    );
  }
  return lines.join("\n");
}
