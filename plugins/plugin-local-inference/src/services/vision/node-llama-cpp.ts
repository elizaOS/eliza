/**
 * node-llama-cpp vision-describe backend (WS2).
 *
 * Wraps the in-process node-llama-cpp binding's multimodal projector
 * (mtmd) surface and exposes the WS2 `VisionDescribeBackend` contract.
 *
 * State of the binding (2026-05-13):
 *   The upstream `node-llama-cpp` 3.x TypeScript API does NOT yet
 *   expose llama.cpp's mtmd (multi-modal definition) helpers
 *   (`mtmd_init_from_file`, `mtmd_bitmap_init`, `mtmd_encode_chunks`,
 *   `llama_decode_with_chunks`). The native C++ side has had them since
 *   b8198; the binding will add them in a follow-up release once the
 *   elizaOS fork lands the typed wrappers (tracked in elizaOS/node-llama-cpp).
 *
 * What this module does today:
 *   - Provides the WS2-shaped backend so plugin-vision / plugin-image-gen /
 *     computer-use can compile against a stable contract.
 *   - When the binding exposes the mtmd API, the backend dispatches
 *     through it.
 *   - Otherwise, the backend falls back to the existing
 *     `VisionManager` (Florence-2 via @huggingface/transformers) when
 *     it's available; that path is what the legacy
 *     `LocalAIManager.describeImage` already uses for IMAGE_DESCRIPTION.
 *   - When neither path is wired, `describe()` throws a structured
 *     `VisionBackendUnavailableError` the arbiter surfaces upward.
 *
 * Metal / CUDA / QNN validation status (this host has neither GPU):
 *   The mtmd encode path is GPU-accelerated when the underlying llama.cpp
 *   build dispatches `llama_image_t` through the model's batch path. We
 *   document the on-device validation that's required for each GPU
 *   family at the bottom of this file's tests (see
 *   `__tests__/vision-describe.test.ts`). Until those run on real hardware,
 *   GPU-backed vision is "implementation present, not validated".
 */

import { existsSync, promises as fs } from "node:fs";
import { resolveImageBytes } from "./hash";
import type {
	VisionDescribeBackend,
	VisionDescribeBackendOptions,
	VisionDescribeLoadArgs,
	VisionDescribeRequest,
	VisionDescribeResult,
} from "./types";

export class VisionBackendUnavailableError extends Error {
	readonly code = "VISION_BACKEND_UNAVAILABLE";
	constructor(
		readonly backendId: string,
		readonly reason:
			| "binding_missing_mtmd"
			| "no_fallback_present"
			| "mmproj_missing",
		message: string,
	) {
		super(message);
		this.name = "VisionBackendUnavailableError";
	}
}

/**
 * Optional shape the elizaOS fork of node-llama-cpp will expose once
 * the mtmd typed wrappers land. We keep the shape narrow on purpose —
 * the backend only consumes `describeWithMmproj`, which is the binding's
 * planned single-call wrapper around mtmd_encode + decode. Backends
 * that don't satisfy this shape are treated as "binding without mtmd
 * support" and the fallback path is used.
 */
export interface NodeLlamaCppMtmdBinding {
	loadVisionModel(args: {
		modelPath: string;
		mmprojPath: string;
		gpuLayers?: number | "auto" | "max";
		contextSize?: number;
	}): Promise<NodeLlamaCppMtmdHandle>;
}

export interface NodeLlamaCppMtmdHandle {
	describeWithMmproj(args: {
		imageBytes: Uint8Array;
		mimeType?: string;
		prompt: string;
		maxTokens?: number;
		temperature?: number;
		signal?: AbortSignal;
		projectedTokens?: VisionDescribeBackendOptions["projectedTokens"];
	}): Promise<{ text: string; projectorMs?: number; decodeMs?: number }>;
	dispose(): Promise<void>;
}

/**
 * Optional VisionManager-shape fallback. The existing
 * `adapters/node-llama-cpp/utils/visionManager.ts` exposes
 * `processImage(dataUrl)` — when neither the fork mtmd binding nor a
 * test injection is wired, the WS2 backend dispatches to it as the
 * last resort.
 */
export interface VisionManagerLike {
	processImage(
		dataUrl: string,
	): Promise<{ title: string; description: string }>;
}

export interface NodeLlamaCppVisionBackendOptions {
	loadArgs: VisionDescribeLoadArgs;
	/**
	 * Injected by tests and (eventually) by the elizaOS fork's typed
	 * wrappers. When provided the backend uses the mtmd path.
	 */
	mtmd?: NodeLlamaCppMtmdBinding;
	/**
	 * Florence-2 fallback. Optional — when present the backend uses it
	 * as last resort, after mtmd. Backends that have neither throw a
	 * structured `VisionBackendUnavailableError`.
	 */
	visionManager?: VisionManagerLike;
}

const DEFAULT_PROMPT = "Describe what is in this image.";

export async function loadNodeLlamaCppVisionBackend(
	opts: NodeLlamaCppVisionBackendOptions,
): Promise<VisionDescribeBackend> {
	const { loadArgs, mtmd, visionManager } = opts;

	if (mtmd) {
		// Validate mmproj presence here so we surface a clean error before
		// burning a load (the binding's own error would be cryptic).
		if (!existsSync(loadArgs.mmprojPath)) {
			throw new VisionBackendUnavailableError(
				"node-llama-cpp",
				"mmproj_missing",
				`[vision/node-llama-cpp] mmproj GGUF not found: ${loadArgs.mmprojPath}`,
			);
		}
		const handle = await mtmd.loadVisionModel({
			modelPath: loadArgs.modelPath,
			mmprojPath: loadArgs.mmprojPath,
			gpuLayers: loadArgs.gpuLayers,
			contextSize: loadArgs.contextSize,
		});
		return {
			id: "node-llama-cpp",
			async describe(
				request: VisionDescribeRequest,
				args?: VisionDescribeBackendOptions,
			): Promise<VisionDescribeResult> {
				const { bytes, mimeType } = resolveImageBytes(request.image);
				const result = await handle.describeWithMmproj({
					imageBytes: bytes,
					mimeType,
					prompt: request.prompt ?? DEFAULT_PROMPT,
					maxTokens: request.maxTokens,
					temperature: request.temperature,
					signal: request.signal,
					projectedTokens: args?.projectedTokens,
				});
				return shapeResult(result.text, {
					projectorMs: result.projectorMs,
					decodeMs: result.decodeMs,
					cacheHit: Boolean(args?.projectedTokens),
				});
			},
			async dispose() {
				await handle.dispose();
			},
		};
	}

	if (visionManager) {
		return {
			id: "node-llama-cpp",
			async describe(
				request: VisionDescribeRequest,
			): Promise<VisionDescribeResult> {
				const dataUrl = await imageInputToDataUrl(request.image);
				const result = await visionManager.processImage(dataUrl);
				return {
					title: result.title,
					description: result.description,
					cacheHit: false,
				};
			},
			async dispose() {
				// VisionManager is a process-singleton owned by LocalAIManager;
				// its lifetime is decoupled from the WS2 backend. Disposing the
				// backend here is a no-op — the manager stays warm for legacy
				// callers that haven't moved off LocalAIManager.describeImage yet.
			},
		};
	}

	throw new VisionBackendUnavailableError(
		"node-llama-cpp",
		"binding_missing_mtmd",
		"[vision/node-llama-cpp] no mtmd binding and no VisionManager fallback was provided. Install the elizaOS fork build of node-llama-cpp that ships mtmd, or pass a VisionManager fallback in options.",
	);
}

function shapeResult(
	text: string,
	telemetry: { projectorMs?: number; decodeMs?: number; cacheHit?: boolean },
): VisionDescribeResult {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("[vision/node-llama-cpp] backend returned empty text");
	}
	const title = trimmed.split(/[.!?]/, 1)[0]?.trim() || "Image";
	return {
		title,
		description: trimmed,
		...telemetry,
	};
}

async function imageInputToDataUrl(
	input: VisionDescribeRequest["image"],
): Promise<string> {
	switch (input.kind) {
		case "dataUrl":
			return input.dataUrl;
		case "base64":
			return `data:${input.mimeType ?? "image/png"};base64,${input.base64}`;
		case "bytes": {
			const mimeType = input.mimeType ?? "image/png";
			const base64 = Buffer.from(input.bytes).toString("base64");
			return `data:${mimeType};base64,${base64}`;
		}
		case "url": {
			// Local file URLs are common in the computer-use path. Treat
			// `file://...` and bare paths uniformly — read the bytes and
			// reencode as a data URL.
			const url = input.url;
			if (url.startsWith("data:")) return url;
			if (url.startsWith("file://") || url.startsWith("/")) {
				const filePath = url.startsWith("file://") ? url.slice(7) : url;
				const bytes = await fs.readFile(filePath);
				const mimeType = input.mimeType ?? guessMimeFromPath(filePath);
				return `data:${mimeType};base64,${bytes.toString("base64")}`;
			}
			// Real HTTP(S) URL — fetch it. We can't avoid HTTP here for the
			// VisionManager path because Florence-2 expects a dataUrl.
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(
					`[vision/node-llama-cpp] failed to fetch image: ${res.status} ${res.statusText}`,
				);
			}
			const buf = new Uint8Array(await res.arrayBuffer());
			const mimeType =
				input.mimeType ?? res.headers.get("content-type") ?? "image/png";
			return `data:${mimeType};base64,${Buffer.from(buf).toString("base64")}`;
		}
	}
}

function guessMimeFromPath(p: string): string {
	const lower = p.toLowerCase();
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/png";
}
