/** Exercises the genuine edge plugin at its deterministic network boundary. */

import type { IAgentRuntime, Memory } from "@elizaos/core/edge";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    runWebSearchEdge,
    webSearchEdgeAction,
    webSearchEdgePlugin,
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
