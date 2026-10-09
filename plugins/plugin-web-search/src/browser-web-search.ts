/** Host search routing preserves a selected browser profile and never replays a dispatched search. */
import type { IAgentRuntime } from "@elizaos/core";
import {
    type KeylessWebSearchOptions,
    type KeylessWebSearchResult,
    searchKeylessWeb,
} from "./keyless-web-search";
import { searchAuthorizedBrowser } from "./services/browserSearch";

export {
    isKeylessWebSearchUnavailableError,
    type KeylessWebSearchUnavailableError,
} from "./keyless-web-search";

/**
 * Resolves `null` for a successful zero-hit search. A keyless provider failure
 * throws `KeylessWebSearchUnavailableError` instead of looking empty.
 */
export async function searchBrowserFirstWeb(
    runtime: IAgentRuntime,
    query: string,
    options: KeylessWebSearchOptions = {}
): Promise<
    KeylessWebSearchResult | { provider: "browser"; text: string; truncated: false } | null
> {
    const result = await searchAuthorizedBrowser(runtime, query);
    if (result) return { provider: "browser", text: JSON.stringify(result), truncated: false };
    return (await searchKeylessWeb(query, options)) ?? null;
}
