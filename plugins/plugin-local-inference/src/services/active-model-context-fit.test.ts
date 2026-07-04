/** Verifies `resolveLocalInferenceLoadArgs` sizes the context window to the hardware probe's RAM across model sizes. Deterministic, synthetic probes. */
import { describe, expect, it } from "vitest";
import { resolveLocalInferenceLoadArgs } from "./active-model";
import type { HardwareProbe, InstalledModel } from "./types";

function makeInstalledModel(
	id: string,
	sizeGb: number,
	fileName = `${id}.gguf`,
): InstalledModel {
	return {
		id,
		displayName: id,
		path: `/tmp/${fileName}`,
		sizeBytes: Math.round(sizeGb * 1024 ** 3),
		installedAt: "2026-06-22T00:00:00.000Z",
		lastUsedAt: null,
		source: "eliza-download",
	};
}

function hardware(totalRamGb: number): HardwareProbe {
	return {
		totalRamGb,
		freeRamGb: totalRamGb,
		gpu: null,
		cpuCores: 8,
		platform: "linux",
		arch: "x64",
		appleSilicon: false,
		recommendedBucket: "mid",
		source: "os-fallback",
	};
}

describe("resolveLocalInferenceLoadArgs — runtime context fit", () => {
	it("downscales the catalog context on a constrained host when no override is set", async () => {
		const args = await resolveLocalInferenceLoadArgs(
			makeInstalledModel("eliza-1-2b", 1.4),
			undefined,
			{ hardware: hardware(4) },
		);

		expect(args.contextSize).toBeGreaterThanOrEqual(8192);
		expect(args.contextSize).toBeLessThan(131072);
		expect(args.contextSize).toEqual(expect.any(Number));
		expect((args.contextSize ?? 0) % 4096).toBe(0);
	});

	it("keeps catalog context on a roomy host", async () => {
		const args = await resolveLocalInferenceLoadArgs(
			makeInstalledModel("eliza-1-9b", 5.4),
			undefined,
			{ hardware: hardware(24) },
		);

		expect(args.contextSize).toBe(131072);
	});

	it("keeps explicit context overrides authoritative", async () => {
		const args = await resolveLocalInferenceLoadArgs(
			makeInstalledModel("eliza-1-2b", 1.4),
			{ contextSize: 32768 },
			{ hardware: hardware(4) },
		);

		expect(args.contextSize).toBe(32768);
	});

	it("upgrades KV to f16 on a roomy host when the headroom opt-in is set (#8809 AC#4)", async () => {
		const prev = process.env.ELIZA_PREFER_ACCURATE_KV_WHEN_HEADROOM;
		process.env.ELIZA_PREFER_ACCURATE_KV_WHEN_HEADROOM = "1";
		try {
			const args = await resolveLocalInferenceLoadArgs(
				makeInstalledModel("eliza-1-9b", 5.4),
				undefined,
				{ hardware: hardware(64) },
			);
			expect(args.contextSize).toBe(131072);
			expect(args.cacheTypeK).toBe("f16");
			expect(args.cacheTypeV).toBe("f16");
		} finally {
			if (prev === undefined) {
				delete process.env.ELIZA_PREFER_ACCURATE_KV_WHEN_HEADROOM;
			} else {
				process.env.ELIZA_PREFER_ACCURATE_KV_WHEN_HEADROOM = prev;
			}
		}
	});

	it("leaves KV at the q8_0 default when the headroom opt-in is off", async () => {
		const args = await resolveLocalInferenceLoadArgs(
			makeInstalledModel("eliza-1-9b", 5.4),
			undefined,
			{ hardware: hardware(64) },
		);

		expect(args.cacheTypeK).not.toBe("f16");
		expect(args.cacheTypeV).not.toBe("f16");
	});

	it("clamps the context window to the mobile ceiling on android/ios (#8848)", async () => {
		const prevPlatform = process.env.ELIZA_MOBILE_PLATFORM;
		const prevCeiling = process.env.ELIZA_MOBILE_CONTEXT_CEILING;
		try {
			process.env.ELIZA_MOBILE_PLATFORM = "android";
			process.env.ELIZA_MOBILE_CONTEXT_CEILING = "4096";
			// A 128k-context tier on a roomy host keeps the full 131072 on desktop
			// (see "keeps catalog context on a roomy host"). On a phone, loading that
			// KV at full width OOMs / never lands the first reply (#8848), so it must
			// be clamped to the mobile ceiling instead of silently running full-width.
			const args = await resolveLocalInferenceLoadArgs(
				makeInstalledModel("eliza-1-9b", 5.4),
				undefined,
				{ hardware: hardware(24) },
			);
			expect(args.contextSize).toBe(4096);
		} finally {
			if (prevPlatform === undefined) delete process.env.ELIZA_MOBILE_PLATFORM;
			else process.env.ELIZA_MOBILE_PLATFORM = prevPlatform;
			if (prevCeiling === undefined)
				delete process.env.ELIZA_MOBILE_CONTEXT_CEILING;
			else process.env.ELIZA_MOBILE_CONTEXT_CEILING = prevCeiling;
		}
	});
});
