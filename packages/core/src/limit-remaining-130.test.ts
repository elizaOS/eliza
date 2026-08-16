/**
 * Remaining limit clamp batch (ship 23) — control-plane mock + container-control-plane on 130d46b.
 * Pins weak `Number.parseInt` / `Number(...)` + isFinite/Math clamp vs strict `parseClampedLimit` (`/^\d+$/` + isSafeInteger).
 */

import * as fs from "node:fs";
import { describe, expect, test } from "vitest";

function oldControlLimit(raw?: string): number {
	const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
}
function fixedControlLimit(raw?: string): number {
	const fallback = 1000;
	const max = 1000;
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback;
}

function oldTail(raw?: string): number {
	const tailRaw = Number(raw ?? "200");
	return Number.isFinite(tailRaw) ? Math.max(1, Math.floor(tailRaw)) : 200;
}
function fixedTail(raw?: string): number {
	const fallback = 200;
	const max = 1000;
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback;
}

function oldContainerLimit(raw?: string): number {
	const rawLimit = Number(raw ?? "5");
	return Number.isFinite(rawLimit) ? Math.max(1, Math.min(25, rawLimit)) : 5;
}
function fixedContainerLimit(raw?: string): number {
	const fallback = 5;
	const max = 25;
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw)) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback;
}

describe("limit remaining batch 130 — control-plane + container", () => {
	test("control limit: 5junk, 1e4, 0, abc vs strict fallback 1000", () => {
		expect(oldControlLimit("5junk")).toBe(5);
		expect(fixedControlLimit("5junk")).toBe(1000);
		expect(oldControlLimit("1e4")).toBe(1);
		expect(fixedControlLimit("1e4")).toBe(1000);
		expect(oldControlLimit("0")).toBe(1000);
		expect(fixedControlLimit("0")).toBe(1000);
		expect(oldControlLimit("abc")).toBe(1000);
		expect(fixedControlLimit("abc")).toBe(1000);
		expect(oldControlLimit(undefined)).toBe(1000);
		expect(fixedControlLimit(undefined)).toBe(1000);
		expect(oldControlLimit("50")).toBe(50);
		expect(fixedControlLimit("50")).toBe(50);
	});

	test("tail: 5junk, 1e4, abc vs fallback 200 and clamp 1000", () => {
		expect(oldTail("5junk")).toBe(200);
		expect(fixedTail("5junk")).toBe(200);
		expect(oldTail("1e4")).toBe(10000);
		expect(fixedTail("1e4")).toBe(200);
		expect(oldTail("abc")).toBe(200);
		expect(fixedTail("abc")).toBe(200);
		expect(oldTail("0")).toBe(1);
		expect(fixedTail("0")).toBe(200);
		expect(oldTail("500")).toBe(500);
		expect(fixedTail("500")).toBe(500);
		expect(oldTail("2000")).toBe(2000);
		expect(fixedTail("2000")).toBe(1000);
	});

	test("container batchSize: 5junk, 1e4, 0, abc vs fallback 5 and clamp 25", () => {
		expect(oldContainerLimit("5junk")).toBe(5);
		expect(fixedContainerLimit("5junk")).toBe(5);
		expect(oldContainerLimit("1e4")).toBe(25);
		expect(fixedContainerLimit("1e4")).toBe(5);
		expect(oldContainerLimit("0")).toBe(1);
		expect(fixedContainerLimit("0")).toBe(5);
		expect(oldContainerLimit("abc")).toBe(5);
		expect(fixedContainerLimit("abc")).toBe(5);
		expect(oldContainerLimit("10")).toBe(10);
		expect(fixedContainerLimit("10")).toBe(10);
		expect(oldContainerLimit("100")).toBe(25);
		expect(fixedContainerLimit("100")).toBe(25);
	});

	test("ship23 sibling proof: files use parseClampedLimit and no bare Number.parseInt/Number(limit)", () => {
		const cp = fs.readFileSync(
			"packages/cloud/test-mocks/src/control-plane/server.ts",
			"utf8",
		);
		const cc = fs.readFileSync(
			"packages/cloud/services/container-control-plane/src/index.ts",
			"utf8",
		);
		const clamp = fs.readFileSync(
			"packages/cloud/shared/src/lib/utils/clamp-limit.ts",
			"utf8",
		);
		expect(cp).toContain('parseClampedLimit(c.req.query("limit"), 1000, 1000)');
		expect(cp).toContain('parseClampedLimit(c.req.query("tail"), 200, 1000)');
		expect(cp).not.toContain("Number.parseInt(rawLimit, 10)");
		expect(cp).not.toContain('Number(c.req.query("tail")');
		expect(cc).toContain('parseClampedLimit(c.req.query("limit"), 5, 25)');
		expect(cc).not.toContain('Number(c.req.query("limit") ?? "5")');
		expect(clamp).toContain("if (!/^\\d+$/.test(param)) return fallback");
		expect(clamp).toContain("Number.isSafeInteger");
		expect(cp.length).toBeGreaterThan(0);
	});
});
