import type { ExternalLlmRuntimeRow } from "./types";

/** Align hub card order with onboarding-style OpenAI stack → Ollama. */
const EXTERNAL_RUNTIME_ORDER: Record<string, number> = {
  lmstudio: 60,
  vllm: 65,
  jan: 66,
  ollama: 140,
};

function runtimeSortKey(id: string): number {
  return EXTERNAL_RUNTIME_ORDER[id] ?? 999;
}

/** Drop duplicate probe rows (same `id`) — server snapshot can repeat entries. */
export function sortExternalRuntimes(
  rows: ExternalLlmRuntimeRow[],
): ExternalLlmRuntimeRow[] {
  const seen = new Set<string>();
  const uniq = rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  return [...uniq].sort((a, b) => runtimeSortKey(a.id) - runtimeSortKey(b.id));
}
