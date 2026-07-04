// Keyless contract test: replays REAL recorded Hyperliquid Info API responses
// (__fixtures__/hyperliquid-real.recorded.json, captured from the public
// /info endpoint) through the actual handleHyperliquidRoute parser and asserts a
// contract-shaped DTO. Validates the parser against the real wire shape
// (universe entries, string asset-ctx numerics) with no network.

import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	validateFundingResponse,
	validateMarketsResponse,
} from "./__fixtures__/contract";
import type {
	HyperliquidFundingResponse,
	HyperliquidMarketsResponse,
} from "./hyperliquid-contracts";
import { handleHyperliquidRoute } from "./routes";

interface Recorded {
	meta: unknown;
	metaAndAssetCtxs: unknown;
}

const recorded = JSON.parse(
	readFileSync(
		resolve(import.meta.dirname, "__fixtures__/hyperliquid-real.recorded.json"),
		"utf8",
	),
) as Recorded;

function createResponse() {
	const res = {
		headersSent: false,
		statusCode: 0,
		body: "",
		setHeader() {},
		end(body: string) {
			this.headersSent = true;
			this.body = body;
		},
		json<T = unknown>(): T {
			return JSON.parse(this.body) as T;
		},
	};
	return res as typeof res & http.ServerResponse;
}

// Dispatch on the Info API request `type` so markets ({type:"meta"}) and funding
// ({type:"metaAndAssetCtxs"}) each get their recorded payload.
const recordedFetch = (async (_url: string, init?: { body?: string }) => {
	const type = init?.body
		? (JSON.parse(init.body) as { type?: string }).type
		: undefined;
	const body =
		type === "metaAndAssetCtxs" ? recorded.metaAndAssetCtxs : recorded.meta;
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}) as unknown as typeof fetch;

const FIXED_NOW = () => new Date("2026-06-16T00:00:00.000Z");

describe("hyperliquid routes — recorded real API contract", () => {
	it("parses real Info meta into a contract-shaped markets DTO", async () => {
		const res = createResponse();
		const handled = await handleHyperliquidRoute(
			{} as http.IncomingMessage,
			res,
			"/api/hyperliquid/markets",
			"GET",
			{ fetchImpl: recordedFetch, env: {}, now: FIXED_NOW },
		);
		expect(handled).toBe(true);
		expect(res.statusCode).toBe(200);
		const body = res.json<HyperliquidMarketsResponse>();
		expect(validateMarketsResponse(body)).toEqual([]);
		expect(body.markets.length).toBeGreaterThan(0);
		// index is assigned from universe position; BTC is first.
		expect(body.markets[0]?.name).toBeTruthy();
		expect(body.markets[0]?.index).toBe(0);
	});

	it("parses real metaAndAssetCtxs into a contract-shaped funding DTO", async () => {
		const res = createResponse();
		await handleHyperliquidRoute(
			{} as http.IncomingMessage,
			res,
			"/api/hyperliquid/funding",
			"GET",
			{ fetchImpl: recordedFetch, env: {}, now: FIXED_NOW },
		);
		expect(res.statusCode).toBe(200);
		const body = res.json<HyperliquidFundingResponse>();
		expect(validateFundingResponse(body)).toEqual([]);
		expect(body.rates.length).toBeGreaterThan(0);
		// funding rate arrives as a numeric string from the real API.
		expect(body.rates[0]?.funding).toMatch(/^-?\d/);
	});

	it("POST routes are execution-disabled (501)", async () => {
		const res = createResponse();
		await handleHyperliquidRoute(
			{} as http.IncomingMessage,
			res,
			"/api/hyperliquid/orders/open",
			"POST",
			{ fetchImpl: recordedFetch, env: {} },
		);
		expect(res.statusCode).toBe(501);
	});
});
