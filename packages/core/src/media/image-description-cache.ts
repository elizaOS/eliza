import type { IAgentRuntime } from "../types/index.ts";
import { ModelType } from "../types/index.ts";
import { parseJSONObjectFromText } from "../utils.ts";

/**
 * Shared content-addressed cache for image descriptions.
 *
 * The runtime describes an image (IMAGE_DESCRIPTION vision model) from several
 * places — inbound attachment processing, on-demand `ATTACHMENT action=read`,
 * and the standalone basic-capabilities helper. Without a shared cache the same
 * image is re-described on every path and every turn, which is slow and costs
 * tokens. Keying on the resolved image URL (a `data:` URL for inline bytes, or
 * the served/remote URL) means identical bytes resolve to one cached
 * description reused everywhere.
 */

export interface CachedImageDescription {
	title: string;
	description: string;
	text: string;
}

const CACHE_VERSION = "v1";

/** Browser/edge-safe FNV-1a (no `node:crypto`) for the cache key. */
function fnv1aHex(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

export function imageDescriptionCacheKey(imageUrl: string): string {
	return `img-desc:${CACHE_VERSION}:${fnv1aHex(imageUrl)}`;
}

/** Coerce any IMAGE_DESCRIPTION model response into a uniform description shape. */
export function normalizeImageDescription(
	response: unknown,
): CachedImageDescription | null {
	if (typeof response === "string") {
		const parsed = parseJSONObjectFromText(response) as {
			title?: unknown;
			description?: unknown;
			text?: unknown;
		} | null;
		if (
			parsed &&
			(typeof parsed.description === "string" ||
				typeof parsed.text === "string")
		) {
			const description =
				typeof parsed.description === "string" ? parsed.description : "";
			const text = typeof parsed.text === "string" ? parsed.text : "";
			return {
				title: typeof parsed.title === "string" ? parsed.title : "Image",
				description: description || text,
				text: text || description,
			};
		}
		const trimmed = response.trim();
		return trimmed
			? { title: "Image", description: trimmed, text: trimmed }
			: null;
	}
	if (response && typeof response === "object") {
		const obj = response as {
			title?: unknown;
			description?: unknown;
			text?: unknown;
		};
		const description =
			typeof obj.description === "string" ? obj.description : "";
		const text = typeof obj.text === "string" ? obj.text : "";
		if (description || text || typeof obj.title === "string") {
			return {
				title: typeof obj.title === "string" ? obj.title : "Image",
				description: description || text,
				text: text || description,
			};
		}
	}
	return null;
}

export async function getCachedImageDescription(
	runtime: IAgentRuntime,
	imageUrl: string,
): Promise<CachedImageDescription | undefined> {
	const cached = await runtime
		.getCache<CachedImageDescription>(imageDescriptionCacheKey(imageUrl))
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a read failure
		// degrades to a cache miss (re-describe), but a dead cache melts model
		// spend silently, so surface it. `undefined` = treat as miss.
		.catch((err) => {
			runtime.reportError("ImageDescriptionCache.get", err, { imageUrl });
			return undefined;
		});
	if (cached && (cached.description || cached.text)) {
		return {
			title: cached.title || "Image",
			description: cached.description ?? "",
			text: cached.text ?? cached.description ?? "",
		};
	}
	return undefined;
}

export async function setCachedImageDescription(
	runtime: IAgentRuntime,
	imageUrl: string,
	value: CachedImageDescription,
): Promise<void> {
	if (!value.description && !value.text) return;
	await runtime
		.setCache(imageDescriptionCacheKey(imageUrl), value)
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a failed cache
		// write must not abort the describe call, but a dead cache melts model
		// spend silently, so surface it.
		.catch((err) =>
			runtime.reportError("ImageDescriptionCache.set", err, { imageUrl }),
		);
}

/**
 * Describe an image, reusing and populating the shared cache. Returns the
 * cached result on a hit; otherwise calls the vision model once, caches, and
 * returns it. Returns null when the model is unavailable, errors, or yields no
 * usable description (callers decide the fallback).
 */
export async function describeImageCached(
	runtime: IAgentRuntime,
	imageUrl: string,
	prompt: string,
): Promise<CachedImageDescription | null> {
	const url = imageUrl.trim();
	if (!url) return null;

	const cached = await getCachedImageDescription(runtime, url);
	if (cached) return cached;

	let response: unknown;
	try {
		response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
			prompt,
			imageUrl: url,
			stream: false,
		});
	} catch (error) {
		runtime.logger.warn(
			{
				src: "media:image-description-cache",
				error: error instanceof Error ? error.message : String(error),
			},
			"Image description model call failed",
		);
		return null;
	}

	const normalized = normalizeImageDescription(response);
	if (!normalized) return null;
	await setCachedImageDescription(runtime, url, normalized);
	return normalized;
}
