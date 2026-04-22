/**
 * When `OPENAI_BASE_URL` is unset and `OPENAI_API_KEY` is unset, probe common
 * OpenAI-compatible servers (LM Studio default :1234, vLLM default :8000).
 * On success with ≥1 model in `/v1/models`, sets `OPENAI_BASE_URL` and a
 * placeholder `OPENAI_API_KEY` so `applyPluginAutoEnable` enables
 * `@elizaos/plugin-openai` — LM Studio / vLLM often accept any bearer when
 * server auth is off.
 *
 * Probing does not leave partial `OPENAI_*` mutations on failure: we snapshot
 * env at entry and restore in `finally` unless a winner was committed.
 */

import { logger } from "@elizaos/core";

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function toOpenAiV1Root(base: string): string {
  const t = trimTrailingSlashes(base.trim());
  if (t.endsWith("/v1")) return t;
  return `${t}/v1`;
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v || undefined;
}

type OpenAiModelsPayload = {
  data?: Array<{ id?: string }>;
};

function countOpenAiModels(data: unknown): number {
  if (!data || typeof data !== "object" || data === null) return 0;
  const payload = data as OpenAiModelsPayload;
  if (!Array.isArray(payload.data)) return 0;
  return payload.data.filter(
    (e) => e && typeof e.id === "string" && e.id.length > 0,
  ).length;
}

async function probeV1Models(
  v1Root: string,
): Promise<{ ok: boolean; modelCount: number }> {
  const url = `${trimTrailingSlashes(v1Root)}/models`;
  const res = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) return { ok: false, modelCount: 0 };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, modelCount: 0 };
  }
  const n = countOpenAiModels(body);
  return { ok: n > 0, modelCount: n };
}

function restoreOpenAiProbeEnv(
  env: NodeJS.ProcessEnv,
  snapshotBase: string | undefined,
  snapshotKey: string | undefined,
): void {
  if (snapshotBase !== undefined) env.OPENAI_BASE_URL = snapshotBase;
  else delete env.OPENAI_BASE_URL;
  if (snapshotKey !== undefined) env.OPENAI_API_KEY = snapshotKey;
  else delete env.OPENAI_API_KEY;
}

/**
 * If `OPENAI_BASE_URL` is empty and `OPENAI_API_KEY` is empty, try LM Studio
 * then vLLM OpenAI-compatible `/v1/models`. Sets env for this process only
 * when a server responds with models; otherwise restores prior `OPENAI_*`
 * keys (typically leaving them unset).
 *
 * Set `ELIZA_SKIP_LOCAL_OPENAI_COMPAT_PROBE=1` to disable.
 */
export async function maybeEnableOpenAiCompatibleFromLocalProbe(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (env.ELIZA_SKIP_LOCAL_OPENAI_COMPAT_PROBE?.trim() === "1") return;
  if (readEnv(env, "OPENAI_BASE_URL")) return;
  if (readEnv(env, "OPENAI_API_KEY")) return;

  const snapshotBase = env.OPENAI_BASE_URL;
  const snapshotKey = env.OPENAI_API_KEY;
  let committed = false;

  try {
    type Win = { v1: string; kind: "lm" | "vllm"; modelCount: number };
    let win: Win | null = null;

    const lmCandidates: string[] = [];
    const pushLm = (raw: string | undefined) => {
      if (!raw?.trim()) return;
      const b = trimTrailingSlashes(raw.trim());
      if (!lmCandidates.includes(b)) lmCandidates.push(b);
    };
    pushLm(readEnv(env, "LM_STUDIO_BASE_URL"));
    pushLm("http://127.0.0.1:1234");
    pushLm("http://localhost:1234");

    for (const host of lmCandidates) {
      const v1 = toOpenAiV1Root(host);
      try {
        const { ok, modelCount } = await probeV1Models(v1);
        if (!ok) continue;
        win = { v1, kind: "lm", modelCount };
        break;
      } catch {
        /* try next */
      }
    }

    if (!win) {
      const vllmCandidates: string[] = [];
      const pushV = (raw: string | undefined) => {
        if (!raw?.trim()) return;
        const b = trimTrailingSlashes(raw.trim());
        if (!vllmCandidates.includes(b)) vllmCandidates.push(b);
      };
      pushV(readEnv(env, "VLLM_BASE_URL"));
      pushV(readEnv(env, "VLLM_API_BASE"));
      pushV(readEnv(env, "VLLM_OPENAI_API_BASE"));
      pushV("http://127.0.0.1:8000");
      pushV("http://localhost:8000");

      for (const host of vllmCandidates) {
        const v1 = toOpenAiV1Root(host);
        try {
          const { ok, modelCount } = await probeV1Models(v1);
          if (!ok) continue;
          win = { v1, kind: "vllm", modelCount };
          break;
        } catch {
          /* try next */
        }
      }
    }

    if (!win) return;

    env.OPENAI_BASE_URL = win.v1;
    env.OPENAI_API_KEY =
      readEnv(env, "OPENAI_API_KEY") ??
      (win.kind === "lm" ? "lm-studio" : "vllm");
    committed = true;
    if (win.kind === "lm") {
      logger.info(
        `[eliza] LM Studio–compatible server at ${win.v1} lists ${win.modelCount} model(s); set OPENAI_BASE_URL (+ placeholder OPENAI_API_KEY) so @elizaos/plugin-openai auto-enables`,
      );
    } else {
      logger.info(
        `[eliza] vLLM OpenAI-compatible server at ${win.v1} lists ${win.modelCount} model(s); set OPENAI_BASE_URL (+ placeholder OPENAI_API_KEY) so @elizaos/plugin-openai auto-enables`,
      );
    }
  } finally {
    if (!committed) {
      restoreOpenAiProbeEnv(env, snapshotBase, snapshotKey);
    }
  }
}
