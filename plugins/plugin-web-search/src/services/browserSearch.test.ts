/** Exercises the real browser-first search router against deterministic profile-bound browser receipts and an external API fixture. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchBrowserFirstWeb } from "../browser-web-search";
import { WebSearchService } from "./webSearchService";

const apiSearch = vi.hoisted(() => vi.fn());
vi.mock("@tavily/core", () => ({ tavily: () => ({ search: apiSearch }) }));

type Command = { subaction: string; id?: string; url: string };
class BrowserFixture {
    profileId = "owner-profile";
    replyProfileId = "owner-profile";
    commands: Command[] = [];
    openFailure: Error | null = null;
    snapshotFailure: Error | null = null;
    text = "Complete search content";
    pageUrl: string | null = null;
    available = true;
    getService() {
        return this;
    }
    async resolveTarget() {
        return this.available
            ? { id: "chromium-device", getProfileId: () => this.profileId, supports: () => true }
            : null;
    }
    async execute(command: Command) {
        this.commands.push(command);
        if (command.subaction === "open" && this.openFailure) throw this.openFailure;
        if (command.subaction === "snapshot" && this.snapshotFailure) throw this.snapshotFailure;
        return {
            targetId: "chromium-device",
            value: {
                profileId: this.replyProfileId,
                result:
                    command.subaction === "open"
                        ? { id: "42", dispatched: true }
                        : {
                              id: "42",
                              frames: [
                                  {
                                      frameId: 0,
                                      url: this.pageUrl ?? command.url,
                                      title: "Search",
                                      readyState: "complete",
                                      complete: true,
                                      text: this.text,
                                      elements: [
                                          {
                                              href: "https://example.com/first",
                                              heading: "First result",
                                              label: "First",
                                          },
                                          {
                                              href: "https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fsecond",
                                              heading: "Second result",
                                              label: "Second",
                                          },
                                          {
                                              href: "https://www.google.com/search?q=other",
                                              heading: "Other query",
                                          },
                                          { href: "javascript:alert(1)", heading: "Untrusted URL" },
                                          { href: null, label: "Search button", heading: null },
                                      ],
                                  },
                              ],
                          },
            },
        };
    }
}

function runtime(browser: BrowserFixture, settings: Record<string, string> = {}): IAgentRuntime {
    return {
        getSetting: (key: string) => settings[key],
        getService: () => browser,
    } as unknown as IAgentRuntime;
}

afterEach(() => apiSearch.mockReset());

describe("owner-authorized browser search", () => {
    it("uses the durable per-agent selection through the host keyless action path", async () => {
        const browser = new BrowserFixture();
        const selectedRuntime = runtime(browser);
        selectedRuntime.getCache = async <T>() =>
            ({ targetId: "chromium-device", profileId: "owner-profile" }) as T;
        const fetchImpl = vi.fn();
        const result = await searchBrowserFirstWeb(selectedRuntime, "query", { fetchImpl });
        expect(result?.provider).toBe("browser");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("explicitly disabling the per-agent selection overrides advanced host settings", async () => {
        const browser = new BrowserFixture();
        const selectedRuntime = runtime(browser, {
            WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
            TAVILY_API_KEY: "fixture",
        });
        selectedRuntime.getCache = async <T>() => ({ disabled: true }) as T;
        apiSearch.mockResolvedValue({ results: [] });
        const service = await WebSearchService.start(selectedRuntime);
        await service.search("query");
        expect(browser.commands).toEqual([]);
        expect(apiSearch).toHaveBeenCalledOnce();
    });

    it("works without an API key and pins all observations to the opened tab", async () => {
        const browser = new BrowserFixture();
        const service = await WebSearchService.start(
            runtime(browser, { WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile" })
        );
        const result = await service.search("elizaOS browser");
        expect(result.results.map((item) => item.url)).toEqual([
            "https://example.com/first",
            "https://example.org/second",
        ]);
        expect(result.browser).toEqual({
            targetId: "chromium-device",
            profileId: "owner-profile",
            tabId: "42",
            url: "https://www.google.com/search?q=elizaOS+browser",
        });
        expect(browser.commands).toEqual([
            { subaction: "open", url: "https://www.google.com/search?q=elizaOS+browser" },
            {
                subaction: "snapshot",
                url: "https://www.google.com/search?q=elizaOS+browser",
                id: "42",
            },
        ]);
        expect(apiSearch).not.toHaveBeenCalled();
    });

    it("reports corrupt persisted selection without dispatch or fallback", async () => {
        const browser = new BrowserFixture();
        const selectedRuntime = runtime(browser);
        selectedRuntime.getCache = async <T>() => ({ profileId: 42 }) as T;
        const fetchImpl = vi.fn();
        await expect(
            searchBrowserFirstWeb(selectedRuntime, "query", { fetchImpl })
        ).rejects.toThrow("saved browser search selection is invalid");
        expect(browser.commands).toEqual([]);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("preserves the complete observed page even when the caller limits citations", async () => {
        const browser = new BrowserFixture();
        browser.text = `${"long page content ".repeat(30_000)}final required fact`;
        const service = await WebSearchService.start(
            runtime(browser, { WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile" })
        );
        const result = await service.search("complete", { limit: 1, includeAnswer: false });
        expect(result.results).toHaveLength(1);
        expect(result.results[0].rawContent).toBe(browser.text);
        expect(result.answer).toBeUndefined();
    });

    it.each([undefined, "other-profile"])(
        "does not read a profile without its explicit grant (%s)",
        async (profile) => {
            const browser = new BrowserFixture();
            apiSearch.mockResolvedValue({ results: [] });
            const service = await WebSearchService.start(
                runtime(browser, {
                    TAVILY_API_KEY: "fixture",
                    ...(profile ? { WEB_SEARCH_BROWSER_PROFILE_ID: profile } : {}),
                })
            );
            await service.search("public query");
            expect(browser.commands).toEqual([]);
            expect(apiSearch).toHaveBeenCalledTimes(1);
        }
    );

    it("chooses the API before dispatch when no authorized device is available", async () => {
        const browser = new BrowserFixture();
        browser.available = false;
        apiSearch.mockResolvedValue({ results: [] });
        const service = await WebSearchService.start(
            runtime(browser, {
                TAVILY_API_KEY: "fixture",
                WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
            })
        );
        await service.search("query");
        expect(browser.commands).toEqual([]);
        expect(apiSearch).toHaveBeenCalledTimes(1);
    });

    it.each(["open", "snapshot"])(
        "never changes provider after a dispatched %s fails",
        async (action) => {
            const browser = new BrowserFixture();
            if (action === "open") browser.openFailure = new Error("uncertain navigation");
            else browser.snapshotFailure = new Error("read failed");
            const service = await WebSearchService.start(
                runtime(browser, {
                    TAVILY_API_KEY: "fixture",
                    WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
                })
            );
            await expect(service.search("query")).rejects.toThrow();
            expect(apiSearch).not.toHaveBeenCalled();
            expect(browser.commands.filter((command) => command.subaction === "open")).toHaveLength(
                1
            );
        }
    );

    it("rejects a receipt from another browser profile", async () => {
        const browser = new BrowserFixture();
        browser.replyProfileId = "wrong-profile";
        const service = await WebSearchService.start(
            runtime(browser, {
                TAVILY_API_KEY: "fixture",
                WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
            })
        );
        await expect(service.search("query")).rejects.toThrow("authorized profile");
        expect(browser.commands).toHaveLength(1);
        expect(apiSearch).not.toHaveBeenCalled();
    });

    it("rejects a login/consent redirect without reporting search success or replaying", async () => {
        const browser = new BrowserFixture();
        browser.pageUrl = "https://consent.google.com/";
        const service = await WebSearchService.start(
            runtime(browser, {
                TAVILY_API_KEY: "fixture",
                WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
            })
        );
        await expect(service.search("query")).rejects.toThrow("navigated away");
        expect(apiSearch).not.toHaveBeenCalled();
    });
});
