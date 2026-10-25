/** Exercises the real edge facade and canonical Core host guards; no Core substitutions. */
import { describe, expect, it, vi } from "vitest";
import { fetchKeylessWeb } from "./edge";

function mcp(text: string): Response {
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
}

describe("public article fetch facade", () => {
    it("refuses blocked and private destinations before provider dispatch", async () => {
        const fetchImpl = vi.fn(async () => mcp("unused"));
        for (const url of [
            "http://localhost/article",
            "http://127.0.0.1/article",
            "http://10.0.0.1/article",
            "http://169.254.169.254/article",
            "http://[::1]/article",
            "http://[fc00::1]/article",
            "https://user:password@publisher.example/article",
            "file:///tmp/article",
        ]) {
            await expect(fetchKeylessWeb([url], { fetchImpl })).rejects.toThrow();
        }
        await expect(
            fetchKeylessWeb(["https://publisher.example/article", "http://127.0.0.1/article"], {
                fetchImpl,
            })
        ).rejects.toThrow();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("delegates canonical public articles to the single fixed anonymous transport", async () => {
        const payload = JSON.stringify({
            results: [{ url: "https://publisher.example/article", text: "Published article" }],
        });
        const fetchImpl = vi.fn(async () => mcp(payload));
        const result = await fetchKeylessWeb(["https://publisher.example/article"], { fetchImpl });
        expect(result?.text).toBe(payload);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
            "https://search.parallel.ai/mcp"
        );
    });
});
