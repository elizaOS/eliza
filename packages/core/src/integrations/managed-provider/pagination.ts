/**
 * Cursor pagination helper for provider adapters. Providers hand back opaque
 * cursors; this walker rejects repeated cursors and enforces only the explicit
 * limits selected by its caller.
 */

import { ManagedProviderError } from "./errors";

export interface ProviderPage<T> {
	items: readonly T[];
	/** Opaque continuation cursor; null when the listing is complete. */
	nextCursor: string | null;
}

export interface CollectProviderPagesOptions {
	/** Optional ceiling on fetched pages for deliberately partial operations. */
	maxPages?: number;
	/** Ceiling on accumulated items; default 1000. */
	maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 1_000;

/**
 * Drains a cursor-paginated listing into one bounded array. `fetchPage`
 * receives `undefined` for the first page and the provider cursor afterwards.
 */
export async function collectProviderPages<T>(
	fetchPage: (cursor: string | undefined) => Promise<ProviderPage<T>>,
	options: CollectProviderPagesOptions = {},
): Promise<T[]> {
	const maxPages = options.maxPages;
	const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
	if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
		throw new ManagedProviderError("The pagination page limit is invalid.", {
			code: "INVALID_INPUT",
		});
	}
	if (!Number.isInteger(maxItems) || maxItems < 1) {
		throw new ManagedProviderError("The pagination item limit is invalid.", {
			code: "INVALID_INPUT",
		});
	}
	const seenCursors = new Set<string>();
	const items: T[] = [];
	let cursor: string | undefined;
	let page = 0;
	while (true) {
		if (maxPages !== undefined && page >= maxPages) {
			throw new ManagedProviderError(
				"The provider listing exceeded the page limit.",
				{ code: "PAGINATION_OVERFLOW", context: { maxPages } },
			);
		}
		page += 1;
		const result = await fetchPage(cursor);
		items.push(...result.items);
		if (items.length > maxItems) {
			throw new ManagedProviderError(
				"The provider listing exceeded the item limit.",
				{ code: "PAGINATION_OVERFLOW", context: { maxItems } },
			);
		}
		if (result.nextCursor === null) return items;
		if (result.nextCursor.length === 0 || seenCursors.has(result.nextCursor)) {
			throw new ManagedProviderError(
				"The provider returned a repeated or empty pagination cursor.",
				{ code: "MALFORMED_RESPONSE" },
			);
		}
		seenCursors.add(result.nextCursor);
		cursor = result.nextCursor;
	}
}
