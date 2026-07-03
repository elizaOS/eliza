// Fuzz / hardening pass for the drafter + load-args resolution boundary.
// Companion to downloader-manifest.fuzz.test.ts (manifest parsing) and
// local-inference-route-contracts.fuzz.test.ts (TTS/ASR HTTP contracts).
// Everything here drives REAL functions — no mocks:
//
//   - `resolveLocalInferenceLoadArgs` — catalog + manifest + overrides merge,
//     including the separate-drafter MTP rule: a hosted-MTP tier (eliza-1-2b
//     declares `runtime.mtp.drafterFile`) with a bundleRoot but NO drafter
//     GGUF on disk must throw, never silently load without speculation.
//   - `validateLocalInferenceLoadArgs` — differential fuzz against an oracle
//     mirroring the documented acceptance rules (stock vs fork KV cache
//     types, contextSize/gpuLayers integrality, kvOffload shapes).
//   - `readGgufArchitecture` (text-provenance) — the on-disk GGUF header
//     metadata reader. The native runtime enforces `embedding_length_out`
//     compatibility inside llama.cpp (gemma4-assistant.cpp throws on a
//     mismatched target hidden size); the TS-side counterpart of that
//     metadata trust boundary is this header parser, which must fail closed
//     (null) on truncated/malformed/adversarial headers and never throw.
//
// A seeded LCG makes failures reproducible (same pattern as
// downloader-manifest.fuzz.test.ts).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	isForkOnlyKvCacheType,
	isStockKvCacheType,
	type LocalInferenceLoadArgs,
	resolveLocalInferenceLoadArgs,
	validateLocalInferenceLoadArgs,
} from "./active-model";
import { findCatalogModel } from "./catalog";
import type { Eliza1Manifest } from "./manifest/types";
import {
	collectTextArchitectureBlockers,
	readGgufArchitecture,
} from "./text-provenance";
import type { InstalledModel } from "./types";

const SHA_A = "a".repeat(64);

function makeRng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

const tmpRoots: string[] = [];

afterAll(() => {
	for (const root of tmpRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// non-fatal during teardown
		}
	}
});

function makeTempBundle(args: { tier: string; hasDrafter: boolean }): {
	bundleRoot: string;
	textPath: string;
	drafterPath: string;
} {
	const root = mkdtempSync(pathJoin(tmpdir(), "eliza-loadargs-fuzz-"));
	tmpRoots.push(root);
	mkdirSync(pathJoin(root, "text"), { recursive: true });
	const textPath = pathJoin(root, "text", `eliza-1-${args.tier}-128k.gguf`);
	writeFileSync(textPath, "fake-text-gguf");
	const drafterPath = pathJoin(root, "mtp", `drafter-${args.tier}.gguf`);
	if (args.hasDrafter) {
		mkdirSync(pathJoin(root, "mtp"), { recursive: true });
		writeFileSync(drafterPath, "fake-mtp-drafter-gguf");
	}
	return { bundleRoot: root, textPath, drafterPath };
}

function installedModel(args: {
	id: string;
	path: string;
	bundleRoot?: string;
}): InstalledModel {
	return {
		id: args.id,
		displayName: args.id,
		path: args.path,
		sizeBytes: 1024,
		bundleRoot: args.bundleRoot,
		installedAt: new Date().toISOString(),
		lastUsedAt: null,
		source: args.bundleRoot ? "eliza-download" : "external-scan",
		...(args.bundleRoot ? {} : { externalOrigin: "lm-studio" as const }),
	};
}

/** Minimal contract-shaped 2b manifest for injected-loader tests. */
function manifestWithMtp(mtpPaths: string[]): Eliza1Manifest {
	return {
		id: "eliza-1-2b",
		tier: "2b",
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
			text: [{ path: "text/eliza-1-2b-128k.gguf", ctx: 131072, sha256: SHA_A }],
			voice: [{ path: "tts/kokoro/kokoro-82m-v1_0.gguf", sha256: SHA_A }],
			asr: [{ path: "asr/asr.gguf", sha256: SHA_A }],
			vision: [{ path: "vision/mmproj-2b.gguf", sha256: SHA_A }],
			mtp: mtpPaths.map((p) => ({ path: p, sha256: SHA_A })),
			cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA_A }],
			vad: [{ path: "vad/silero-vad-v5.gguf", sha256: SHA_A }],
		},
		kernels: { required: [], optional: [], verifiedBackends: {} },
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
	} as Eliza1Manifest;
}

describe("resolveLocalInferenceLoadArgs — separate-drafter MTP resolution", () => {
	const catalog2b = findCatalogModel("eliza-1-2b");
	it("catalog precondition: eliza-1-2b declares separate-drafter MTP", () => {
		expect(catalog2b?.runtime?.mtp?.specType).toBe("draft-mtp");
		expect(catalog2b?.runtime?.mtp?.drafterFile).toMatch(/drafter-2b\.gguf$/);
	});

	it("throws when the declared drafter GGUF is missing under bundleRoot", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: false });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		await expect(resolveLocalInferenceLoadArgs(installed)).rejects.toThrow(
			/separate-drafter MTP but no bundled drafter GGUF/,
		);
	});

	it("does not throw for an external-scan install (no bundleRoot); drafter stays unset", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: false });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed);
		expect(resolved.draftModelPath).toBeUndefined();
		// The MTP block still applies the catalog draft window defaults.
		expect(resolved.draftMin).toBe(catalog2b?.runtime?.mtp?.draftMin);
		expect(resolved.draftMax).toBe(catalog2b?.runtime?.mtp?.draftMax);
	});

	it("prefers a manifest files.mtp entry that exists on disk over the catalog path", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: false });
		// Stage a drafter at a NON-catalog path, declared only by the manifest.
		mkdirSync(pathJoin(bundle.bundleRoot, "mtp"), { recursive: true });
		const altPath = pathJoin(bundle.bundleRoot, "mtp", "custom-drafter.gguf");
		writeFileSync(altPath, "fake-custom-drafter");
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed, undefined, {
			manifestLoader: () => manifestWithMtp(["mtp/custom-drafter.gguf"]),
		});
		expect(resolved.draftModelPath).toBe(altPath);
	});

	it("falls through a missing manifest mtp entry to the on-disk catalog drafter", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: true });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed, undefined, {
			manifestLoader: () => manifestWithMtp(["mtp/not-on-disk.gguf"]),
		});
		expect(resolved.draftModelPath).toBe(bundle.drafterPath);
	});

	it("rejects invalid merged overrides instead of loading degraded", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: true });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		await expect(
			resolveLocalInferenceLoadArgs(installed, { contextSize: 100 }),
		).rejects.toThrow(/contextSize/);
		await expect(
			resolveLocalInferenceLoadArgs(installed, { cacheTypeK: "not-a-type" }),
		).rejects.toThrow(/not a recognised KV cache type/);
		await expect(
			resolveLocalInferenceLoadArgs(installed, {
				kvOffload: "bogus" as never,
			}),
		).rejects.toThrow(/kvOffload/);
		await expect(
			resolveLocalInferenceLoadArgs(installed, { gpuLayers: -1 }),
		).rejects.toThrow(/gpuLayers/);
	});

	it("accepts fork-only KV cache types at resolve time (allowFork) and normalizes case/space", async () => {
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: true });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed, {
			cacheTypeK: "q4_polar",
			cacheTypeV: "  Q8_0  ",
		});
		expect(resolved.cacheTypeK).toBe("q4_polar");
		expect(resolved.cacheTypeV).toBe("q8_0");
	});
});

describe("resolveLocalInferenceLoadArgs — mobile context ceiling", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"ELIZA_MOBILE_PLATFORM",
		"ELIZA_PLATFORM",
		"ELIZA_MOBILE_CONTEXT_CEILING",
	] as const;
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	});

	async function resolveOnMobile(
		ceiling: string | undefined,
	): Promise<LocalInferenceLoadArgs> {
		process.env.ELIZA_MOBILE_PLATFORM = "ios";
		if (ceiling === undefined) delete process.env.ELIZA_MOBILE_CONTEXT_CEILING;
		else process.env.ELIZA_MOBILE_CONTEXT_CEILING = ceiling;
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: true });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		return resolveLocalInferenceLoadArgs(installed, { contextSize: 131072 });
	}

	it("clamps a 128k context request to the default 8192 ceiling on iOS", async () => {
		const resolved = await resolveOnMobile(undefined);
		expect(resolved.contextSize).toBe(8192);
	});

	it("honours a valid explicit ceiling override", async () => {
		const resolved = await resolveOnMobile("4096");
		expect(resolved.contextSize).toBe(4096);
	});

	it("fuzz: garbage ceiling env values fall back to the 8192 default, never NaN/undefined", async () => {
		for (const garbage of ["", "abc", "-5", "0", "255", "1.5", "1e4", "  "]) {
			const resolved = await resolveOnMobile(garbage);
			// "1e4" parseInt→1 (<256) and "1.5"→1 both fall back; "255" is below
			// the 256 floor. Every garbage value must land on the default.
			expect(resolved.contextSize, `ceiling=${JSON.stringify(garbage)}`).toBe(
				8192,
			);
		}
	});

	it("desktop (no platform marker) keeps the full requested context", async () => {
		delete process.env.ELIZA_MOBILE_PLATFORM;
		delete process.env.ELIZA_PLATFORM;
		const bundle = makeTempBundle({ tier: "2b", hasDrafter: true });
		const installed = installedModel({
			id: "eliza-1-2b",
			path: bundle.textPath,
			bundleRoot: bundle.bundleRoot,
		});
		const resolved = await resolveLocalInferenceLoadArgs(installed, {
			contextSize: 131072,
		});
		expect(resolved.contextSize).toBe(131072);
	});
});

describe("validateLocalInferenceLoadArgs — differential fuzz vs oracle", () => {
	const KV_VALUES: ReadonlyArray<unknown> = [
		undefined,
		"f16",
		"q8_0",
		"q4_polar",
		"q4_paretoq",
		"Q4_POLAR",
		" f16 ",
		"not-a-type",
		"",
		42,
		null,
	];
	const CTX_VALUES: ReadonlyArray<unknown> = [
		undefined,
		256,
		8192,
		255,
		0,
		-1,
		1.5,
		Number.NaN,
		"4096",
	];
	const GPU_VALUES: ReadonlyArray<unknown> = [
		undefined,
		0,
		32,
		-1,
		2.5,
		Number.NaN,
		"16",
	];
	const KV_OFFLOAD_VALUES: ReadonlyArray<unknown> = [
		undefined,
		"cpu",
		"gpu",
		"split",
		"auto",
		"",
		{ gpuLayers: 8 },
		{ gpuLayers: "8" },
		{},
		null,
		7,
	];
	const BOOL_VALUES: ReadonlyArray<unknown> = [
		undefined,
		true,
		false,
		"true",
		1,
		null,
	];

	function oracleAccepts(
		args: Record<string, unknown>,
		allowFork: boolean,
	): boolean {
		for (const field of ["cacheTypeK", "cacheTypeV"]) {
			const v = args[field];
			if (v === undefined) continue;
			if (typeof v !== "string" || v.length === 0) return false;
			const stock = isStockKvCacheType(v);
			const fork = isForkOnlyKvCacheType(v);
			if (allowFork ? !stock && !fork : !stock) return false;
		}
		const ctx = args.contextSize;
		if (ctx !== undefined) {
			if (typeof ctx !== "number" || !Number.isInteger(ctx) || ctx < 256)
				return false;
		}
		const gpu = args.gpuLayers;
		if (gpu !== undefined) {
			if (typeof gpu !== "number" || !Number.isInteger(gpu) || gpu < 0)
				return false;
		}
		const kv = args.kvOffload;
		if (kv !== undefined) {
			if (typeof kv === "string") {
				if (kv !== "cpu" && kv !== "gpu" && kv !== "split") return false;
			} else if (
				!kv ||
				typeof kv !== "object" ||
				typeof (kv as { gpuLayers?: unknown }).gpuLayers !== "number"
			) {
				return false;
			}
		}
		for (const field of ["flashAttention", "mmap", "mlock"]) {
			const v = args[field];
			if (v !== undefined && typeof v !== "boolean") return false;
		}
		return true;
	}

	it("agrees with the oracle across 3000 random arg shapes in both fork modes", () => {
		const rng = makeRng(0xd4a17e);
		const pick = <T>(values: ReadonlyArray<T>): T =>
			values[Math.floor(rng() * values.length)];
		for (let i = 0; i < 3000; i++) {
			const args: Record<string, unknown> = {};
			if (rng() < 0.6) args.cacheTypeK = pick(KV_VALUES);
			if (rng() < 0.6) args.cacheTypeV = pick(KV_VALUES);
			if (rng() < 0.6) args.contextSize = pick(CTX_VALUES);
			if (rng() < 0.6) args.gpuLayers = pick(GPU_VALUES);
			if (rng() < 0.6) args.kvOffload = pick(KV_OFFLOAD_VALUES);
			if (rng() < 0.4) args.flashAttention = pick(BOOL_VALUES);
			if (rng() < 0.4) args.mmap = pick(BOOL_VALUES);
			if (rng() < 0.4) args.mlock = pick(BOOL_VALUES);
			for (const k of Object.keys(args)) {
				if (args[k] === undefined) delete args[k];
			}
			for (const allowFork of [false, true]) {
				const expected = oracleAccepts(args, allowFork);
				const label = `allowFork=${allowFork} args=${JSON.stringify(args)}`;
				if (expected) {
					expect(
						() =>
							validateLocalInferenceLoadArgs(
								args as Partial<LocalInferenceLoadArgs>,
								{ allowFork },
							),
						label,
					).not.toThrow();
				} else {
					expect(
						() =>
							validateLocalInferenceLoadArgs(
								args as Partial<LocalInferenceLoadArgs>,
								{ allowFork },
							),
						label,
					).toThrow(Error);
				}
			}
		}
	});

	it("rejects fork-only KV types without allowFork and accepts them with it", () => {
		expect(() =>
			validateLocalInferenceLoadArgs({ cacheTypeK: "q4_polar" }),
		).toThrow(/requires the elizaOS\/llama\.cpp kernel/);
		expect(() =>
			validateLocalInferenceLoadArgs(
				{ cacheTypeK: "q4_polar" },
				{ allowFork: true },
			),
		).not.toThrow();
	});
});

describe("readGgufArchitecture — adversarial GGUF header fuzz", () => {
	const scratch = mkdtempSync(pathJoin(tmpdir(), "eliza-gguf-fuzz-"));
	tmpRoots.push(scratch);
	const file = pathJoin(scratch, "probe.gguf");

	function ggufString(s: string): Buffer {
		const body = Buffer.from(s, "utf8");
		const len = Buffer.alloc(8);
		len.writeBigUInt64LE(BigInt(body.length));
		return Buffer.concat([len, body]);
	}

	function u32(v: number): Buffer {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(v >>> 0);
		return b;
	}

	function u64(v: bigint): Buffer {
		const b = Buffer.alloc(8);
		b.writeBigUInt64LE(v);
		return b;
	}

	/** Contract-valid minimal header: one KV, general.architecture = <arch>. */
	function validHeader(arch: string): Buffer {
		return Buffer.concat([
			Buffer.from("GGUF", "ascii"), // magic 0x46554747 LE
			u32(3), // version
			u64(0n), // tensor_count
			u64(1n), // kv_count
			ggufString("general.architecture"),
			u32(8), // GgufType.String
			ggufString(arch),
		]);
	}

	it("reads the architecture out of a crafted valid header", () => {
		writeFileSync(file, validHeader("gemma4"));
		expect(readGgufArchitecture(file)).toBe("gemma4");
	});

	it("fails closed (null) on every truncation of a valid header", () => {
		const full = validHeader("gemma4");
		for (let cut = 0; cut < full.length; cut++) {
			writeFileSync(file, full.subarray(0, cut));
			expect(readGgufArchitecture(file), `cut=${cut}`).toBeNull();
		}
	});

	it("returns null when the architecture value is not a string", () => {
		const header = Buffer.concat([
			Buffer.from("GGUF", "ascii"),
			u32(3),
			u64(0n),
			u64(1n),
			ggufString("general.architecture"),
			u32(4), // GgufType.Uint32
			u32(1536),
		]);
		writeFileSync(file, header);
		expect(readGgufArchitecture(file)).toBeNull();
	});

	it("returns null on an adversarial u64 string length past MAX_SAFE_INTEGER", () => {
		const header = Buffer.concat([
			Buffer.from("GGUF", "ascii"),
			u32(3),
			u64(0n),
			u64(1n),
			u64(0xffff_ffff_ffff_ffffn), // key length: absurd
		]);
		writeFileSync(file, header);
		expect(readGgufArchitecture(file)).toBeNull();
	});

	it("returns null on a bogus kv_count that overruns the buffer", () => {
		const header = Buffer.concat([
			Buffer.from("GGUF", "ascii"),
			u32(3),
			u64(0n),
			u64(1n << 40n), // kv_count: absurd
			ggufString("some.key"),
			u32(8),
			ggufString("x"),
		]);
		writeFileSync(file, header);
		expect(readGgufArchitecture(file)).toBeNull();
	});

	it("skips unknown-typed values before the architecture key without throwing", () => {
		const header = Buffer.concat([
			Buffer.from("GGUF", "ascii"),
			u32(3),
			u64(0n),
			u64(3n),
			ggufString("general.alignment"),
			u32(4), // Uint32
			u32(32),
			ggufString("tokenizer.ggml.tokens"),
			u32(9), // Array
			u32(8), // of String
			u64(2n),
			ggufString("a"),
			ggufString("b"),
			ggufString("general.architecture"),
			u32(8),
			ggufString("qwen35"),
		]);
		writeFileSync(file, header);
		expect(readGgufArchitecture(file)).toBe("qwen35");
	});

	it("a non-Gemma architecture becomes a release blocker (metadata mismatch surfaces, never silently ships)", () => {
		writeFileSync(file, validHeader("qwen35"));
		const blockers = collectTextArchitectureBlockers(file);
		expect(blockers).toHaveLength(1);
		expect(blockers[0]).toMatch(/general\.architecture=qwen35/);
		writeFileSync(file, validHeader("gemma4"));
		expect(collectTextArchitectureBlockers(file)).toHaveLength(0);
	});

	it("fuzz: 500 random byte blobs + header mutations never throw, always string|null", () => {
		const rng = makeRng(0x66757a7a);
		const base = validHeader("gemma4");
		for (let i = 0; i < 500; i++) {
			let buf: Buffer;
			if (rng() < 0.5) {
				// Pure random bytes (random length up to 4 KiB, often keeping the
				// GGUF magic so parsing proceeds past the first gate).
				const len = Math.floor(rng() * 4096);
				buf = Buffer.alloc(len);
				for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256);
				if (rng() < 0.5 && len >= 4) buf.write("GGUF", 0, "ascii");
			} else {
				// Bit-flip mutations of the valid header.
				buf = Buffer.from(base);
				const flips = 1 + Math.floor(rng() * 8);
				for (let f = 0; f < flips; f++) {
					const at = Math.floor(rng() * buf.length);
					buf[at] ^= 1 << Math.floor(rng() * 8);
				}
			}
			writeFileSync(file, buf);
			const result = readGgufArchitecture(file);
			expect(
				result === null || typeof result === "string",
				`iteration ${i}`,
			).toBe(true);
		}
	});

	it("returns null for a missing file instead of throwing", () => {
		expect(
			readGgufArchitecture(pathJoin(scratch, "does-not-exist.gguf")),
		).toBeNull();
	});
});
