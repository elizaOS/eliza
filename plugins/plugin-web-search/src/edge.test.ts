/** Exercises the genuine edge plugin at its deterministic network boundary. */

import type { IAgentRuntime, Memory } from "@elizaos/core/edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    runWebSearchEdge,
    webSearchEdgeAction,
    webSearchEdgePlugin,
    webSearchSourceEvidence,
    webSearchSourceUrls,
} from "./edge";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

describe("webSearchEdgePlugin", () => {
    it("exports one Worker-safe public read action", () => {
        expect(webSearchEdgePlugin.actions).toEqual([webSearchEdgeAction]);
        expect(webSearchEdgeAction.roleGate).toEqual({ minRole: "GUEST" });
    });

    it("returns bounded keyless results through the genuine action", async () => {
        globalThis.fetch = vi.fn(async () =>
            Response.json({
                jsonrpc: "2.0",
                id: 1,
                result: {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                results: [
                                    {
                                        url: "https://example.com/current",
                                        title: "Current public result",
                                    },
                                ],
                            }),
                        },
                    ],
                },
            })
        ) as typeof fetch;

        const result = await webSearchEdgeAction.handler(
            {} as IAgentRuntime,
            {} as Memory,
            undefined,
            { parameters: { query: "current public result", numResults: 4 } }
        );

        expect(result).toMatchObject({
            success: true,
            data: {
                actionName: "WEB_SEARCH",
                provider: "parallel",
                query: "current public result",
                observedAt: expect.any(Number),
                sourceUrls: ["https://example.com/current"],
                sources: [
                    {
                        url: "https://example.com/current",
                        text: expect.stringContaining("Current public result"),
                    },
                ],
            },
        });
    });

    it("extracts structured and prose source URLs without accepting credentials", () => {
        expect(
            webSearchSourceUrls(
                `${JSON.stringify({ results: [{ url: "https://example.com/a" }] })}\n` +
                    "Source: https://news.example.org/story). Ignore https://u:p@example.net/private"
            )
        ).toEqual(["https://example.com/a", "https://news.example.org/story"]);
    });

    it("rejects loopback and private-network citation URLs", () => {
        expect(
            webSearchSourceEvidence(
                JSON.stringify({
                    results: [
                        { url: "http://127.0.0.1/admin", text: "local" },
                        { url: "http://10.0.0.8/private", text: "private" },
                        { url: "https://public.example/result", text: "public" },
                    ],
                })
            )
        ).toMatchObject({
            sourceUrls: ["https://public.example/result"],
            sources: [
                {
                    url: "https://public.example/result",
                    text: expect.stringContaining("public"),
                },
            ],
        });
    });

    it("binds evidence to its containing result and bounds hostile traversal", () => {
        expect(
            webSearchSourceEvidence(
                JSON.stringify({
                    results: [
                        { url: "https://example.com/a", text: "value A 10 USD" },
                        { url: "https://example.com/b", text: "value B 20 USD" },
                    ],
                })
            ).sources
        ).toEqual([
            {
                url: "https://example.com/b",
                text: expect.stringContaining("value B 20 USD"),
            },
            {
                url: "https://example.com/a",
                text: expect.stringContaining("value A 10 USD"),
            },
        ]);
        const nested: Record<string, unknown> = {};
        let cursor = nested;
        for (let index = 0; index < 520; index += 1) {
            const next: Record<string, unknown> = {};
            cursor.next = next;
            cursor = next;
        }
        expect(webSearchSourceEvidence(JSON.stringify(nested))).toMatchObject({
            sources: [],
            overflowed: true,
        });
    });

    it("does not bind nested result prose to a parent URL", () => {
        const evidence = webSearchSourceEvidence(
            JSON.stringify({
                url: "https://example.com/collection",
                title: "Collection",
                results: [
                    { url: "https://example.com/a", text: "value A 10 USD" },
                    { url: "https://example.com/b", text: "value B 20 USD" },
                ],
            })
        );
        expect(evidence.sources).toContainEqual({
            url: "https://example.com/collection",
            text: expect.not.stringContaining("value A 10 USD"),
        });
        expect(evidence.sources).toContainEqual({
            url: "https://example.com/a",
            text: expect.stringContaining("value A 10 USD"),
        });
    });

    it("does not emit raw successful provider text through the channel callback", async () => {
        const callback = vi.fn();
        globalThis.fetch = vi.fn(async () =>
            Response.json({
                jsonrpc: "2.0",
                id: 1,
                result: {
                    content: [
                        {
                            type: "text",
                            text: '{"results":[{"url":"https://example.com/a","text":"secret-looking provider prose"}]}',
                        },
                    ],
                },
            })
        ) as typeof fetch;

        await webSearchEdgeAction.handler(
            {} as IAgentRuntime,
            {} as Memory,
            undefined,
            { parameters: { query: "public result" } },
            callback
        );

        expect(callback).not.toHaveBeenCalled();
    });

    it("exposes the same traceable receipt through the direct edge runner", async () => {
        globalThis.fetch = vi.fn(async () =>
            Response.json({
                jsonrpc: "2.0",
                id: 1,
                result: {
                    content: [
                        {
                            type: "text",
                            text: '{"results":[{"url":"https://weather.example/current"}]}',
                        },
                    ],
                },
            })
        ) as typeof fetch;

        await expect(runWebSearchEdge("weather now")).resolves.toMatchObject({
            success: true,
            data: {
                actionName: "WEB_SEARCH",
                query: "weather now",
                sourceUrls: ["https://weather.example/current"],
            },
        });
    });

    it("retains the attempted query when public search is unavailable", async () => {
        globalThis.fetch = vi.fn(
            async () => new Response("unavailable", { status: 503 })
        ) as typeof fetch;

        const result = await webSearchEdgeAction.handler(
            {} as IAgentRuntime,
            {} as Memory,
            undefined,
            { parameters: { query: "Tessera architecture" } }
        );

        expect(result).toMatchObject({
            success: false,
            text: "Web search is temporarily unavailable.",
            data: {
                actionName: "WEB_SEARCH",
                query: "Tessera architecture",
            },
        });
    });
});
