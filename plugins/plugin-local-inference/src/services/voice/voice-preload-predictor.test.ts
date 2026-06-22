/**
 * Voice next-stage preload predictor — real-MemoryArbiter test (#8809 C5).
 *
 * Mirrors `packages/benchmarks/memperf/co-residency.test.ts`: drives the REAL
 * `MemoryArbiter` (no models, no FFI) with a synthetic, SIZED "text" capability
 * and a real `capacitorPressureSource`, then asserts the predictor's
 * `onAsrStageComplete()` warms the next-stage text model under nominal pressure
 * (resident before its first request) and is REFUSED under critical pressure
 * (not resident). This exercises the genuine `preload` guard — not a stub.
 */

import { describe, expect, it } from "vitest";

import { MemoryArbiter } from "../memory-arbiter";
import { capacitorPressureSource } from "../memory-pressure";
import { SharedResourceRegistry } from "./shared-resources";
import { VoicePreloadPredictor } from "./voice-preload-predictor";

const TEXT_MODEL_KEY = "eliza-1-4b";
const TEXT_MODEL_MB = 1200;

function makeHarness(budgetMb: number) {
	const pressure = capacitorPressureSource();
	const arbiter = new MemoryArbiter({
		registry: new SharedResourceRegistry(),
		pressureSource: pressure,
		budgetMb: () => budgetMb,
	});
	// Synthetic SIZED text loader — the next-stage model the arbiter owns on the
	// mobile path. No FFI; load() just yields a marker object.
	arbiter.registerCapability({
		capability: "text",
		estimatedMb: TEXT_MODEL_MB,
		load: async () => ({ cap: "text" as const }),
		unload: async () => {},
		run: async () => ({}),
	});
	arbiter.start();
	const predictor = new VoicePreloadPredictor({
		arbiter,
		resolveTextModelKey: () => TEXT_MODEL_KEY,
	});
	return { arbiter, pressure, predictor };
}

function textResident(arbiter: MemoryArbiter): boolean {
	return arbiter
		.residentSnapshot()
		.some((e) => e.capability === "text" && e.modelKey === TEXT_MODEL_KEY);
}

describe("VoicePreloadPredictor — real arbiter next-stage preload", () => {
	it("warms the next-stage text model under nominal pressure + sufficient budget", async () => {
		const { arbiter, predictor } = makeHarness(8000);
		try {
			// Before the ASR stage finishes the text model is not resident.
			expect(textResident(arbiter)).toBe(false);

			const warmed = await predictor.onAsrStageComplete();

			// The predictor warmed the text model: it is RESIDENT before its first
			// request, so the post-ASR verifier pays no cold load.
			expect(warmed).toBe(TEXT_MODEL_KEY);
			expect(textResident(arbiter)).toBe(true);
		} finally {
			await arbiter.shutdown();
		}
	});

	it("refuses the preload under critical pressure (next-stage model not resident)", async () => {
		const { arbiter, pressure, predictor } = makeHarness(8000);
		try {
			// The OS flags critical memory pressure while ASR is running.
			pressure.dispatch("critical", 32);
			await new Promise((r) => setTimeout(r, 10));
			expect(arbiter.currentPressureLevel()).toBe("critical");

			const warmed = await predictor.onAsrStageComplete();

			// preload is REFUSED: returns null (not the key), and the text model is
			// NOT resident — the predictor never forces a load onto a system the OS
			// has already flagged as in trouble.
			expect(warmed).toBeNull();
			expect(textResident(arbiter)).toBe(false);
		} finally {
			await arbiter.shutdown();
		}
	});

	it("refuses the preload when the next-stage footprint exceeds the budget", async () => {
		// Budget below the text model's footprint → preload declines (no eviction
		// theatre, no forced load) even under nominal pressure.
		const { arbiter, predictor } = makeHarness(TEXT_MODEL_MB - 1);
		try {
			const warmed = await predictor.onAsrStageComplete();
			expect(warmed).toBeNull();
			expect(textResident(arbiter)).toBe(false);
		} finally {
			await arbiter.shutdown();
		}
	});

	it("declines to predict when no text model is assigned", async () => {
		const pressure = capacitorPressureSource();
		const noModelArbiter = new MemoryArbiter({
			registry: new SharedResourceRegistry(),
			pressureSource: pressure,
			budgetMb: () => 8000,
		});
		noModelArbiter.registerCapability({
			capability: "text",
			estimatedMb: TEXT_MODEL_MB,
			load: async () => ({ cap: "text" as const }),
			unload: async () => {},
			run: async () => ({}),
		});
		noModelArbiter.start();
		const predictor = new VoicePreloadPredictor({
			arbiter: noModelArbiter,
			resolveTextModelKey: () => null,
		});
		try {
			const warmed = await predictor.onAsrStageComplete();
			expect(warmed).toBeNull();
			expect(textResident(noModelArbiter)).toBe(false);
		} finally {
			await noModelArbiter.shutdown();
		}
	});
});
