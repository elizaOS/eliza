// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

import { describe, expect, test } from "bun:test";

import {
    isOllamaReachable,
    OllamaError,
    ollamaChat,
    ollamaCompleteOneShot,
} from "../src/providers/ollama.ts";

/** Build a fake fetch that returns the given response. */
function fakeFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) => {
        const url =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;
        return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch;
}

describe("isOllamaReachable", () => {
    test("returns true on 200", async () => {
        const fetchImpl = fakeFetch((url) => {
            expect(url).toContain("/api/version");
            return new Response('{"version":"0.17.0"}', { status: 200 });
        });
        expect(
            await isOllamaReachable({ baseUrl: "http://test", fetchImpl }),
        ).toBe(true);
    });

    test("returns false on network error", async () => {
        const fetchImpl = fakeFetch(() => {
            throw new Error("ECONNREFUSED");
        });
        expect(
            await isOllamaReachable({ baseUrl: "http://test", fetchImpl }),
        ).toBe(false);
    });

    test("returns false on non-2xx", async () => {
        const fetchImpl = fakeFetch(() => new Response("nope", { status: 500 }));
        expect(
            await isOllamaReachable({ baseUrl: "http://test", fetchImpl }),
        ).toBe(false);
    });
});

describe("ollamaChat", () => {
    test("posts to /api/chat with stream=false and returns the assistant message", async () => {
        const fetchImpl = fakeFetch((url, init) => {
            expect(url).toContain("/api/chat");
            const body = JSON.parse(String(init?.body ?? "{}"));
            expect(body.stream).toBe(false);
            expect(body.model).toBe("llama3.2:1b");
            return new Response(
                JSON.stringify({
                    model: "llama3.2:1b",
                    message: { role: "assistant", content: "hi there" },
                    done: true,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        });

        const response = await ollamaChat(
            {
                model: "llama3.2:1b",
                messages: [
                    { role: "system", content: "you are eliza" },
                    { role: "user", content: "hi" },
                ],
            },
            { baseUrl: "http://test", fetchImpl },
        );
        expect(response.message.content).toBe("hi there");
        expect(response.done).toBe(true);
    });

    test("throws OllamaError(unreachable) on network error", async () => {
        const fetchImpl = fakeFetch(() => {
            throw new Error("ECONNREFUSED");
        });
        try {
            await ollamaChat(
                {
                    model: "llama3.2:1b",
                    messages: [{ role: "user", content: "hi" }],
                },
                { baseUrl: "http://test", fetchImpl },
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(OllamaError);
            expect((err as OllamaError).code).toBe("unreachable");
        }
    });

    test("throws OllamaError(http) on non-2xx", async () => {
        const fetchImpl = fakeFetch(() => new Response("model not found", { status: 404 }));
        try {
            await ollamaChat(
                {
                    model: "missing-model",
                    messages: [{ role: "user", content: "hi" }],
                },
                { baseUrl: "http://test", fetchImpl },
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(OllamaError);
            expect((err as OllamaError).code).toBe("http");
        }
    });

    test("throws OllamaError(schema) on missing message.content", async () => {
        const fetchImpl = fakeFetch(
            () =>
                new Response(JSON.stringify({ model: "llama3.2:1b", done: true }), {
                    status: 200,
                }),
        );
        try {
            await ollamaChat(
                {
                    model: "llama3.2:1b",
                    messages: [{ role: "user", content: "hi" }],
                },
                { baseUrl: "http://test", fetchImpl },
            );
            throw new Error("expected throw");
        } catch (err) {
            expect(err).toBeInstanceOf(OllamaError);
            expect((err as OllamaError).code).toBe("schema");
        }
    });
});

describe("ollamaCompleteOneShot", () => {
    test("emits a system + user message pair and returns trimmed content", async () => {
        const fetchImpl = fakeFetch((_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}"));
            expect(body.messages).toHaveLength(2);
            expect(body.messages[0].role).toBe("system");
            expect(body.messages[1].role).toBe("user");
            return new Response(
                JSON.stringify({
                    model: "llama3.2:1b",
                    message: { role: "assistant", content: "  okay  " },
                    done: true,
                }),
                { status: 200 },
            );
        });
        const text = await ollamaCompleteOneShot(
            "you are eliza",
            "hi",
            { baseUrl: "http://test", fetchImpl },
        );
        expect(text).toBe("okay");
    });
});
