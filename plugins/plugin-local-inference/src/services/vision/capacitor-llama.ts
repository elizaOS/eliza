/**
 * Capacitor-llama vision-describe backend (WS2).
 *
 * Wraps the in-process capacitor-llama binding's multimodal projector
 * (mtmd) surface and exposes the WS2 `VisionDescribeBackend` contract.
 *
 * State of the binding (2026-05-19):
 *   `llama-cpp-capacitor`'s `LlamaContext` exposes `initMultimodal` and
 *   `getMultimodalSupport`, which load an mmproj alongside the chat
 *   target. The desktop bun:ffi shim does not yet bind those symbols —
 *   the desktop FFI path returns `binding_missing_mtmd` until the shim
 *   adds `mtmd_init_from_file` + the encode/decode helpers.
 *
 * What this module does today:
 *   - Provides the WS2-shaped backend so plugin-vision / plugin-image-gen /
 *     computer-use can compile against a stable contract.
 *   - When the binding exposes the mtmd API, the backend dispatches
 *     through it.
 *   - Otherwise, the backend falls back to an injected
 *     `VisionManagerLike` implementation when one is supplied (kept as a
 *     pluggable seam for tests and out-of-tree integrations).
 *   - When neither path is wired, `describe()` throws a structured
 *     `VisionBackendUnavailableError` the arbiter surfaces upward.
 *
 * GPU validation status (this host has neither GPU):
 *   The mtmd encode path is GPU-accelerated when the underlying llama.cpp
 *   build dispatches `llama_image_t` through the model's batch path. We
 *   document the on-device validation that's required for each GPU
 *   family at the bottom of this file's tests (see
 *   `__tests__/vision-describe.test.ts`). Until those run on real
 *   hardware, GPU-backed vision is "implementation present, not
 *   validated".
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
 * Optional shape the Capacitor-llama binding exposes once the mtmd typed
 * wrappers land in the shared adapter. The backend only consumes
 * `describeWithMmproj`, which wraps `LlamaContext.initMultimodal` +
 * `completion(...)` with `media_paths`. Backends that don't satisfy this
 * shape are treated as "binding without mtmd support" and the fallback
 * path is used.
 */
export interface CapacitorLlamaMtmdBinding {
	loadVisionModel(args: {
		modelPath: string;
		mmprojPath: string;
		gpuLayers?: number | "auto" | "max";
		contextSize?: number;
	}): Promise<CapacitorLlamaMtmdHandle>;
}

export interface CapacitorLlamaMtmdHandle {
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
 * Optional VisionManager-shape fallback. Kept available as a pluggable
 * injection point for tests and out-of-tree integrations that want to
 * supply their own image captioning implementation.
 */
export interface VisionManagerLike {
	processImage(
		dataUrl: string,
	): Promise<{ title: string; description: string }>;
}

export interface CapacitorLlamaVisionBackendOptions {
	loadArgs: VisionDescribeLoadArgs;
	/**
	 * Injected by tests and by the shared mtmd typed wrappers. When
	 * provided the backend uses the mtmd path.
	 */
	mtmd?: CapacitorLlamaMtmdBinding;
	/**
	 * Caption-only fallback. Optional — when present the backend uses it
	 * as last resort, after mtmd. Backends that have neither throw a
	 * structured `VisionBackendUnavailableError`.
	 */
	visionManager?: VisionManagerLike;
}

const DEFAULT_PROMPT = "Describe what is in this image.";

export async function loadCapacitorLlamaVisionBackend(
	opts: CapacitorLlamaVisionBackendOptions,
): Promise<VisionDescribeBackend> {
	const { loadArgs, mtmd, visionManager } = opts;

	if (mtmd) {
		// Validate mmproj presence here so we surface a clean error before
		// burning a load (the binding's own error would be cryptic).
		if (!existsSync(loadArgs.mmprojPath)) {
			throw new VisionBackendUnavailableError(
				"capacitor-llama",
				"mmproj_missing",
				`[vision/capacitor-llama] mmproj GGUF not found: ${loadArgs.mmprojPath}`,
			);
		}
		const handle = await mtmd.loadVisionModel({
			modelPath: loadArgs.modelPath,
			mmprojPath: loadArgs.mmprojPath,
			gpuLayers: loadArgs.gpuLayers,
			contextSize: loadArgs.contextSize,
		});
		return {
			id: "capacitor-llama",
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
			id: "capacitor-llama",
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
		"capacitor-llama",
		"binding_missing_mtmd",
		"[vision/capacitor-llama] no mtmd binding and no VisionManager fallback was provided. Wire up the Capacitor-llama mtmd adapter (initMultimodal + media_paths completion) or pass a VisionManager fallback in options.",
	);
}

function shapeResult(
	text: string,
	telemetry: { projectorMs?: number; decodeMs?: number; cacheHit?: boolean },
): VisionDescribeResult {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new Error("[vision/capacitor-llama] backend returned empty text");
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
			const url = input.url;
			if (url.startsWith("data:")) return url;
			if (url.startsWith("file://") || url.startsWith("/")) {
				const filePath = url.startsWith("file://") ? url.slice(7) : url;
				const bytes = await fs.readFile(filePath);
				const mimeType = input.mimeType ?? guessMimeFromPath(filePath);
				return `data:${mimeType};base64,${bytes.toString("base64")}`;
			}
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(
					`[vision/capacitor-llama] failed to fetch image: ${res.status} ${res.statusText}`,
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
