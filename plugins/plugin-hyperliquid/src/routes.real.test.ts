// Live drift check against the REAL public Hyperliquid Info API.
//
// The /info endpoint (meta, metaAndAssetCtxs) is public, so this drives the real
// handleHyperliquidRoute against the live API and asserts the response is still
// contract-shaped — catching drift from the recorded fixture replayed keyless in
// routes.contract.test.ts.
//
// Gated: opt-in via HYPERLIQUID_LIVE_TEST=1 or the post-merge live lane
// (TEST_LANE=post-merge). Skips cleanly otherwise.

import type http from "node:http";
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

const LIVE =
	process.env.HYPERLIQUID_LIVE_TEST === "1" ||
	process.env.TEST_LANE === "post-merge";

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

async function drive(pathname: string) {
	const res = createResponse();
	await handleHyperliquidRoute(
		{} as http.IncomingMessage,
		res,
		pathname,
		"GET",
		{ env: {} },
	);
	return res;
}

describe.skipIf(!LIVE)(
	"hyperliquid routes — live public API drift check",
	() => {
		it("live Info meta still parses into a contract-shaped markets DTO", async () => {
			const res = await drive("/api/hyperliquid/markets");
			expect(res.statusCode).toBe(200);
			const body = res.json<HyperliquidMarketsResponse>();
			expect(validateMarketsResponse(body)).toEqual([]);
			expect(body.markets.length).toBeGreaterThan(10);
		}, 30_000);

		it("live metaAndAssetCtxs still parses into a contract-shaped funding DTO", async () => {
			const res = await drive("/api/hyperliquid/funding");
			expect(res.statusCode).toBe(200);
			const body = res.json<HyperliquidFundingResponse>();
			expect(validateFundingResponse(body)).toEqual([]);
			expect(body.rates.length).toBeGreaterThan(10);
		}, 30_000);
	},
);
