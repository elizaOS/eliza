/**
 * @fileoverview Probe local inference runtimes (Ollama, LM Studio, vLLM).
 *
 * LM Studio and vLLM expose an OpenAI-compatible `/v1/models` endpoint.
 * Ollama uses `/api/tags` for installed model names.
 */

import z from "zod";

export type LocalLlmBackendId = "ollama" | "lmstudio" | "vllm";

export type LocalLlmProbeEnv = Record<string, string | undefined>;

export interface LocalLlmBackendStatus {
	id: LocalLlmBackendId;
	/** Human-readable product name */
	displayName: string;
	/** True when the HTTP probe succeeded with a valid payload */
	reachable: boolean;
	/** Base URL used for the probe */
	endpoint: string;
	/** Model IDs / Ollama tags reported by the server */
	models: string[];
	/** True when the server reports at least one model */
	hasDownloadedModels: boolean;
	error?: string;
}

const PROBE_TIMEOUT_MS = 5000;

const ollamaTagsResponseSchema = z.object({
	models: z.array(z.object({ name: z.string() })).optional(),
});

const openAiModelsResponseSchema = z.object({
	data: z.array(z.object({ id: z.string() })).optional(),
});

function readEnv(env: LocalLlmProbeEnv, key: string): string | undefined {
	return env[key]?.trim() || undefined;
}

function trimTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Ollama HTTP API root (no `/api` suffix). */
export function getOllamaProbeBaseUrl(env: LocalLlmProbeEnv = process.env): string {
	const fromEnv =
		readEnv(env, "OLLAMA_BASE_URL") ||
		readEnv(env, "OLLAMA_URL") ||
		"http://localhost:11434";
	return trimTrailingSlashes(fromEnv);
}

export function getLmStudioProbeBaseUrl(env: LocalLlmProbeEnv = process.env): string {
	const fromEnv = readEnv(env, "LM_STUDIO_BASE_URL") || "http://127.0.0.1:1234";
	return trimTrailingSlashes(fromEnv);
}

export function getVllmProbeBaseUrl(env: LocalLlmProbeEnv = process.env): string {
	const fromEnv =
		readEnv(env, "VLLM_BASE_URL") ||
		readEnv(env, "VLLM_API_BASE") ||
		readEnv(env, "VLLM_OPENAI_API_BASE") ||
		"http://127.0.0.1:8000";
	return trimTrailingSlashes(fromEnv);
}

/** Resolves `…/v1/models` from a server root or an OpenAI base that already ends in `/v1`. */
export function resolveOpenAiCompatibleModelsUrl(baseUrl: string): string {
	const trimmed = trimTrailingSlashes(baseUrl);
	const v1Root = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
	return `${v1Root}/models`;
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function probeOllama(env: LocalLlmProbeEnv): Promise<LocalLlmBackendStatus> {
	const endpoint = getOllamaProbeBaseUrl(env);
	const id: LocalLlmBackendId = "ollama";
	const displayName = "Ollama";

	try {
		const response = await fetch(`${endpoint}/api/tags`, {
			method: "GET",
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

		if (!response.ok) {
			return {
				id,
				displayName,
				reachable: false,
				endpoint,
				models: [],
				hasDownloadedModels: false,
				error: `HTTP ${response.status}`,
			};
		}

		const raw = await safeJson(response);
		const parsed = ollamaTagsResponseSchema.safeParse(raw);
		if (!parsed.success) {
			return {
				id,
				displayName,
				reachable: false,
				endpoint,
				models: [],
				hasDownloadedModels: false,
				error: "Unexpected JSON from /api/tags",
			};
		}

		const models = parsed.data.models?.map((m) => m.name) ?? [];
		return {
			id,
			displayName,
			reachable: true,
			endpoint,
			models,
			hasDownloadedModels: models.length > 0,
		};
	} catch (error) {
		return {
			id,
			displayName,
			reachable: false,
			endpoint,
			models: [],
			hasDownloadedModels: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

async function probeOpenAiCompatibleModels(options: {
	id: LocalLlmBackendId;
	displayName: string;
	endpoint: string;
	/** Optional Bearer token (e.g. LM_STUDIO_API_KEY) */
	apiKey?: string;
}): Promise<LocalLlmBackendStatus> {
	const { id, displayName, endpoint, apiKey } = options;
	const modelsUrl = resolveOpenAiCompatibleModelsUrl(endpoint);

	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		const response = await fetch(modelsUrl, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

		if (!response.ok) {
			return {
				id,
				displayName,
				reachable: false,
				endpoint,
				models: [],
				hasDownloadedModels: false,
				error: `HTTP ${response.status}`,
			};
		}

		const raw = await safeJson(response);
		const parsed = openAiModelsResponseSchema.safeParse(raw);
		if (!parsed.success) {
			return {
				id,
				displayName,
				reachable: false,
				endpoint,
				models: [],
				hasDownloadedModels: false,
				error: "Unexpected JSON from /v1/models",
			};
		}

		const models = parsed.data.data?.map((m) => m.id) ?? [];
		return {
			id,
			displayName,
			reachable: true,
			endpoint,
			models,
			hasDownloadedModels: models.length > 0,
		};
	} catch (error) {
		return {
			id,
			displayName,
			reachable: false,
			endpoint,
			models: [],
			hasDownloadedModels: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Detect Ollama, LM Studio, and vLLM on default or configured ports.
 *
 * Env overrides:
 * - Ollama: `OLLAMA_BASE_URL`, `OLLAMA_URL`
 * - LM Studio: `LM_STUDIO_BASE_URL`, optional `LM_STUDIO_API_KEY`
 * - vLLM: `VLLM_BASE_URL`, `VLLM_API_BASE`, or `VLLM_OPENAI_API_BASE`
 */
export async function detectLocalLlmBackends(options?: {
	env?: LocalLlmProbeEnv;
}): Promise<LocalLlmBackendStatus[]> {
	const env = options?.env ?? process.env;
	const lmStudioKey =
		readEnv(env, "LM_STUDIO_API_KEY") || readEnv(env, "LMSTUDIO_API_KEY");

	const [ollama, lmstudio, vllm] = await Promise.all([
		probeOllama(env),
		probeOpenAiCompatibleModels({
			id: "lmstudio",
			displayName: "LM Studio",
			endpoint: getLmStudioProbeBaseUrl(env),
			apiKey: lmStudioKey,
		}),
		probeOpenAiCompatibleModels({
			id: "vllm",
			displayName: "vLLM",
			endpoint: getVllmProbeBaseUrl(env),
		}),
	]);

	return [ollama, lmstudio, vllm];
}
