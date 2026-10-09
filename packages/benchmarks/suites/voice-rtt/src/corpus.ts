/**
 * Fixed voice RTT corpus loader.
 *
 * The JSON fixture gives every run the same short, long, pause, and barge-in
 * turns. Live mode can pair those records with checked-in inline PCM or an
 * operator-supplied audio directory without changing the scoring surface.
 */

import corpusJson from "../fixtures/corpus.json" with { type: "json" };
import type { CorpusCase, CorpusKind } from "./types.ts";

const REQUIRED_KINDS: readonly CorpusKind[] = [
  "short",
  "long",
  "pause",
  "barge-in",
];

export function loadCorpus(): CorpusCase[] {
  const corpus = corpusJson as CorpusCase[];
  validateCorpus(corpus);
  return corpus;
}

export function validateCorpus(corpus: readonly CorpusCase[]): void {
  const kinds = new Set(corpus.map((entry) => entry.kind));
  for (const kind of REQUIRED_KINDS) {
    if (!kinds.has(kind)) {
      throw new Error(`voice RTT corpus missing required ${kind} case`);
    }
  }
  const ids = new Set<string>();
  for (const entry of corpus) {
    if (ids.has(entry.id)) throw new Error(`duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.transcript.trim()) {
      throw new Error(`${entry.id} transcript must be non-empty`);
    }
    if (!entry.expectedReply.trim()) {
      throw new Error(`${entry.id} expectedReply must be non-empty`);
    }
    if (entry.inputAudioMs <= 0) {
      throw new Error(`${entry.id} inputAudioMs must be positive`);
    }
    if (entry.kind === "barge-in" && !Number.isFinite(entry.bargeInAtMs)) {
      throw new Error(`${entry.id} barge-in case must define bargeInAtMs`);
    }
  }
}
