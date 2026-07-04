/**
 * Error-path tests for `postHyperliquidCommand` (the Hyperliquid execution-check
 * POST client). This is a market-mutation-adjacent path that POSTs to
 * `/api/hyperliquid/orders/open`; the regression under test is that an
 * unparseable provider response body must NOT be swallowed into a fabricated
 * success object (the previous `response.json().catch(() => ({}))` turned an
 * unreadable 2xx body into a fake successful execution result). `fetch` is
 * mocked; no live Hyperliquid API calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { postHyperliquidCommand } from "./hyperliquid-command-client";

const PATH = "/api/hyperliquid/orders/open";
const BODY = { coin: "BTC", side: "buy", size: "0" };

function stubFetch(response: {
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => response as unknown as Response),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("postHyperliquidCommand fail-closed contract", () => {
	it("returns the parsed body on a 2xx response with a valid JSON body", async () => {
		stubFetch({
			ok: true,
			status: 200,
			json: async () => ({ accepted: true, orderId: "abc" }),
		});
		await expect(postHyperliquidCommand(PATH, BODY)).resolves.toEqual({
			accepted: true,
			orderId: "abc",
		});
	});

	it("throws (never fabricates a {} success) on a 2xx response with an unparseable body", async () => {
		stubFetch({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected end of JSON input");
			},
		});
		await expect(postHyperliquidCommand(PATH, BODY)).rejects.toThrow(
			/unreadable response body/i,
		);
	});

	it("surfaces the provider error message on a non-ok response with a parseable {error} body", async () => {
		stubFetch({
			ok: false,
			status: 501,
			json: async () => ({ error: "execution disabled" }),
		});
		await expect(postHyperliquidCommand(PATH, BODY)).rejects.toThrow(
			"execution disabled",
		);
	});

	it("names the unparseable body on a non-ok response with an unparseable body", async () => {
		stubFetch({
			ok: false,
			status: 502,
			json: async () => {
				throw new SyntaxError("Unexpected token < in JSON");
			},
		});
		await expect(postHyperliquidCommand(PATH, BODY)).rejects.toThrow(
			/failed with 502 \(unparseable error body\)/i,
		);
	});

	it("preserves the parse error as the thrown error's cause on a non-ok unparseable body", async () => {
		const cause = new SyntaxError("boom");
		stubFetch({
			ok: false,
			status: 500,
			json: async () => {
				throw cause;
			},
		});
		await expect(postHyperliquidCommand(PATH, BODY)).rejects.toMatchObject({
			cause,
		});
	});

	it("falls back to a status message on a non-ok response whose parseable body has no error string", async () => {
		stubFetch({
			ok: false,
			status: 500,
			json: async () => ({ someOtherShape: 1 }),
		});
		await expect(postHyperliquidCommand(PATH, BODY)).rejects.toThrow(
			/Hyperliquid request failed with 500/,
		);
	});
});
