/**
 * When `OLLAMA_BASE_URL` is unset, probe common Ollama URLs and set the env
 * var if the server responds with at least one model. That triggers
 * `applyPluginAutoEnable`'s OLLAMA_BASE_URL → @elizaos/plugin-ollama mapping so
 * the agent has a real model provider instead of only the GGUF path (which
 * requires Settings → Local models).
 */

import { logger } from "@elizaos/core";

function trimTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * If `OLLAMA_BASE_URL` is empty, try Ollama `/api/tags` on a small set of
 * bases (OLLAMA_URL, then localhost defaults). On first success with
 * `models.length > 0`, sets `env.OLLAMA_BASE_URL` and returns.
 *
 * Set `ELIZA_SKIP_LOCAL_OLLAMA_PROBE=1` to disable (e.g. air‑gapped or when
 * another service mimics Ollama on 11434).
 */
export async function maybeEnableOllamaFromLocalProbe(
	env: NodeJS.ProcessEnv,
): Promise<void> {
	if (env.ELIZA_SKIP_LOCAL_OLLAMA_PROBE?.trim() === "1") return;
	if (env.OLLAMA_BASE_URL?.trim()) return;

	const orderedBases: string[] = [];
	const push = (raw: string | undefined) => {
		if (!raw?.trim()) return;
		const base = trimTrailingSlashes(raw.trim());
		if (!orderedBases.includes(base)) orderedBases.push(base);
	};
	push(env.OLLAMA_URL);
	push("http://127.0.0.1:11434");
	push("http://localhost:11434");

	for (const base of orderedBases) {
		try {
			const res = await fetch(`${base}/api/tags`, {
				method: "GET",
				signal: AbortSignal.timeout(2500),
			});
			if (!res.ok) continue;
			const data: unknown = await res.json();
			const models =
				data &&
				typeof data === "object" &&
				data !== null &&
				"models" in data &&
				Array.isArray((data as { models: unknown }).models)
					? (data as { models: unknown[] }).models
					: [];
			if (models.length === 0) continue;
			env.OLLAMA_BASE_URL = base;
			logger.info(
				`[eliza] Ollama at ${base} reports ${models.length} model(s); set OLLAMA_BASE_URL for this process so @elizaos/plugin-ollama auto-enables`,
			);
			return;
		} catch {
			/* try next base */
		}
	}
}
