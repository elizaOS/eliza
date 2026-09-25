/** Exercises the registered host action through real browser routing and deterministic transport boundaries. */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearchAction } from "../index";
import { searchAuthorizedBrowser } from "./browserSearch";

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

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});
function publicFallback() {
    const fetchMock = vi.fn(async () =>
        Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
                content: [
                    { type: "text", text: '{"results":[{"url":"https://public.example/result"}]}' },
                ],
            },
        })
    );
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchMock;
}
function search(selectedRuntime: IAgentRuntime) {
    return webSearchAction.handler(selectedRuntime, {} as Memory, undefined, {
        parameters: { query: "query" },
    });
}
describe("registered browser-first host action", () => {
    it("uses durable selection and retains the entire observed page", async () => {
        const browser = new BrowserFixture();
        browser.text = `${"complete content ".repeat(30_000)}final fact`;
        const selectedRuntime = runtime(browser);
        selectedRuntime.getCache = async <T>() =>
            ({ targetId: "chromium-device", profileId: "owner-profile" }) as T;
        const fallback = publicFallback();
        const result = await search(selectedRuntime);
        expect(result).toMatchObject({
            success: true,
            data: { provider: "browser", truncated: false, sources: [] },
        });
        if (!result || typeof result === "boolean" || !result.text)
            throw new Error("Expected search receipt");
        expect(JSON.parse(result.text).answer).toBe(browser.text);
        expect(browser.commands).toEqual([
            { subaction: "open", url: "https://www.google.com/search?q=query" },
            { subaction: "snapshot", id: "42", url: "https://www.google.com/search?q=query" },
        ]);
        expect(fallback).not.toHaveBeenCalled();
    });
    it.each(["disabled", "unavailable", "unselected", "wrong-profile"])(
        "uses fallback before dispatch when %s",
        async (mode) => {
            const browser = new BrowserFixture();
            browser.available = mode !== "unavailable";
            const selectedRuntime = runtime(
                browser,
                mode === "unselected"
                    ? {}
                    : {
                          WEB_SEARCH_BROWSER_PROFILE_ID:
                              mode === "wrong-profile" ? "other" : "owner-profile",
                      }
            );
            if (mode === "disabled")
                selectedRuntime.getCache = async <T>() => ({ disabled: true }) as T;
            const fallback = publicFallback();
            await expect(search(selectedRuntime)).resolves.toMatchObject({
                success: true,
                data: { provider: "parallel" },
            });
            expect(browser.commands).toEqual([]);
            expect(fallback).toHaveBeenCalledOnce();
        }
    );
    it.each(["open", "snapshot", "profile", "consent", "corrupt-selection"])(
        "does not replay a failed %s search",
        async (mode) => {
            const browser = new BrowserFixture();
            if (mode === "open") browser.openFailure = new Error("uncertain navigation");
            if (mode === "snapshot") browser.snapshotFailure = new Error("read failed");
            if (mode === "profile") browser.replyProfileId = "wrong-profile";
            if (mode === "consent") browser.pageUrl = "https://consent.google.com/";
            const selectedRuntime = runtime(browser, {
                WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile",
            });
            if (mode === "corrupt-selection")
                selectedRuntime.getCache = async <T>() => ({ profileId: 42 }) as T;
            const fallback = publicFallback();
            await expect(search(selectedRuntime)).rejects.toThrow();
            expect(fallback).not.toHaveBeenCalled();
            expect(browser.commands.filter((command) => command.subaction === "open")).toHaveLength(
                mode === "corrupt-selection" ? 0 : 1
            );
        }
    );
    it("preserves page content even when a direct caller limits citations", async () => {
        const browser = new BrowserFixture();
        browser.text = "long content ".repeat(30_000);
        const result = await searchAuthorizedBrowser(
            runtime(browser, { WEB_SEARCH_BROWSER_PROFILE_ID: "owner-profile" }),
            "query",
            { limit: 1, includeAnswer: false }
        );
        expect(result?.results).toHaveLength(1);
        expect(result?.results[0].rawContent).toBe(browser.text);
        expect(result?.answer).toBeUndefined();
    });
});
