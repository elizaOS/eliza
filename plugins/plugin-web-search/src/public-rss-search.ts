/** Public feed discovery. Feed descriptions are excerpts, not full article reads. */
import { SaxesParser } from "saxes";
import {
    isKeylessWebSearchUnavailableError,
    type KeylessWebSearchOptions,
    KeylessWebSearchUnavailableError,
    searchKeylessWeb,
} from "./keyless-web-search";

type FeedItem = { title: string; link: string; description: string; pubDate: string };

function parseFeed(xml: string): FeedItem[] {
    const parser = new SaxesParser({ xmlns: false });
    const items: FeedItem[] = [];
    let item: FeedItem | undefined;
    let field: keyof FeedItem | undefined;
    let depth = 0;
    let fieldDepth = 0;
    let rss = false;
    parser.on("doctype", () => {
        throw new Error("RSS document types are unsupported");
    });
    parser.on("opentag", (tag) => {
        depth += 1;
        if (depth === 1 && tag.name === "rss") rss = true;
        if (tag.name === "item") item = { title: "", link: "", description: "", pubDate: "" };
        else if (item && Object.hasOwn(item, tag.name)) {
            field = tag.name as keyof FeedItem;
            fieldDepth = depth;
        }
    });
    const append = (text: string) => {
        if (item && field) item[field] += text;
    };
    parser.on("text", append);
    parser.on("cdata", append);
    parser.on("closetag", (tag) => {
        if (tag.name === "item" && item) {
            items.push(item);
            item = undefined;
        }
        if (depth === fieldDepth) field = undefined;
        depth -= 1;
    });
    parser.write(xml).close();
    if (!rss) throw new Error("The provider did not return an RSS document");
    return items;
}

async function readFeed(
    name: string,
    url: URL,
    options: KeylessWebSearchOptions
): Promise<Record<string, unknown>[]> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await (options.fetchImpl ?? fetch)(url, {
        redirect: "error",
        signal,
        headers: { Accept: "application/rss+xml, application/xml, text/xml" },
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new KeylessWebSearchUnavailableError({
            provider: "public-http",
            reason: "http_error",
            status: response.status,
        });
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("RSS response has no body");
    const decoder = new TextDecoder();
    let xml = "";
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > (options.maxResponseBytes ?? 256 * 1024)) {
                await reader.cancel("RSS response exceeded byte limit");
                throw new KeylessWebSearchUnavailableError({
                    provider: "public-http",
                    reason: "response_too_large",
                });
            }
            xml += decoder.decode(chunk.value, { stream: true });
        }
        xml += decoder.decode();
    } finally {
        reader.releaseLock();
    }
    return parseFeed(xml).flatMap((item) => {
        let link: URL;
        try {
            link = new URL(item.link.trim());
            if (link.hostname === "www.bing.com" && link.pathname === "/news/apiclick.aspx") {
                link = new URL(link.searchParams.get("url") ?? "");
            }
        } catch {
            // error-policy:J3 Invalid feed links cannot be evidence sources.
            return [];
        }
        if (link.protocol !== "https:" || link.username || link.password) return [];
        const published = name !== "bing-web" ? Date.parse(item.pubDate) : Number.NaN;
        const publishedAt = Number.isFinite(published)
            ? new Date(published).toISOString()
            : undefined;
        return [
            {
                url: link.toString(),
                title: item.title,
                excerpts: [item.title, item.description],
                provider: name,
                sourceKind: publishedAt ? "public-rss-headline" : "public-rss-discovery",
                ...(publishedAt ? { publishedAt, publish_date: publishedAt } : {}),
                evidenceCoverage:
                    "Feed headline and description only; article contents have not been read.",
                dateAuthority: publishedAt
                    ? "Feed-reported publication date; not independently verified with the publisher."
                    : "No publisher date. Web feed dates may be crawl or index dates.",
            },
        ];
    });
}

/** Fallback applies to the public edge provider only, never a dispatched browser. */
export async function searchPublicWeb(query: string, options: KeylessWebSearchOptions = {}) {
    try {
        return await searchKeylessWeb(query, options);
    } catch (error) {
        options.signal?.throwIfAborted();
        if (
            !isKeylessWebSearchUnavailableError(error) ||
            !["network", "timeout", "rate_limited", "http_error"].includes(error.reason) ||
            (error.status !== undefined && error.status !== 429 && error.status < 500)
        )
            throw error;
        // error-policy:J2 Only public provider outages permit feed discovery.
        // Authentication denials, malformed evidence and cancellation do not.
        const web = new URL("https://www.bing.com/search");
        web.search = new URLSearchParams({ format: "rss", q: query }).toString();
        const news = new URL("https://www.bing.com/news/search");
        news.search = web.search;
        const google = new URL("https://news.google.com/rss/search");
        google.search = new URLSearchParams({
            q: query,
            hl: "en-US",
            gl: "US",
            ceid: "US:en",
        }).toString();
        const feeds = [
            ["bing-web", web],
            ["bing-news", news],
            ["google-news", google],
        ] as const;
        const results = await Promise.allSettled(
            feeds.map(([name, url]) => readFeed(name, url, options))
        );
        options.signal?.throwIfAborted();
        const sources = results.flatMap((result) =>
            result.status === "fulfilled" ? result.value : []
        );
        const unavailableFeeds = results.flatMap((result, index) =>
            result.status === "rejected" ? [feeds[index][0]] : []
        );
        if (!sources.length && unavailableFeeds.length) {
            // Preserve the original outage receipt when discovery cannot help.
            throw error;
        }
        if (!sources.length) return undefined;
        return {
            provider: "public-http" as const,
            truncated: false,
            text: JSON.stringify({
                sources,
                unavailableFeeds,
                coverage:
                    "Public feed discovery can miss sources and is not a complete current-news index.",
            }),
        };
    }
}
