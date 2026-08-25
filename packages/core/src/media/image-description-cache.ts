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
import type { IAgentRuntime } from "../types/index.ts";
import { ModelType } from "../types/index.ts";
import { createHash } from "../utils/crypto-compat";
import { parseJSONObjectFromText } from "../utils.ts";

export interface CachedImageDescription {
	title: string;
	description: string;
	text: string;
}

const CACHE_VERSION = "v2";

export function imageDescriptionCacheKey(imageUrl: string): string {
	// SHA-256, not a truncated non-crypto hash: this key is a persistent
	// content address across agents' cache namespaces, so a collision would
	// permanently serve one image's description for a different image.
	return `img-desc:${CACHE_VERSION}:${createHash("sha256")
		.update(imageUrl)
		.digest("hex")}`;
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
	return cached ? (normalizeImageDescription(cached) ?? undefined) : undefined;
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
		// error-policy:J4 callers explicitly render image-description
		// unavailability; report the model failure before returning that state.
		runtime.reportError("ImageDescriptionCache.describe", error, {
			imageUrl: url,
		});
		return null;
	}

	const normalized = normalizeImageDescription(response);
	if (!normalized) return null;
	await setCachedImageDescription(runtime, url, normalized);
	return normalized;
}
