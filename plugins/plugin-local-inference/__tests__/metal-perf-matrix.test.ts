/**
 * Unit coverage for the #9580 / #9608 per-tier Metal throughput matrix harness'
 * pure logic — the functions that turn `llama-bench` JSON into the published
 * per-tier matrix. The harness itself shells out to `llama-bench` on real
 * hardware; these tests exercise only the in-memory reducers/formatters so a
 * regression in the JSON field names or row-shape can't silently publish wrong
 * throughput numbers. No GPU, no `llama-bench`, no device.
 */

import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildMarkdown,
	discoverTierModels,
	fmt,
	summarize,
	TIER_ORDER,
} from "../native/verify/metal-perf-matrix.mjs";

/** One pp512 (prefill), one tg128 (decode), two depth-decode rows. */
function fixtureRows() {
	return [
		{
			model_type: "gemma4",
			model_size: 4 * 1024 * 1024 * 1024,
			model_n_params: 4e9,
			flash_attn: 1,
			n_prompt: 512,
			n_gen: 0,
			n_depth: 0,
			avg_ts: 636.4,
			stddev_ts: 12.3,
		},
		{
			model_type: "gemma4",
			n_prompt: 0,
			n_gen: 128,
			n_depth: 0,
			avg_ts: 23.1,
			stddev_ts: 0.4,
		},
		{
			model_type: "gemma4",
			n_prompt: 0,
			n_gen: 128,
			n_depth: 4096,
			avg_ts: 19.7,
			stddev_ts: 0.6,
		},
		{
			model_type: "gemma4",
			n_prompt: 0,
			n_gen: 128,
			n_depth: 16000,
			avg_ts: 15.2,
			stddev_ts: 0.9,
		},
	];
}

describe("summarize()", () => {
	it("classifies llama-bench rows by (n_prompt, n_gen, n_depth) shape", () => {
		const s = summarize(fixtureRows());

		// Metadata is taken from the first row.
		expect(s.arch).toBe("gemma4");
		expect(s.sizeMiB).toBe(4096);
		expect(s.params).toBe(4000);
		expect(s.flashAttn).toBe(1);

		// pp512 = the n_prompt>0, n_gen===0, n_depth===0 row.
		expect(s.pp512).toEqual({ avg: 636.4, sd: 12.3 });
		// tg128 = the n_gen>0, n_prompt===0, n_depth===0 row.
		expect(s.tg128).toEqual({ avg: 23.1, sd: 0.4 });

		// Depth rows are bucketed by n_depth into depthDecode.
		expect(s.depthDecode[0]).toEqual({ avg: 23.1, sd: 0.4 });
		expect(s.depthDecode[4096]).toEqual({ avg: 19.7, sd: 0.6 });
		expect(s.depthDecode[16000]).toEqual({ avg: 15.2, sd: 0.9 });
	});

	it("leaves pp512/tg128 null when no matching row is present", () => {
		const s = summarize([
			{
				model_type: "gemma4",
				n_prompt: 0,
				n_gen: 128,
				n_depth: 4096,
				avg_ts: 19.7,
				stddev_ts: 0.6,
			},
		]);
		expect(s.pp512).toBeNull();
		// A depth>0 decode row must NOT be mistaken for tg128.
		expect(s.tg128).toBeNull();
		expect(s.depthDecode[4096]).toEqual({ avg: 19.7, sd: 0.6 });
	});

	it("does not crash on an empty row set", () => {
		const s = summarize([]);
		expect(s.arch).toBe("?");
		expect(s.sizeMiB).toBe(0);
		expect(s.pp512).toBeNull();
		expect(s.tg128).toBeNull();
		expect(s.depthDecode).toEqual({});
	});
});

describe("fmt()", () => {
	it('renders the documented "avg ± sd" cell (1-dp avg, 0-dp sd)', () => {
		expect(fmt({ avg: 636.4, sd: 12.3 })).toBe("636.4 ± 12");
		expect(fmt({ avg: 23.1, sd: 0.4 })).toBe("23.1 ± 0");
	});

	it("renders an em-dash placeholder for a missing measurement", () => {
		expect(fmt(null)).toBe("—");
		expect(fmt(undefined)).toBe("—");
	});
});

describe("buildMarkdown()", () => {
	it("emits the documented header, separator, and avg ± sd cells", () => {
		const summary = summarize(fixtureRows());
		const md = buildMarkdown([{ tier: "4b", summary }], {
			depths: "0,4096,16000",
		});
		const lines = md.split("\n");

		expect(lines[0]).toBe(
			"| tier | arch (as loaded) | size (MiB) | params | pp512 t/s | tg128 t/s | tg@d=0 | tg@d=4096 | tg@d=16000 |",
		);
		// 6 fixed columns + 3 depth columns = 9 "---|" cells.
		expect(lines[1]).toBe(`|${"---|".repeat(9)}`);
		expect(lines[2]).toBe(
			"| 4b | gemma4 | 4096 | 4000M | 636.4 ± 12 | 23.1 ± 0 | 23.1 ± 0 | 19.7 ± 1 | 15.2 ± 1 |",
		);
	});

	it("omits depth columns when no depths are requested", () => {
		const summary = summarize(fixtureRows());
		const md = buildMarkdown([{ tier: "4b", summary }], { depths: null });
		const lines = md.split("\n");
		expect(lines[0]).toBe(
			"| tier | arch (as loaded) | size (MiB) | params | pp512 t/s | tg128 t/s |",
		);
		expect(lines[1]).toBe(`|${"---|".repeat(6)}`);
		expect(lines[2]).toBe("| 4b | gemma4 | 4096 | 4000M | 636.4 ± 12 | 23.1 ± 0 |");
	});
});

describe("discoverTierModels()", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(path.join(tmpdir(), "metal-perf-matrix-"));
		// Bundles created out of catalog order, plus a custom (non-catalog) tier,
		// a non-gguf decoy file, and a directory that is not a bundle.
		const bundles: Array<[string, string]> = [
			["9b", "eliza-1-9b-128k.gguf"],
			["4b", "eliza-1-4b-128k.gguf"],
			["2b", "eliza-1-2b-128k.gguf"],
			["custom-x", "eliza-1-custom-x.gguf"],
		];
		for (const [tier, gguf] of bundles) {
			const textDir = path.join(root, `eliza-1-${tier}.bundle`, "text");
			mkdirSync(textDir, { recursive: true });
			writeFileSync(path.join(textDir, gguf), "gguf-bytes");
			writeFileSync(path.join(textDir, "README.md"), "decoy");
		}
		mkdirSync(path.join(root, "not-a-bundle"), { recursive: true });
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves eliza-1-<tier>.bundle/text/*.gguf and applies TIER_ORDER", () => {
		const result = discoverTierModels([root]);
		const tiers = result.map(([tier]) => tier);

		// Catalog tiers come first, in TIER_ORDER; the non-catalog tier is appended.
		expect(tiers).toEqual(["2b", "4b", "9b", "custom-x"]);
		// 2b precedes 4b precedes 9b per the canonical ordering.
		expect(TIER_ORDER.indexOf("2b")).toBeLessThan(TIER_ORDER.indexOf("4b"));
		expect(TIER_ORDER.indexOf("4b")).toBeLessThan(TIER_ORDER.indexOf("9b"));

		// Each entry points at the discovered text GGUF, not the decoy.
		for (const [, gguf] of result) {
			expect(gguf.endsWith(".gguf")).toBe(true);
			expect(path.basename(path.dirname(gguf))).toBe("text");
		}
	});

	it("returns nothing for a directory with no eliza-1 bundles", () => {
		const empty = mkdtempSync(path.join(tmpdir(), "metal-perf-matrix-empty-"));
		try {
			expect(discoverTierModels([empty])).toEqual([]);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});
