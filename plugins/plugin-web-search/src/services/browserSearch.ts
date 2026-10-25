/**
 * Searches through an explicitly authorized browser profile before API fallback.
 * Selection is side-effect free; after opening a tab, every read stays on that
 * target, profile and tab, and any failure propagates without another search.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { SearchOptions, SearchResponse } from "../types";

type Command = { subaction: "open" | "snapshot"; url: string; id?: string };
interface Dispatcher {
    resolveTarget(id: string, command: Command): Promise<unknown>;
    execute(command: Command, targetId: string): Promise<unknown>;
}
interface ProfileTarget {
    id: string;
    getProfileId(): string | null;
    supports(command: Command): boolean;
}
interface PageFrame {
    frameId: number;
    url: string;
    title: string;
    text: string;
    readyState: string;
    elements: Array<{ href?: string | null; label?: string | null; heading?: string | null }>;
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatcher(value: unknown): value is Dispatcher {
    return (
        record(value) &&
        typeof value.resolveTarget === "function" &&
        typeof value.execute === "function"
    );
}

function profileTarget(value: unknown): value is ProfileTarget {
    return (
        record(value) &&
        typeof value.id === "string" &&
        typeof value.getProfileId === "function" &&
        typeof value.supports === "function"
    );
}

function unavailable(message: string, context: Record<string, unknown> = {}): ElizaError {
    return new ElizaError(message, { code: "WEB_SEARCH_BROWSER_UNAVAILABLE", context });
}

function settingsString(runtime: IAgentRuntime, name: string): string | null {
    const value = runtime.getSetting(name);
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Provider-specific filters stay on the API path before any browser effects. */
function canSearchInBrowser(options?: SearchOptions): boolean {
    if (!options) return true;
    return Object.entries(options).every(
        ([name, value]) =>
            value === undefined ||
            name === "limit" ||
            name === "includeAnswer" ||
            (name === "offset" && value === 0) ||
            ((name === "type" || name === "topic") && value === "general") ||
            (name === "searchDepth" && value === "basic") ||
            (name === "includeImages" && value === false)
    );
}

function receipt(input: unknown, targetId: string, profileId: string): Record<string, unknown> {
    if (
        !record(input) ||
        input.targetId !== targetId ||
        !record(input.value) ||
        input.value.profileId !== profileId ||
        !record(input.value.result)
    ) {
        throw unavailable(
            "The browser reply did not match the authorized profile. The search was not replayed.",
            { targetId }
        );
    }
    return input.value.result;
}

function frames(value: unknown): PageFrame[] {
    if (!Array.isArray(value) || value.length === 0)
        throw unavailable("The browser returned no search-page frames.");
    return value.map((frame) => {
        if (
            !record(frame) ||
            frame.complete !== true ||
            typeof frame.frameId !== "number" ||
            typeof frame.url !== "string" ||
            typeof frame.title !== "string" ||
            typeof frame.text !== "string" ||
            typeof frame.readyState !== "string" ||
            !Array.isArray(frame.elements)
        )
            throw unavailable("The browser search-page snapshot was incomplete.");
        const elements = frame.elements.map((element) => {
            if (
                !record(element) ||
                (element.href !== undefined &&
                    element.href !== null &&
                    typeof element.href !== "string") ||
                (element.label !== undefined &&
                    element.label !== null &&
                    typeof element.label !== "string") ||
                (element.heading !== undefined &&
                    element.heading !== null &&
                    typeof element.heading !== "string")
            ) {
                throw unavailable("The browser returned invalid search-page link metadata.");
            }
            return { href: element.href, label: element.label, heading: element.heading };
        });
        return {
            frameId: frame.frameId,
            url: frame.url,
            title: frame.title,
            text: frame.text,
            readyState: frame.readyState,
            elements,
        };
    });
}

function resultLinks(page: PageFrame): Array<{ title: string; url: string }> {
    const links = new Map<string, { title: string; url: string }>();
    for (const element of page.elements) {
        if (!element.href || !element.heading?.trim()) continue;
        let url: URL;
        try {
            // error-policy:J3 Invalid page-controlled links are not usable search citations.
            url = new URL(element.href);
            if (url.origin === "https://www.google.com" && url.pathname === "/url") {
                const destination = url.searchParams.get("q") ?? url.searchParams.get("url");
                if (!destination) continue;
                url = new URL(destination);
            }
        } catch {
            // error-policy:J3 Keep all original page text while excluding invalid citation URLs.
            continue;
        }
        if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            (url.origin === "https://www.google.com" &&
                ["/search", "/preferences", "/advanced_search"].includes(url.pathname))
        )
            continue;
        links.set(url.href, { title: element.heading, url: url.href });
    }
    return [...links.values()];
}

/** Null means no eligible, explicitly authorized profile was dispatched. */
export async function searchAuthorizedBrowser(
    runtime: IAgentRuntime,
    query: string,
    options?: SearchOptions
): Promise<SearchResponse | null> {
    if (!canSearchInBrowser(options)) return null;
    const selection =
        typeof runtime.getCache === "function"
            ? await runtime.getCache<unknown>("browser.search-profile")
            : undefined;
    // A durable per-agent choice (including disabled) overrides advanced host settings.
    if (record(selection) && selection.disabled === true) return null;
    if (
        selection !== undefined &&
        (!record(selection) ||
            typeof selection.profileId !== "string" ||
            !selection.profileId.trim() ||
            typeof selection.targetId !== "string" ||
            !selection.targetId.trim())
    )
        throw unavailable(
            "The agent's saved browser search selection is invalid. Select a connected profile in Browser settings."
        );
    const profileId = record(selection)
        ? (selection.profileId as string)
        : settingsString(runtime, "WEB_SEARCH_BROWSER_PROFILE_ID");
    if (!profileId) return null;
    const targetId = record(selection)
        ? (selection.targetId as string)
        : (settingsString(runtime, "WEB_SEARCH_BROWSER_TARGET_ID") ?? "chromium-device");
    const service = runtime.getService("browser");
    if (!dispatcher(service)) return null;
    const url = new URL("https://www.google.com/search");
    url.searchParams.set("q", query);
    const open: Command = { subaction: "open", url: url.href };
    const target = await service.resolveTarget(targetId, open);
    if (
        !profileTarget(target) ||
        target.id !== targetId ||
        target.getProfileId() !== profileId ||
        !target.supports(open) ||
        !target.supports({ subaction: "snapshot", url: url.href })
    )
        return null;

    const opened = receipt(await service.execute(open, targetId), targetId, profileId);
    if (typeof opened.id !== "string" || !/^\d+$/.test(opened.id))
        throw unavailable("The browser did not return the search tab identity.", { targetId });
    const tabId = opened.id;
    const deadline = Date.now() + 15_000;
    let pageFrames: PageFrame[];
    for (;;) {
        if (target.getProfileId() !== profileId)
            throw unavailable("The authorized browser profile disconnected during search.", {
                targetId,
                tabId,
            });
        const result = receipt(
            await service.execute({ subaction: "snapshot", url: url.href, id: tabId }, targetId),
            targetId,
            profileId
        );
        if (result.id !== tabId)
            throw unavailable("The browser returned a different search tab.", { targetId, tabId });
        pageFrames = frames(result.frames);
        const main = pageFrames.find((frame) => frame.frameId === 0);
        if (!main)
            throw unavailable("The search page's main frame is missing.", { targetId, tabId });
        let observed: URL;
        try {
            observed = new URL(main.url);
        } catch {
            // error-policy:J3 Reject an invalid observed page identity.
            throw unavailable("The browser returned an invalid search-page URL.", {
                targetId,
                tabId,
            });
        }
        if (
            observed.origin !== url.origin ||
            observed.pathname !== url.pathname ||
            observed.searchParams.get("q") !== query
        ) {
            throw unavailable(
                "The search tab navigated away from the requested search. Inspect that browser tab before retrying.",
                { targetId, tabId, observedUrl: main.url }
            );
        }
        if (pageFrames.every((frame) => frame.readyState === "complete")) break;
        if (Date.now() >= deadline)
            throw unavailable(
                "The browser search page did not finish loading. No fallback search was sent.",
                { targetId, tabId }
            );
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const main = pageFrames.find((frame) => frame.frameId === 0);
    if (!main) throw unavailable("The search page's main frame is missing.");
    const links = resultLinks(main);
    if (links.length === 0)
        throw unavailable(
            "The search page did not expose result links. It may need consent or a human check; inspect the same tab.",
            { targetId, tabId, url: main.url }
        );
    const text = pageFrames.map((frame) => frame.text).join("\n\n");
    // An explicit caller result limit affects citations only; original observed
    // page text remains complete and the browser tab remains available to read.
    const selected = options?.limit === undefined ? links : links.slice(0, options.limit);
    return {
        query,
        answer: options?.includeAnswer === false ? undefined : text,
        images: [],
        results: selected.map((link, index) => ({
            ...link,
            description: link.title,
            content: link.title,
            rawContent: index === 0 ? text : undefined,
            score: 1 / (index + 1),
        })),
        browser: { targetId, profileId, tabId, url: main.url },
    };
}
