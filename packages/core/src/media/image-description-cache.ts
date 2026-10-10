/** Image analysis cache for immutable media and the complete analysis prompt. */

import { ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { createHash } from "../utils/crypto-compat.js";
import { resolveSetting } from "../utils/environment.js";
import { parseJSONObjectFromText } from "../utils/json5-model-output.js";
import { trustedLocalMediaUrl } from "./local-store.js";

export interface CachedImageDescription {
	title: string;
	description: string;
	text: string;
}
const CACHE_VERSION = "v4";
function imageDescriptionCacheKey(
	runtime: IAgentRuntime,
	imageUrl: string,
	prompt: string,
): string {
	const models = runtime
		.getModelRegistrations()
		.filter(
			(registration) => registration.modelType === ModelType.IMAGE_DESCRIPTION,
		)
		.map(({ provider, priority, metadata }) => ({
			provider,
			priority,
			metadata,
			settings: [
				...(metadata?.displayModelSettings ?? []),
				metadata?.displayModelSetting,
			]
				.filter((key): key is string => typeof key === "string")
				.map((key) => [key, resolveSetting(runtime, key)]),
		}));
	return `img-desc:${CACHE_VERSION}:${createHash("sha256")
		.update(JSON.stringify([imageUrl, prompt, models]))
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
async function getCachedImageDescription(
	runtime: IAgentRuntime,
	imageUrl: string,
	cacheKey: string,
): Promise<CachedImageDescription | undefined> {
	const cached = await runtime
		.getCache<CachedImageDescription>(cacheKey)
		// error-policy:J7 diagnostics-must-not-kill-the-loop — a read failure
		// degrades to a cache miss (re-describe), but a dead cache melts model
		// spend silently, so surface it. `undefined` = treat as miss.
		.catch((err) => {
			runtime.reportError("ImageDescriptionCache.get", err, { imageUrl });
			return undefined;
		});
	return cached ? (normalizeImageDescription(cached) ?? undefined) : undefined;
}
async function setCachedImageDescription(
	runtime: IAgentRuntime,
	imageUrl: string,
	value: CachedImageDescription,
	cacheKey: string,
): Promise<void> {
	if (!value.description && !value.text) return;
	await runtime
		.setCache(cacheKey, value)
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
	let response: unknown;
	let cacheKey: string | undefined;
	try {
		// Mutable remote URLs must be analyzed again; a URL alone is not a content identity.
		const cacheable =
			url.startsWith("data:") || trustedLocalMediaUrl(url) !== null;
		if (cacheable) {
			cacheKey = imageDescriptionCacheKey(runtime, url, prompt);
			const cached = await getCachedImageDescription(runtime, url, cacheKey);
			if (cached) return cached;
		}
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
	if (cacheKey)
		await setCachedImageDescription(runtime, url, normalized, cacheKey);
	return normalized;
}
