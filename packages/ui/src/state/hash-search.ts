/**
 * Knowledge half of the combined `#<query>` chat search.
 *
 * The native mobile agent does not serve the documents route, so the request
 * answers 404 there. For the combined search that must not discard the memory
 * results: the caller reports Knowledge as unavailable instead. Every other
 * failure (and a 404 off-device, which is a real routing fault) still throws.
 */
import { isApiError } from "../api/client-types-core";

export type CombinedKnowledgeSearch<T> =
  | { unavailable: false; result: T }
  | { unavailable: true; result: null };

export async function searchKnowledgeForCombinedSearch<T>(
  search: () => Promise<T>,
  options: { isNative: boolean },
): Promise<CombinedKnowledgeSearch<T>> {
  try {
    return { unavailable: false, result: await search() };
  } catch (err) {
    if (options.isNative && isApiError(err) && err.status === 404) {
      return { unavailable: true, result: null };
    }
    throw err;
  }
}
