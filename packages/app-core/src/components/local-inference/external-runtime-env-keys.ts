import type { ExternalLlmRuntimeRow } from "../../api/client-local-inference";

/** Config `env.vars` key written when the user saves that card’s URL. */
export const EXTERNAL_RUNTIME_ENV_VARS: Record<
  ExternalLlmRuntimeRow["id"],
  { primary: string; fallbacks?: readonly string[] }
> = {
  ollama: { primary: "OLLAMA_BASE_URL", fallbacks: ["OLLAMA_URL"] as const },
  lmstudio: { primary: "LM_STUDIO_BASE_URL" },
  vllm: { primary: "VLLM_BASE_URL" },
  jan: { primary: "JAN_BASE_URL" },
};

export function readRuntimeUrlFromVars(
  vars: Record<string, string>,
  row: ExternalLlmRuntimeRow,
): string {
  const meta = EXTERNAL_RUNTIME_ENV_VARS[row.id];
  const keys = [meta.primary, ...(meta.fallbacks ?? [])];
  for (const k of keys) {
    const v = vars[k]?.trim();
    if (v) return v;
  }
  return row.endpoint;
}
