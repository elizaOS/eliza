/**
 * Triage param parsers turn loose agent-supplied options into typed inputs.
 * Sources are filtered to the known set, list fields accept comma-strings or
 * arrays, and numbers coerce from strings — malformed values drop to undefined
 * rather than reaching the inbox query as garbage.
 */

import { describe, expect, it } from "vitest";
import type { HandlerOptions } from "../../../../types/components";
import { parseListInboxParams, parseTriageParams } from "./_shared.ts";

const opts = (parameters: Record<string, unknown>): HandlerOptions =>
	({ parameters }) as unknown as HandlerOptions;

describe("parseTriageParams", () => {
	it("returns all-undefined for absent options", () => {
		expect(parseTriageParams(undefined)).toEqual({
			sources: undefined,
			worldIds: undefined,
			channelIds: undefined,
			sinceMs: undefined,
			limit: undefined,
		});
	});

	it("filters sources to the known set (string or array, case-insensitive)", () => {
		expect(
			parseTriageParams(opts({ sources: "Discord,telegram,bogus" })).sources,
		).toEqual(["discord", "telegram"]);
		expect(parseTriageParams(opts({ source: ["gmail"] })).sources).toEqual([
			"gmail",
		]);
		// no valid source → undefined, not [].
		expect(
			parseTriageParams(opts({ sources: "nope" })).sources,
		).toBeUndefined();
	});

	it("parses list + numeric fields with coercion", () => {
		const out = parseTriageParams(
			opts({
				worldIds: "w1, w2",
				channelIds: ["c1"],
				limit: "5",
				sinceMs: 1000,
			}),
		);
		expect(out.worldIds).toEqual(["w1", "w2"]);
		expect(out.channelIds).toEqual(["c1"]);
		expect(out.limit).toBe(5);
		expect(out.sinceMs).toBe(1000);
	});

	it("drops non-numeric limit/sinceMs", () => {
		const out = parseTriageParams(opts({ limit: "abc", sinceMs: "x" }));
		expect(out.limit).toBeUndefined();
		expect(out.sinceMs).toBeUndefined();
	});
});

describe("parseListInboxParams", () => {
	it("parses the same shape as triage params", () => {
		const out = parseListInboxParams(opts({ source: "signal", limit: 20 }));
		expect(out.sources).toEqual(["signal"]);
		expect(out.limit).toBe(20);
	});
});
