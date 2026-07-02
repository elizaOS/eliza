// Fuzz / hardening pass for the downloader's Eliza-1 manifest parsing
// boundary. Everything a bundle download trusts flows through three real
// functions exercised here (no mocks):
//
//   - `validateManifest` / `parseManifestOrThrow` — schema + contract gate
//     for arbitrary JSON-decoded input (malformed, truncated, wrong-encoding,
//     object-vs-array shapes, oversized blobs).
//   - `parseBundleManifestOrThrow` — the downloader's id / primary-gguf
//     cross-check against the catalog entry.
//   - `collectBundleFiles` — flattening `files.*` with the conflicting-sha
//     rejection (same path listed twice with different sha256 must throw).
//   - `bundleTargetPath` — install-root confinement for manifest file paths
//     (absolute paths / traversal / drive prefixes must never escape).
//
// Invariants under any input: `validateManifest` never throws and always
// returns a consistent `{ ok, ... }` report; the throwing parsers throw
// `Error` (never return garbage); path resolution never escapes the root.
// A seeded LCG makes failures reproducible (same pattern as
// voice-hardening.fuzz.test.ts).

import path from "node:path";
import { describe, expect, it } from "vitest";
import { findCatalogModel } from "./catalog";
import {
	bundleTargetPath,
	collectBundleFiles,
	parseBundleManifestOrThrow,
} from "./downloader";
import {
	parseManifestOrThrow,
	REQUIRED_KERNELS_BY_TIER,
	validateManifest,
} from "./manifest";
import type { Eliza1Manifest, Eliza1Tier } from "./manifest/types";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function passingBackends() {
	return {
		metal: { status: "pass" as const, atCommit: "abc1234", report: "m.txt" },
		vulkan: { status: "pass" as const, atCommit: "abc1234", report: "v.txt" },
		cuda: { status: "pass" as const, atCommit: "abc1234", report: "c.txt" },
		rocm: { status: "pass" as const, atCommit: "abc1234", report: "r.txt" },
		cpu: { status: "pass" as const, atCommit: "abc1234", report: "cpu.txt" },
	};
}

/** A contract-valid 2b manifest (mirrors manifest.test.ts baseManifest). */
function validManifest(tier: Eliza1Tier = "2b"): Eliza1Manifest {
	return {
		id: `eliza-1-${tier}`,
		tier,
		version: "1.0.0",
		publishedAt: "2026-05-10T00:00:00Z",
		lineage: {
			text: { base: "eliza-1-text-backbone", license: "apache-2.0" },
			voice: { base: "eliza-1-voice-backbone", license: "apache-2.0" },
			asr: { base: "eliza-1-asr", license: "apache-2.0" },
			vad: { base: "eliza-1-vad", license: "apache-2.0" },
			vision: { base: "eliza-1-vision", license: "apache-2.0" },
			drafter: { base: "eliza-1-drafter", license: "apache-2.0" },
		},
		files: {
			text: [
				{ path: `text/eliza-1-${tier}-128k.gguf`, ctx: 131072, sha256: SHA_A },
			],
			voice: [{ path: "tts/kokoro/kokoro-82m-v1_0.gguf", sha256: SHA_A }],
			asr: [{ path: "asr/asr.gguf", sha256: SHA_A }],
			vision: [{ path: `vision/mmproj-${tier}.gguf`, sha256: SHA_A }],
			mtp: [{ path: `mtp/drafter-${tier}.gguf`, sha256: SHA_A }],
			cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA_A }],
			vad: [{ path: "vad/silero-vad-v5.gguf", sha256: SHA_A }],
		},
		kernels: {
			required: [...REQUIRED_KERNELS_BY_TIER[tier]],
			optional: [],
			verifiedBackends: passingBackends(),
		},
		evals: {
			textEval: { score: 0.71, passed: true },
			voiceRtf: { rtf: 0.42, passed: true },
			asrWer: { wer: 0.05, passed: true },
			vadLatencyMs: {
				median: 16,
				boundaryMs: 24,
				endpointMs: 80,
				falseBargeInRate: 0.01,
				passed: true,
			},
			mtp: { acceptanceRate: 0.72, speedup: 1.8, passed: true },
			e2eLoopOk: true,
			thirtyTurnOk: true,
		},
		ramBudgetMb: { min: 7000, recommended: 9500 },
		defaultEligible: true,
	};
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("validateManifest — sanity on the seed fixture", () => {
	it("accepts the contract-valid 2b manifest", () => {
		const result = validateManifest(validManifest());
		expect(result.ok, JSON.stringify(result)).toBe(true);
	});
});

describe("validateManifest — targeted adversarial shapes", () => {
	it("rejects object-vs-array files.vision without throwing", () => {
		const m = deepClone(validManifest()) as unknown as Record<string, unknown>;
		(m.files as Record<string, unknown>).vision = {
			path: "vision/mmproj-2b.gguf",
			sha256: SHA_A,
		};
		const result = validateManifest(m);
		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.errors.some((e) => e.includes("files.vision"))).toBe(true);
		}
	});

	it("rejects every truncation of the serialized manifest (raw string input) without throwing", () => {
		const raw = JSON.stringify(validManifest());
		for (let cut = 0; cut < raw.length; cut += Math.ceil(raw.length / 64)) {
			const truncated = raw.slice(0, cut);
			// The transport layer would fail JSON.parse on truncated bytes; the
			// validator must also reject the raw string if it is ever handed one.
			expect(() => JSON.parse(truncated)).toThrow();
			const result = validateManifest(truncated);
			expect(result.ok).toBe(false);
		}
	});

	it("rejects a wrong-encoding (utf16le-decoded) manifest body", () => {
		const utf8 = Buffer.from(JSON.stringify(validManifest()), "utf8");
		const garbled = utf8.toString("utf16le");
		expect(() => {
			const parsed: unknown = (() => {
				try {
					return JSON.parse(garbled);
				} catch {
					return garbled;
				}
			})();
			const result = validateManifest(parsed);
			expect(result.ok).toBe(false);
		}).not.toThrow();
	});

	it("rejects non-object roots (null/undefined/number/string/array/empty)", () => {
		for (const input of [
			null,
			undefined,
			0,
			1.5,
			"",
			"{}",
			[],
			[validManifest()],
			true,
		]) {
			const result = validateManifest(input);
			expect(result.ok).toBe(false);
			if (result.ok === false) {
				expect(result.errors.length).toBeGreaterThan(0);
				for (const e of result.errors) expect(typeof e).toBe("string");
			}
		}
	});

	it("terminates on an oversized manifest (2000 text entries + megabyte strings)", () => {
		const m = deepClone(validManifest()) as unknown as {
			files: { text: Array<Record<string, unknown>> };
			id: string;
		};
		m.id = "x".repeat(1_000_000);
		m.files.text = Array.from({ length: 2000 }, (_, i) => ({
			path: `text/blob-${i}.gguf`,
			ctx: 131072,
			sha256: SHA_A,
		}));
		const result = validateManifest(m);
		expect(typeof result.ok).toBe("boolean");
	});

	it("parseManifestOrThrow throws a structured Error listing every issue", () => {
		expect(() => parseManifestOrThrow({ id: 42 })).toThrow(
			/Invalid Eliza-1 manifest/,
		);
	});
});

describe("validateManifest — random mutation fuzz", () => {
	const WRONG_VALUES: ReadonlyArray<unknown> = [
		null,
		"",
		"x",
		0,
		-1,
		1.5,
		Number.NaN,
		true,
		false,
		[],
		{},
		[[]],
		{ path: 1 },
		"9".repeat(65),
	];

	function mutate(rng: () => number, root: Record<string, unknown>): void {
		// Walk to a random depth and either delete a key, replace a value with a
		// wrong-typed primitive, or array<->object swap the container.
		let node: Record<string, unknown> = root;
		const depth = 1 + Math.floor(rng() * 3);
		for (let d = 0; d < depth; d++) {
			const keys = Object.keys(node);
			if (keys.length === 0) return;
			const key = keys[Math.floor(rng() * keys.length)];
			const value = node[key];
			const isLeafStep =
				d === depth - 1 || typeof value !== "object" || value === null;
			if (isLeafStep) {
				const roll = rng();
				if (roll < 0.34) {
					delete node[key];
				} else if (roll < 0.67) {
					node[key] = WRONG_VALUES[Math.floor(rng() * WRONG_VALUES.length)];
				} else if (Array.isArray(value)) {
					node[key] = { ...value };
				} else if (typeof value === "object" && value !== null) {
					node[key] = Object.values(value);
				} else {
					node[key] = [value];
				}
				return;
			}
			node = value as Record<string, unknown>;
		}
	}

	it("never throws and always returns a consistent report across 1500 mutated manifests", () => {
		const rng = makeRng(0xe11a1);
		for (let i = 0; i < 1500; i++) {
			const m = deepClone(validManifest()) as unknown as Record<
				string,
				unknown
			>;
			const mutations = 1 + Math.floor(rng() * 4);
			for (let k = 0; k < mutations; k++) mutate(rng, m);
			const result = validateManifest(m);
			expect(typeof result.ok).toBe("boolean");
			if (result.ok === false) {
				expect(Array.isArray(result.errors)).toBe(true);
				expect(result.errors.length).toBeGreaterThan(0);
				for (const e of result.errors) expect(typeof e).toBe("string");
			} else {
				// A mutation can be a no-op (e.g. optional key deleted); when the
				// validator accepts, the manifest must round-trip the throwing parser.
				expect(() => parseManifestOrThrow(m)).not.toThrow();
			}
		}
	});
});

describe("parseBundleManifestOrThrow — catalog cross-checks", () => {
	const catalog2b = findCatalogModel("eliza-1-2b");
	if (!catalog2b) throw new Error("catalog entry eliza-1-2b missing");

	it("accepts a manifest whose id + primary text gguf match the catalog entry", () => {
		const manifest = parseBundleManifestOrThrow(validManifest("2b"), catalog2b);
		expect(manifest.id).toBe("eliza-1-2b");
	});

	it("rejects an id mismatch (schema-valid 9b manifest against the 2b catalog entry)", () => {
		expect(() =>
			parseBundleManifestOrThrow(validManifest("9b"), catalog2b),
		).toThrow(/does not match eliza-1-2b/);
	});

	it("rejects a manifest missing the catalog's primary text gguf", () => {
		const m = validManifest("2b");
		m.files.text = [
			{ path: "text/other.gguf", ctx: 131072, sha256: SHA_A },
		] as Eliza1Manifest["files"]["text"];
		expect(() => parseBundleManifestOrThrow(m, catalog2b)).toThrow(
			/primary text file .* is missing/,
		);
	});
});

describe("collectBundleFiles — conflicting-sha rejection + dedup", () => {
	it("throws on a conflicting-sha mtp entry (same path, different sha256)", () => {
		const m = validManifest("2b");
		m.files.mtp = [
			{ path: "mtp/drafter-2b.gguf", sha256: SHA_A },
			{ path: "mtp/drafter-2b.gguf", sha256: SHA_B },
		] as Eliza1Manifest["files"]["mtp"];
		// The schema-level validator does not own the duplicate-path rule; the
		// downloader's flattener must refuse before any byte is fetched.
		expect(() => collectBundleFiles(m)).toThrow(
			/Conflicting sha256 entries for bundle file mtp\/drafter-2b\.gguf/,
		);
	});

	it("throws on a cross-kind conflict (text vs cache, same path, different sha)", () => {
		const m = validManifest("2b");
		m.files.cache = [
			{ path: "cache/voice-preset-default.bin", sha256: SHA_A },
			{ path: "text/eliza-1-2b-128k.gguf", sha256: SHA_B },
		] as Eliza1Manifest["files"]["cache"];
		expect(() => collectBundleFiles(m)).toThrow(/Conflicting sha256 entries/);
	});

	it("dedups an exact duplicate (same path, same sha) instead of throwing", () => {
		const m = validManifest("2b");
		m.files.mtp = [
			{ path: "mtp/drafter-2b.gguf", sha256: SHA_A },
			{ path: "mtp/drafter-2b.gguf", sha256: SHA_A },
		] as Eliza1Manifest["files"]["mtp"];
		const files = collectBundleFiles(m);
		const mtpEntries = files.filter((f) => f.entry.path.startsWith("mtp/"));
		expect(mtpEntries).toHaveLength(1);
	});

	it("fuzz: unique-path outputs or a conflicting-sha throw, never anything else", () => {
		const rng = makeRng(0xf17e5);
		const PATHS = [
			"text/a.gguf",
			"mtp/drafter-2b.gguf",
			"cache/voice-preset-default.bin",
			"asr/asr.gguf",
		];
		const SHAS = [SHA_A, SHA_B];
		for (let i = 0; i < 1000; i++) {
			const m = validManifest("2b");
			const entries = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => ({
				path: PATHS[Math.floor(rng() * PATHS.length)],
				sha256: SHAS[Math.floor(rng() * SHAS.length)],
			}));
			m.files.mtp = entries as Eliza1Manifest["files"]["mtp"];
			// Conflicts are detected across ALL kinds, so fold in the baseline
			// entries the fixture already carries (asr/cache/text/...).
			const all = Object.values(m.files).flat() as Array<{
				path: string;
				sha256: string;
			}>;
			const hasConflict = all.some((a) =>
				all.some((b) => a.path === b.path && a.sha256 !== b.sha256),
			);
			if (hasConflict) {
				expect(() => collectBundleFiles(m)).toThrow(
					/Conflicting sha256 entries/,
				);
			} else {
				const files = collectBundleFiles(m);
				const paths = files.map((f) => f.entry.path);
				expect(new Set(paths).size).toBe(paths.length);
			}
		}
	});
});

describe("bundleTargetPath — install-root confinement", () => {
	const root = "/tmp/eliza-fuzz-bundle-root";

	it("rejects the canonical escape shapes", () => {
		for (const bad of [
			"",
			"/etc/passwd",
			"../outside.gguf",
			"a/../../outside.gguf",
			"C:\\evil.gguf",
			"c:/evil.gguf",
			"..",
		]) {
			expect(() => bundleTargetPath(root, bad), bad).toThrow();
		}
	});

	it("accepts nested relative paths and keeps them inside the root", () => {
		const target = bundleTargetPath(root, "mtp/drafter-2b.gguf");
		expect(target.startsWith(path.resolve(root) + path.sep)).toBe(true);
	});

	it("fuzz: any random path either throws or resolves inside the root", () => {
		const rng = makeRng(0xbadf5);
		const SEGMENTS = [
			"a",
			"..",
			".",
			"text",
			"mtp",
			"drafter-2b.gguf",
			"...",
			"a b",
			" ",
			"~",
			"C:",
			"\\\\server\\share",
		];
		for (let i = 0; i < 2000; i++) {
			const parts = Array.from(
				{ length: 1 + Math.floor(rng() * 5) },
				() => SEGMENTS[Math.floor(rng() * SEGMENTS.length)],
			);
			const candidate = parts.join(rng() < 0.2 ? "\\" : "/");
			let resolved: string | null = null;
			try {
				resolved = bundleTargetPath(root, candidate);
			} catch {
				continue; // rejection is always acceptable
			}
			const resolvedRoot = path.resolve(root);
			expect(
				resolved === resolvedRoot ||
					resolved.startsWith(resolvedRoot + path.sep),
				`escaped: ${candidate} -> ${resolved}`,
			).toBe(true);
		}
	});
});
