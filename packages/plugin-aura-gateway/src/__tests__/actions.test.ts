import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { travelAggregateAction, visionProcessAction } from "../actions.js";

function createMockRuntime(settings: Record<string, string> = {}) {
    return {
        getSetting: (key: string) => settings[key] ?? null
    } as any;
}

describe("AURA Gateway Plugin Actions", () => {
    it("validates presence of WALLET_PUBLIC_KEY without requiring private key", async () => {
        const validRuntime = createMockRuntime({ WALLET_PUBLIC_KEY: "0x1234567890abcdef" });
        const invalidRuntime = createMockRuntime({});

        assert.equal(await travelAggregateAction.validate(validRuntime, {} as any), true);
        assert.equal(await travelAggregateAction.validate(invalidRuntime, {} as any), false);
        assert.equal(await visionProcessAction.validate(validRuntime, {} as any), true);
    });

    it("rejects empty or oversized travel prompts before calling gateway", async () => {
        const runtime = createMockRuntime({ WALLET_PUBLIC_KEY: "0xabc" });
        const messages: string[] = [];
        const callback = async (res: any) => {
            messages.push(res.text);
            return [];
        };

        const emptyOk = await travelAggregateAction.handler(
            runtime,
            { content: { text: "   " } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(emptyOk, false);
        assert.match(String(messages.at(0)), /cannot be empty/i);

        const longOk = await travelAggregateAction.handler(
            runtime,
            { content: { text: "a".repeat(2005) } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(longOk, false);
        assert.match(String(messages.at(1)), /exceeds maximum length/i);
    });

    it("blocks non-HTTPS and localhost SSRF URLs in visionProcessAction", async () => {
        const runtime = createMockRuntime({ WALLET_PUBLIC_KEY: "0xabc" });
        const messages: string[] = [];
        const callback = async (res: any) => {
            messages.push(res.text);
            return [];
        };

        const httpResult = await visionProcessAction.handler(
            runtime,
            { content: { attachments: [{ url: "http://localhost:8080/secret.png" }] } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(httpResult, false);
        assert.match(String(messages.at(0)), /Only public HTTPS URLs are permitted/i);
    });

    it("handles HTTP 402 payment demand and HTTP 200 success cleanly", async () => {
        const runtime = createMockRuntime({
            WALLET_PUBLIC_KEY: "0xabc",
            AURA_BASE_URL: "https://auragateway.app"
        });

        let callCount = 0;
        mock.method(globalThis, "fetch", async (url: string) => {
            callCount++;
            assert.equal(url, "https://auragateway.app/api/public/v1/travel/aggregate");
            if (callCount === 1) {
                return new Response(null, {
                    status: 402,
                    headers: { "x-402-payment-required": "0.010-USDC-BASE" }
                });
            }
            return new Response(JSON.stringify({ routes: ["NYC-LHR"] }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        });

        const responses: any[] = [];
        const callback = async (res: any) => {
            responses.push(res);
            return [];
        };

        const firstAttempt = await travelAggregateAction.handler(
            runtime,
            { content: { text: "NYC to London" } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(firstAttempt, false);
        assert.equal(responses.at(0)?.content?.error, "402_PAYMENT_REQUIRED");

        const secondAttempt = await travelAggregateAction.handler(
            runtime,
            { content: { text: "NYC to London" } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(secondAttempt, true);
        assert.match(String(responses.at(1)?.text), /NYC-LHR/);

        mock.restoreAll();
    });

    it("invokes callback with descriptive error on 500 gateway failure", async () => {
        const runtime = createMockRuntime({ WALLET_PUBLIC_KEY: "0xabc" });
        mock.method(globalThis, "fetch", async () => {
            return new Response("Internal Server Error", {
                status: 502,
                statusText: "Bad Gateway"
            });
        });

        const messages: string[] = [];
        const callback = async (res: any) => {
            messages.push(res.text);
            return [];
        };

        const result = await visionProcessAction.handler(
            runtime,
            { content: { attachments: [{ url: "https://example.com" }] } } as any,
            {} as any,
            {},
            callback
        );
        assert.equal(result, false);
        assert.match(String(messages.at(0)), /HTTP 502/);

        mock.restoreAll();
    });
});


