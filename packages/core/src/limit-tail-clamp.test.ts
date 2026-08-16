/**
 * Strict tail/limit clamp for container + agent logs + trajectories — pins weak
 * Number/parseInt without ^\d+$ + isSafeInteger that accepted 5junk/1e4/5.5.
 * Sibling correct: packages/cloud/shared/src/lib/utils/clamp-limit.ts:8
 * parseClampedLimit with /^\d+$/ + isSafeInteger + Math.min, and
 * packages/cloud/api/v1/admin/docker-containers/route.ts:36 parseContainerListLimit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function oldContainerTail(raw: string | null | undefined): number {
	return Number(raw ?? "200");
}

function oldApiTail(raw: string | null | undefined): number {
	const rawTail = Number.parseInt(raw ?? "100", 10);
	return Math.max(1, Math.min(Number.isFinite(rawTail) ? rawTail : 100, 5000));
}

function oldTrajectoryLimit(raw: string | null | undefined): number {
	const requestedLimit =
		raw === null || raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(requestedLimit)
		? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
		: 50;
}

function oldTrajectoryOffset(raw: string | null | undefined): number {
	const requestedOffset =
		raw === null || raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(requestedOffset)
		? Math.max(0, Math.trunc(requestedOffset))
		: 0;
}

function fixedClampedLimit(
	param: string | null | undefined,
	fallback: number,
	max: number,
): number {
	if (!param) return fallback;
	if (!/^\d+$/.test(param)) return fallback;
	const parsed = Number(param);
	return Number.isSafeInteger(parsed) && parsed > 0
		? Math.min(parsed, max)
		: fallback;
}

function fixedClampedOffset(
	param: string | null | undefined,
	fallback = 0,
): number {
	if (!param) return fallback;
	if (!/^\d+$/.test(param)) return fallback;
	const parsed = Number(param);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

describe("strict tail/limit clamp — 4 routed sites", () => {
	test("container logs: fallback 200 max 1000 strict (tail)", () => {
		expect(fixedClampedLimit(null, 200, 1000)).toBe(200);
		expect(fixedClampedLimit(undefined, 200, 1000)).toBe(200);
		expect(fixedClampedLimit("", 200, 1000)).toBe(200);
		expect(fixedClampedLimit("200", 200, 1000)).toBe(200);
		expect(fixedClampedLimit("500", 200, 1000)).toBe(500);
		expect(fixedClampedLimit("2000", 200, 1000)).toBe(1000);
		for (const bad of [
			"abc",
			"-5",
			"0",
			"5junk",
			" 5",
			"5.5",
			"+5",
			"1e4",
			"Infinity",
		]) {
			expect(fixedClampedLimit(bad, 200, 1000)).toBe(200);
		}
		// old leak: 1e4→10000 not 200, 5.5→5.5 not 200
		expect(oldContainerTail("1e4")).toBe(10000);
		expect(fixedClampedLimit("1e4", 200, 1000)).toBe(200);
		expect(oldContainerTail("5.5")).toBe(5.5);
		expect(fixedClampedLimit("5.5", 200, 1000)).toBe(200);
		expect(Number.isNaN(oldContainerTail("5junk"))).toBe(true);
		expect(fixedClampedLimit("5junk", 200, 1000)).toBe(200);
	});

	test("agent logs v1 + compat: fallback 100 max 5000 strict (tail)", () => {
		expect(fixedClampedLimit(null, 100, 5000)).toBe(100);
		expect(fixedClampedLimit("100", 100, 5000)).toBe(100);
		expect(fixedClampedLimit("5000", 100, 5000)).toBe(5000);
		expect(fixedClampedLimit("6000", 100, 5000)).toBe(5000);
		for (const bad of ["abc", "-10", "0", "5junk", "5.5", "1e4", "Infinity"]) {
			expect(fixedClampedLimit(bad, 100, 5000)).toBe(100);
		}
		// old leak: 5junk→5 not 100, 1e4→1 not 100, 5.5→5 (parseInt truncation) not 100
		expect(oldApiTail("5junk")).toBe(5);
		expect(fixedClampedLimit("5junk", 100, 5000)).toBe(100);
		expect(oldApiTail("1e4")).toBe(1);
		expect(fixedClampedLimit("1e4", 100, 5000)).toBe(100);
		expect(oldApiTail("5.5")).toBe(5);
		expect(fixedClampedLimit("5.5", 100, 5000)).toBe(100);
	});

	test("trajectories limit/offset: limit 50 max 500, offset 0 strict", () => {
		expect(fixedClampedLimit(null, 50, 500)).toBe(50);
		expect(fixedClampedLimit("50", 50, 500)).toBe(50);
		expect(fixedClampedLimit("500", 50, 500)).toBe(500);
		expect(fixedClampedLimit("600", 50, 500)).toBe(500);
		for (const bad of [
			"abc",
			"-5",
			"0",
			"5junk",
			" 5",
			"5.5",
			"+5",
			"1e4",
			"Infinity",
		]) {
			expect(fixedClampedLimit(bad, 50, 500)).toBe(50);
		}
		for (const bad of [
			"abc",
			"-5",
			"5junk",
			" 5",
			"5.5",
			"+5",
			"1e4",
			"Infinity",
		]) {
			expect(fixedClampedOffset(bad, 0)).toBe(0);
		}
		expect(fixedClampedOffset("0", 0)).toBe(0);
		expect(fixedClampedOffset("100", 0)).toBe(100);
		// old leak: 1e4→500 not 50, 5.5→5 not 50, offset 1e4→10000 not 0
		expect(oldTrajectoryLimit("1e4")).toBe(500);
		expect(fixedClampedLimit("1e4", 50, 500)).toBe(50);
		expect(oldTrajectoryLimit("5.5")).toBe(5);
		expect(fixedClampedLimit("5.5", 50, 500)).toBe(50);
		expect(oldTrajectoryOffset("1e4")).toBe(10000);
		expect(fixedClampedOffset("1e4", 0)).toBe(0);
	});

	test("sibling proof: files use strict regex and no bare weak parse", () => {
		const ccp = readFileSync(
			join(
				process.cwd(),
				"packages/cloud/services/container-control-plane/src/index.ts",
			),
			"utf8",
		);
		const apiV1 = readFileSync(
			join(
				process.cwd(),
				"packages/cloud/api/v1/agents/[agentId]/logs/route.ts",
			),
			"utf8",
		);
		const compat = readFileSync(
			join(
				process.cwd(),
				"packages/cloud/api/compat/agents/[id]/logs/route.ts",
			),
			"utf8",
		);
		const traj = readFileSync(
			join(
				process.cwd(),
				"packages/core/src/features/trajectories/read-routes.ts",
			),
			"utf8",
		);
		// strict helper or inline regex present
		expect(ccp).toContain("parseClampedLimit");
		expect(apiV1).toContain("parseClampedLimit");
		expect(compat).toContain("parseClampedLimit");
		expect(traj).toContain("/^\\d+$/");
		expect(traj).toContain("isSafeInteger");
		// no bare weak parse remains in those files for tail/limit
		expect(apiV1).not.toContain('parseInt(c.req.query("tail")');
		expect(compat).not.toContain('parseInt(url.searchParams.get("tail")');
		expect(apiV1).not.toContain("Number.isFinite(rawTail)");
		expect(traj).not.toContain("Number.isFinite(requestedLimit)");
		expect(ccp).not.toContain('Number(c.req.query("tail")');
	});
});
