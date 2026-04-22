import {
  EXTERNAL_LLM_PROBE_ORDER,
  resolveExternalLlmAutodetectUi,
} from "./external-llm-autodetect";
import { classifyExternalProbeModelId } from "./external-probe-model-buckets";
import { sortExternalRuntimes } from "./sort-external-runtimes";
import type {
  ExternalLlmAutodetectFocus,
  ExternalLlmRuntimeRow,
} from "./types";

/** Normalize host for loopback so OPENAI_BASE_URL and probe URLs compare. */
export function hostPortKey(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    let h = u.hostname.toLowerCase();
    if (h === "127.0.0.1") h = "localhost";
    const p =
      u.port ||
      (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return `${h}:${p}`;
  } catch {
    return null;
  }
}

export function urlsMatchHostPort(a: string, b: string): boolean {
  const ka = hostPortKey(a);
  const kb = hostPortKey(b);
  return Boolean(ka && kb && ka === kb);
}

/**
 * Probe row used to populate `OPENAI_EMBEDDING_MODEL` choices:
 * 1. **Explicit stack** (`Only Ollama`, …) → that probe row (wins over
 *    `OPENAI_BASE_URL`, so “Only Ollama” lists Ollama ids only).
 * 2. **Automatic** + `OPENAI_BASE_URL` set → row whose probe endpoint matches
 *    the same host:port (plugin-openai target).
 * 3. Else → same as `resolveBackendRowForEmbeddingSelection` for `any`.
 */
export function resolveBackendRowForOpenAiEmbeddingListing(
  focus: ExternalLlmAutodetectFocus,
  backends: ExternalLlmRuntimeRow[],
  openAiBaseUrl: string,
): ExternalLlmRuntimeRow | null {
  if (focus === "milady-gguf") return null;

  const sorted = sortExternalRuntimes(backends);

  if (focus !== "any") {
    return sorted.find((r) => r.id === focus) ?? null;
  }

  const trimmed = openAiBaseUrl.trim();
  if (trimmed) {
    for (const row of sorted) {
      if (!row.reachable) continue;
      if (!row.endpoint?.trim()) continue;
      if (urlsMatchHostPort(trimmed, row.endpoint)) {
        return row;
      }
    }
  }

  return resolveBackendRowForEmbeddingSelection("any", backends);
}

/** Model ids from a probe list that look like embedding endpoints (heuristic). */
export function embeddingModelIdsFromProbeModels(
  models: readonly string[],
): string[] {
  const out: string[] = [];
  for (const id of models) {
    if (!id || typeof id !== "string") continue;
    if (classifyExternalProbeModelId(id) === "embedding") out.push(id);
  }
  return out;
}

/** Id list to classify for embedding UI (Ollama uses locally pulled names). */
export function probeModelIdsForEmbeddingListing(
  row: ExternalLlmRuntimeRow,
): readonly string[] {
  if (row.id === "ollama" && row.ollamaLocalModelNames !== undefined) {
    return row.ollamaLocalModelNames;
  }
  return row.models;
}

/** Embedding-shaped ids from a hub probe row (Ollama: local /api/tags subset). */
export function embeddingModelIdsFromExternalRow(
  row: ExternalLlmRuntimeRow,
): string[] {
  return embeddingModelIdsFromProbeModels(
    probeModelIdsForEmbeddingListing(row),
  );
}

/**
 * Which external HTTP stack row we use for embedding model listing when the
 * user is not pinned to Milady GGUF.
 *
 * For **Automatic** (`any`), this follows the same **qualifying** rows as
 * `resolveExternalLlmAutodetectUi` (router-ready / “external ready” order), not
 * merely the first probe-order row that is reachable with an embedding-shaped
 * id — otherwise Ollama could “win” embeddings while the Automatic label names
 * LM Studio.
 */
export function resolveBackendRowForEmbeddingSelection(
  focus: ExternalLlmAutodetectFocus,
  backends: ExternalLlmRuntimeRow[],
): ExternalLlmRuntimeRow | null {
  const sorted = sortExternalRuntimes(backends);
  if (focus === "milady-gguf") return null;

  if (focus !== "any") {
    return sorted.find((r) => r.id === focus) ?? null;
  }

  const ui = resolveExternalLlmAutodetectUi(sorted);
  for (const row of ui.qualifyingRowsInProbeOrder) {
    if (embeddingModelIdsFromProbeModels(row.models).length > 0) {
      return row;
    }
  }
  if (ui.qualifyingRowsInProbeOrder.length > 0) {
    return ui.qualifyingRowsInProbeOrder[0] ?? null;
  }

  for (const id of EXTERNAL_LLM_PROBE_ORDER) {
    const row = sorted.find((r) => r.id === id);
    if (!row?.reachable) continue;
    if (embeddingModelIdsFromProbeModels(row.models).length > 0) return row;
  }

  return null;
}
