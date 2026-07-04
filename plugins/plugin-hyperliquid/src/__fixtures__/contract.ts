// Structural validators for the Hyperliquid BFF DTOs.
//
// Asserts a value produced by `handleHyperliquidRoute` is a real, contract-shaped
// DTO. Shared by routes.contract.test.ts (recorded real replay, keyless) and
// routes.real.test.ts (live public Info API drift check). Numeric fields from the
// Info API arrive as strings (e.g. funding "0.0000100312"); the validator enforces
// the numeric-string contract so a malformed/pre-formatted value is caught.

import type {
	HyperliquidFundingResponse,
	HyperliquidMarketsResponse,
} from "../hyperliquid-contracts";

type Violations = string[];

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return `array[${value.length}]`;
	return typeof value;
}

function checkNumericStringOrNull(
	v: Violations,
	path: string,
	value: unknown,
): void {
	if (value === null) return;
	if (typeof value !== "string" || value.trim() === "") {
		v.push(`${path}: expected numeric-string|null, got ${describe(value)}`);
		return;
	}
	if (!Number.isFinite(Number(value))) {
		v.push(`${path}: expected a numeric string, got ${JSON.stringify(value)}`);
	}
}

export function validateMarketsResponse(value: unknown): Violations {
	const v: Violations = [];
	if (typeof value !== "object" || value === null) {
		return ["response: expected object"];
	}
	const r = value as HyperliquidMarketsResponse;
	if (r.source !== "hyperliquid-info-meta") {
		v.push(
			`source: expected "hyperliquid-info-meta", got ${describe(r.source)}`,
		);
	}
	if (!isNonEmptyString(r.fetchedAt)) v.push("fetchedAt: expected ISO string");
	if (!Array.isArray(r.markets)) {
		v.push("markets: expected array");
		return v;
	}
	r.markets.forEach((m, i) => {
		const path = `markets[${i}]`;
		if (!isNonEmptyString(m.name))
			v.push(`${path}.name: expected non-empty string`);
		if (typeof m.index !== "number") v.push(`${path}.index: expected number`);
		if (typeof m.szDecimals !== "number") {
			v.push(`${path}.szDecimals: expected number`);
		}
		if (m.maxLeverage !== null && typeof m.maxLeverage !== "number") {
			v.push(`${path}.maxLeverage: expected number|null`);
		}
		if (typeof m.onlyIsolated !== "boolean") {
			v.push(`${path}.onlyIsolated: expected boolean`);
		}
		if (typeof m.isDelisted !== "boolean") {
			v.push(`${path}.isDelisted: expected boolean`);
		}
	});
	return v;
}

export function validateFundingResponse(value: unknown): Violations {
	const v: Violations = [];
	if (typeof value !== "object" || value === null) {
		return ["response: expected object"];
	}
	const r = value as HyperliquidFundingResponse;
	if (r.source !== "hyperliquid-info-meta-and-asset-ctxs") {
		v.push(`source: unexpected ${describe(r.source)}`);
	}
	if (!isNonEmptyString(r.fetchedAt)) v.push("fetchedAt: expected ISO string");
	if (!Array.isArray(r.rates)) {
		v.push("rates: expected array");
		return v;
	}
	r.rates.forEach((rate, i) => {
		const path = `rates[${i}]`;
		if (!isNonEmptyString(rate.coin)) v.push(`${path}.coin: expected string`);
		if (typeof rate.index !== "number")
			v.push(`${path}.index: expected number`);
		// funding is required numeric string; the rest are numeric-string|null.
		checkNumericStringOrNull(v, `${path}.funding`, rate.funding);
		if (rate.funding === null) v.push(`${path}.funding: must not be null`);
		checkNumericStringOrNull(v, `${path}.premium`, rate.premium);
		checkNumericStringOrNull(v, `${path}.markPx`, rate.markPx);
		checkNumericStringOrNull(v, `${path}.oraclePx`, rate.oraclePx);
		checkNumericStringOrNull(v, `${path}.openInterest`, rate.openInterest);
	});
	return v;
}
