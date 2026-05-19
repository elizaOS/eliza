/**
 * llama-server vision-describe backend (WS2).
 *
 * Wraps the out-of-process llama-server's `/completion` endpoint with
 * the `image_data` array (base64-encoded payloads) and shapes the
 * response to the WS2 `VisionDescribeBackend` contract.
 *
 * llama-server image-data API recap (verified against llama.cpp commit
 * b8198+, May 2026):
 *
 *   POST /completion
 *   { "prompt": "<...>USER: [img-12] What's in this image?\nASSISTANT:",
 *     "image_data": [
 *       { "data": "<base64 png/jpeg>", "id": 12 }
 *     ],
 *     "n_predict": 256,
 *     "temperature": 0.2,
 *     "stream": false }
 *
 *   Response:
 *   { "content": "A photo of a cat.", "stop": true,
 *     "timings": { "prompt_ms": 180.4, "predicted_ms": 423.1 } }
 *
 * Server-side mmproj is loaded via the `--mmproj <path>` flag on
 * llama-server startup. The dflash-server wrapper passes this flag
 * already for tiers with vision enabled; this backend assumes the
 * server has been started with the right mmproj for the active model.
 *
 * Backend responsibility:
 *   - Encode the image as base64 (when not already).
 *   - Build the prompt with the `[img-N]` placeholder convention.
 *   - POST to `/completion`, parse the text + timings.
 *   - Honour AbortSignal by passing it through to the fetch call.
 *
 * Backend explicitly does NOT:
 *   - Start / stop the server. That's the dflash-server wrapper's job.
 *   - Resolve the mmproj path — the server already has it. The arbiter's
 *     `--mmproj` was set when the text model loaded.
 *   - Implement projector-token reuse. llama-server has no API to
 *     accept pre-projected tokens; if the WS1 cache hit happens, this
 *     backend ignores the hint and re-runs the projector. The cache
 *     is more useful with the in-process node-llama-cpp backend.
 *
 * Metal / CUDA validation:
 *   The llama-server build embeds the same mtmd_encode path the
 *   in-process binding will eventually expose. On a Metal build the
 *   image encode dispatches through the Metal compute encoder; on a
 *   CUDA build through cuBLAS. We have no GPU on this host — see the
 *   `__tests__/vision-describe.test.ts` notes for the GPU smoke check.
 */

import { resolveImageBytes } from "./hash";
import type {
	VisionDescribeBackend,
	VisionDescribeRequest,
	VisionDescribeResult,
} from "./types";

export interface LlamaServerVisionBackendOptions {
	/**
	 * Base URL of the llama-server. The dflash-server wrapper exposes
	 * this via `currentBaseUrl()`; pass the resolved URL here at load
	 * time. The backend keeps it as-is across calls.
	 */
	baseUrl: string;
	/**
	 * Optional fetch override. Tests inject a fake fetch; production
	 * uses global fetch. The signature mirrors `fetch` so the test
	 * surface is the same as the real one.
	 */
	fetch?: typeof fetch;
	/**
	 * Default `n_predict` budget when the caller doesn't specify
	 * `maxTokens`. 256 matches the description-length budget the
	 * Florence-2 / VisionManager path uses today.
	 */
	defaultMaxTokens?: number;
}

export function createLlamaServerVisionBackend(
	opts: LlamaServerVisionBackendOptions,
): VisionDescribeBackend {
	const fetchImpl = opts.fetch ?? globalThis.fetch;
	const defaultMaxTokens = opts.defaultMaxTokens ?? 256;
	let baseUrl = opts.baseUrl.replace(/\/$/, "");

	if (!baseUrl) {
		throw new Error(
			"[vision/llama-server] baseUrl is required; pass dflash-server's currentBaseUrl()",
		);
	}

	return {
		id: "llama-server",
		async describe(
			request: VisionDescribeRequest,
		): Promise<VisionDescribeResult> {
			const { bytes, mimeType } = resolveImageBytes(request.image);
			const base64 = Buffer.from(bytes).toString("base64");
			const prompt = buildVisionPrompt(request.prompt);
			const startMs = Date.now();
			const body = JSON.stringify({
				prompt,
				image_data: [{ data: base64, id: 12 }],
				n_predict: request.maxTokens ?? defaultMaxTokens,
				temperature: request.temperature ?? 0.2,
				stream: false,
				// `cache_prompt: false` here so each describe call gets a
				// fresh slot; the WS1 vision-embedding cache handles repeat-
				// frame reuse on the JS side, and the server-side prompt
				// cache would only conflict with that (different KV state
				// for the same projector tokens).
				cache_prompt: false,
			});
			const res = await fetchImpl(`${baseUrl}/completion`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(mimeType ? { "x-image-mime": mimeType } : {}),
				},
				body,
				signal: request.signal,
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "<unreadable>");
				throw new Error(
					`[vision/llama-server] /completion returned ${res.status}: ${text.slice(0, 200)}`,
				);
			}
			const payload = (await res.json()) as {
				content?: unknown;
				timings?: { prompt_ms?: number; predicted_ms?: number };
			};
			if (typeof payload.content !== "string") {
				throw new Error(
					"[vision/llama-server] /completion response missing string `content`",
				);
			}
			const elapsed = Date.now() - startMs;
			return shape(payload.content, {
				projectorMs: payload.timings?.prompt_ms,
				decodeMs: payload.timings?.predicted_ms ?? elapsed,
				cacheHit: false,
			});
		},
		async dispose() {
			// llama-server lifetime is owned by the dflash-server wrapper.
			// This backend just holds the baseUrl; nothing to free.
			baseUrl = "";
		},
	};
}

function buildVisionPrompt(userPrompt?: string): string {
	const ask = userPrompt?.trim() || "Describe what is in this image.";
	// `[img-N]` is the placeholder llama-server's mtmd path replaces with
	// the encoded image tokens. The `N` must match the `image_data[*].id`
	// we send in the body; we use 12 because llama-server's stock
	// example uses small integer ids — any positive integer works.
	return `<|im_start|>user\n[img-12]\n${ask}<|im_end|>\n<|im_start|>assistant\n`;
}

function shape(
	text: string,
	telemetry: { projectorMs?: number; decodeMs?: number; cacheHit?: boolean },
): VisionDescribeResult {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("[vision/llama-server] empty text from /completion");
	}
	const title = trimmed.split(/[.!?]/, 1)[0]?.trim() || "Image";
	return {
		title,
		description: trimmed,
		...telemetry,
	};
}
