/**
 * Heuristic buckets for model ids returned by Ollama /api/tags and OpenAI-style
 * GET /v1/models. Probes only expose string ids — there is no reliable modality
 * metadata, so we infer from common naming patterns for hub status copy.
 */

import type { ExternalLlmRuntimeRow } from "./types";

export interface ExternalProbeModelCounts {
  /** Likely chat / completion LLMs (default bucket). */
  text: number;
  embedding: number;
  /** Image / video-capable or multimodal chat models (naming heuristic). */
  vision: number;
  audio: number;
}

const EMPTY: ExternalProbeModelCounts = {
  text: 0,
  embedding: 0,
  vision: 0,
  audio: 0,
};

/**
 * Assigns each id to exactly one bucket (best-effort; unknown → text).
 */
export function classifyExternalProbeModelId(
  id: string,
): keyof ExternalProbeModelCounts {
  const s = id.toLowerCase();

  if (
    /embed|embedding|bge-|nomic-embed|text-embedding|mxbai|e5-|minilm|voyage|jina-embed|gte-|snowflake|colbert|sentence-transformers|instructor|paraphrase|all-mpnet|all-minilm/.test(
      s,
    ) ||
    /\b(?:text-)?embedding\b/.test(s)
  ) {
    return "embedding";
  }
  if (
    /whisper|xtts|piper|\bbark\b|tts|speech|f5-tts|parler|wav2vec|hubert/.test(
      s,
    )
  ) {
    return "audio";
  }
  if (
    /llava|bakllava|cogvlm|moondream|pixtral|internvl|multimodal|mmproj|vision|phi[-_]?3.*vision|phi[-_]?4.*vision|qwen.*vl|gemma.*it.*img|-vl\d|_vl\b|llama[-_]?3\.2[-_]?vision/.test(
      s,
    )
  ) {
    return "vision";
  }
  return "text";
}

export function summarizeExternalProbeModelIds(
  ids: readonly string[],
): ExternalProbeModelCounts {
  const out = { ...EMPTY };
  for (const id of ids) {
    if (!id || typeof id !== "string") continue;
    const k = classifyExternalProbeModelId(id);
    out[k] += 1;
  }
  return out;
}

/**
 * Model ids counted for the Local AI hub “At this URL — …” line.
 * Ollama: uses {@link ExternalLlmRuntimeRow.ollamaLocalModelNames} when set so
 * the line reflects **pulled** library entries only (excludes cloud/registry
 * refs from `/api/tags`). Other stacks use the probe’s full `models` list.
 */
export function probeModelIdsForHubStatusLine(
  row: ExternalLlmRuntimeRow,
): readonly string[] {
  if (row.id === "ollama" && row.ollamaLocalModelNames !== undefined) {
    return row.ollamaLocalModelNames;
  }
  return row.models;
}

/** Compact “3 chat · 1 embedding” for hub status; vision/audio omitted (router-focused). */
export function formatExternalProbeModelInventoryShort(
  c: ExternalProbeModelCounts,
): string {
  const parts: string[] = [];
  if (c.text) parts.push(`${c.text} chat`);
  if (c.embedding) parts.push(`${c.embedding} embedding`);
  return parts.join(" · ");
}
