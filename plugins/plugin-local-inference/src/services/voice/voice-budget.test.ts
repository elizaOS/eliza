import { describe, expect, it } from "vitest";
import { classifyDeviceTier } from "../device-tier";
import type { HardwareProbe } from "../types";
import {
	assessVoiceBundleFits,
	BudgetExhaustedError,
	createVoiceBudget,
	createVoiceBudgetForTest,
	pickVoiceTierSlot,
	priorityClassForRole,
	VOICE_ENSEMBLE_BUDGETS,
	voiceEnsemblePeakMb,
	voiceEnsembleSteadyStateMb,
} from "./voice-budget";

const MB = 1024 * 1024;
const GB = 1024 ** 3;

const maxProbe: HardwareProbe = {
	totalRamGb: 64,
	freeRamGb: 48,
	gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
	cpuCores: 16,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "xl",
	source: "node-llama-cpp",
};

const okayProbe: HardwareProbe = {
	totalRamGb: 16,
	freeRamGb: 8,
	gpu: null,
	cpuCores: 8,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "mid",
	source: "node-llama-cpp",
};

const _poorProbe: HardwareProbe = {
	totalRamGb: 8,
	freeRamGb: 3,
	gpu: null,
	cpuCores: 4,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "small",
	source: "node-llama-cpp",
};

const iosMobileProbe: HardwareProbe = {
	totalRamGb: 6,
	freeRamGb: 3,
	gpu: null,
	cpuCores: 6,
	platform: "darwin",
	arch: "arm64",
	appleSilicon: true,
	recommendedBucket: "small",
	source: "node-llama-cpp",
	mobile: { platform: "ios", availableRamGb: 3.5 },
};

describe("priorityClassForRole", () => {
	it("maps text-target/tts/asr to hot", () => {
		expect(priorityClassForRole("text-target")).toBe("hot");
		expect(priorityClassForRole("tts")).toBe("hot");
		expect(priorityClassForRole("asr")).toBe("hot");
	});

	it("maps vad/embedding to warm", () => {
		expect(priorityClassForRole("vad")).toBe("warm");
		expect(priorityClassForRole("embedding")).toBe("warm");
	});

	it("maps drafter/emotion/speaker-id/vision to cold", () => {
		expect(priorityClassForRole("drafter")).toBe("cold");
		expect(priorityClassForRole("emotion")).toBe("cold");
		expect(priorityClassForRole("speaker-id")).toBe("cold");
		expect(priorityClassForRole("vision")).toBe("cold");
	});
});

describe("createVoiceBudget", () => {
	it("sizes a MAX tier budget at <= 24 GB and >= 16 GB", () => {
		const budget = createVoiceBudget({ probe: maxProbe });
		expect(budget.tier()).toBe("MAX");
		// Effective model memory = max(24 VRAM, 32 RAM/2) = 32; clamped to 24 GB.
		expect(budget.totalBytes()).toBeLessThanOrEqual(24 * GB);
		expect(budget.totalBytes()).toBeGreaterThanOrEqual(16 * GB);
	});

	it("sizes an OKAY tier budget at <= 6 GB", () => {
		const budget = createVoiceBudget({ probe: okayProbe });
		expect(budget.tier()).toBe("OKAY");
		expect(budget.totalBytes()).toBeLessThanOrEqual(6 * GB);
	});

	it("respects maxRamMb override (clamps below natural tier total)", () => {
		const budget = createVoiceBudget({
			probe: maxProbe,
			maxRamMb: 4096, // 4 GB cap
		});
		expect(budget.totalBytes()).toBe(4096 * MB);
	});

	it("ignores maxRamMb when it is larger than the natural tier total", () => {
		const budget = createVoiceBudget({
			probe: okayProbe,
			maxRamMb: 64 * 1024, // 64 GB cap > 6 GB natural
		});
		// Natural tier total wins (clamped).
		expect(budget.totalBytes()).toBeLessThanOrEqual(6 * GB);
	});
});

describe("VoiceBudget.reserve()", () => {
	it("succeeds when bytes fit", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 4 * GB,
			assessment: classifyDeviceTier(maxProbe),
		});

		const res = await budget.reserve({
			modelId: "eliza-1-asr",
			role: "asr",
			bytes: 768 * MB,
		});
		expect(res.role).toBe("asr");
		expect(res.bytes).toBe(768 * MB);
		expect(budget.freeBytes()).toBe(4 * GB - 768 * MB);
	});

	it("evicts cold reservations first under pressure", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 1 * GB,
			assessment: classifyDeviceTier(okayProbe),
		});

		// Fill the budget with a mix of cold + warm.
		const cold = await budget.reserve({
			modelId: "speaker-encoder",
			role: "speaker-id",
			bytes: 256 * MB,
		});
		const warm = await budget.reserve({
			modelId: "embedding",
			role: "embedding",
			bytes: 512 * MB,
		});
		expect(budget.freeBytes()).toBe(256 * MB);

		const evicted: string[] = [];
		// A hot reservation that needs ~300 MB more than free.
		const hot = await budget.reserve({
			modelId: "eliza-1-asr",
			role: "asr",
			bytes: 768 * MB,
			evictHook: async (role) => {
				evicted.push(role);
				return 0;
			},
		});

		// Cold evicts first (speaker-id, priority 18), warm next (embedding, 25).
		expect(evicted[0]).toBe("speaker-id");
		expect(hot.role).toBe("asr");
		// The original cold/warm handles are now stale but `release()` is
		// idempotent — calling them must not throw.
		expect(() => cold.release()).not.toThrow();
		expect(() => warm.release()).not.toThrow();
	});

	it("never evicts higher-priority reservations than the requester", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 1 * GB,
			assessment: classifyDeviceTier(okayProbe),
		});

		// Hot reservation in place.
		const hot = await budget.reserve({
			modelId: "eliza-1-lm",
			role: "text-target",
			bytes: 900 * MB,
		});

		// Cold reservation requests 200 MB; only 124 MB free; nothing
		// lower-priority to evict → must throw.
		await expect(
			budget.reserve({
				modelId: "drafter",
				role: "drafter",
				bytes: 200 * MB,
			}),
		).rejects.toBeInstanceOf(BudgetExhaustedError);

		// Hot reservation must still be there.
		expect(budget.snapshot()[0].role).toBe("text-target");
		hot.release();
	});

	it("throws when request > totalBytes", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 1 * GB,
			assessment: classifyDeviceTier(okayProbe),
		});
		await expect(
			budget.reserve({
				modelId: "huge",
				role: "text-target",
				bytes: 2 * GB,
			}),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
	});

	it("release() is idempotent", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 1 * GB,
			assessment: classifyDeviceTier(okayProbe),
		});
		const res = await budget.reserve({
			modelId: "vad",
			role: "vad",
			bytes: 8 * MB,
		});
		res.release();
		expect(() => res.release()).not.toThrow();
		expect(budget.freeBytes()).toBe(1 * GB);
	});

	it("snapshot() lists reservations in priority order (cold → hot)", async () => {
		const budget = createVoiceBudgetForTest({
			totalBytes: 4 * GB,
			assessment: classifyDeviceTier(maxProbe),
		});
		await budget.reserve({
			modelId: "lm",
			role: "text-target",
			bytes: 500 * MB,
		});
		await budget.reserve({
			modelId: "emotion",
			role: "emotion",
			bytes: 50 * MB,
		});
		await budget.reserve({
			modelId: "tts",
			role: "tts",
			bytes: 700 * MB,
		});

		const snap = budget.snapshot();
		expect(snap.map((s) => s.role)).toEqual(["emotion", "tts", "text-target"]);
	});
});

describe("Mobile fixture (iOS jetsam ceiling)", () => {
	it("classifies iOS as OKAY/POOR with cloud-with-local-voice mode", () => {
		const assessment = classifyDeviceTier(iosMobileProbe);
		expect(["OKAY", "POOR"]).toContain(assessment.tier);
		if (assessment.tier !== "POOR") {
			expect(assessment.recommendedMode).toBe("cloud-with-local-voice");
		} else {
			expect(assessment.recommendedMode).toBe("cloud-only");
		}
		expect(assessment.numericContext.mobile).toBe(true);
	});

	it("the iOS budget tops out small (a few GB at most)", () => {
		const budget = createVoiceBudget({ probe: iosMobileProbe });
		// iOS jetsam ~3-4 GB ceiling — our default budget for a mobile
		// OKAY/POOR device should be at most a few GB.
		expect(budget.totalBytes()).toBeLessThanOrEqual(6 * GB);
	});
});

describe("VOICE_ENSEMBLE_BUDGETS — R9 §2.3 co-resident roll-up", () => {
	it("exposes every tier slot with non-negative MB rows", () => {
		const slots = Object.keys(VOICE_ENSEMBLE_BUDGETS);
		expect(slots).toEqual([
			"mobile-0_8b",
			"desktop-0_8b",
			"desktop-2b",
			"desktop-4b",
			"workstation-9b",
			"workstation-27b",
		]);
		for (const slot of slots) {
			const row =
				VOICE_ENSEMBLE_BUDGETS[slot as keyof typeof VOICE_ENSEMBLE_BUDGETS];
			expect(row.lmMb).toBeGreaterThanOrEqual(0);
			expect(row.ttsMb).toBeGreaterThanOrEqual(0);
			expect(row.asrMb).toBeGreaterThanOrEqual(0);
			expect(row.vadMb).toBeGreaterThan(0);
			expect(row.steadyStateMb).toBeGreaterThan(0);
			expect(row.peakMb).toBeGreaterThanOrEqual(row.steadyStateMb);
		}
	});

	it("scales monotonically — bigger LM tier has bigger steady-state", () => {
		const mobile = VOICE_ENSEMBLE_BUDGETS["mobile-0_8b"].steadyStateMb;
		const desktop = VOICE_ENSEMBLE_BUDGETS["desktop-0_8b"].steadyStateMb;
		const two = VOICE_ENSEMBLE_BUDGETS["desktop-2b"].steadyStateMb;
		const four = VOICE_ENSEMBLE_BUDGETS["desktop-4b"].steadyStateMb;
		const nine = VOICE_ENSEMBLE_BUDGETS["workstation-9b"].steadyStateMb;
		const twentyseven = VOICE_ENSEMBLE_BUDGETS["workstation-27b"].steadyStateMb;
		// desktop adds OmniVoice on top of mobile's kokoro
		expect(desktop).toBeGreaterThan(mobile);
		expect(two).toBeGreaterThan(desktop);
		expect(four).toBeGreaterThan(two);
		expect(nine).toBeGreaterThan(four);
		expect(twentyseven).toBeGreaterThan(nine);
	});

	it("desktop-0_8b includes the ~1.17 GB OmniVoice transient peak", () => {
		const row = VOICE_ENSEMBLE_BUDGETS["desktop-0_8b"];
		expect(row.transientTtsBufferMb).toBeGreaterThan(1000);
		expect(row.peakMb).toBeGreaterThan(row.steadyStateMb + 1000);
	});

	it("mobile-0_8b skips the OmniVoice transient (defaults to cloud TTS)", () => {
		const row = VOICE_ENSEMBLE_BUDGETS["mobile-0_8b"];
		expect(row.transientTtsBufferMb).toBe(0);
		expect(row.peakMb).toBe(row.steadyStateMb);
	});

	it("voiceEnsemblePeakMb / voiceEnsembleSteadyStateMb match the table", () => {
		const row = VOICE_ENSEMBLE_BUDGETS["desktop-2b"];
		expect(voiceEnsemblePeakMb("desktop-2b")).toBe(row.peakMb);
		expect(voiceEnsembleSteadyStateMb("desktop-2b")).toBe(row.steadyStateMb);
	});
});

describe("pickVoiceTierSlot", () => {
	it("picks mobile-0_8b on mobile regardless of text model", () => {
		expect(
			pickVoiceTierSlot({
				textModelId: "eliza-1-9b",
				deviceTier: "GOOD",
				mobile: true,
			}),
		).toBe("mobile-0_8b");
	});

	it("picks workstation-27b for 27B id", () => {
		expect(
			pickVoiceTierSlot({
				textModelId: "eliza-1-27b",
				deviceTier: "MAX",
			}),
		).toBe("workstation-27b");
	});

	it("picks workstation-9b for 9B id", () => {
		expect(
			pickVoiceTierSlot({ textModelId: "eliza-1-9b", deviceTier: "MAX" }),
		).toBe("workstation-9b");
	});

	it("picks desktop-4b / desktop-2b for matching ids", () => {
		expect(
			pickVoiceTierSlot({ textModelId: "eliza-1-4b", deviceTier: "GOOD" }),
		).toBe("desktop-4b");
		expect(
			pickVoiceTierSlot({ textModelId: "eliza-1-2b", deviceTier: "GOOD" }),
		).toBe("desktop-2b");
		expect(
			pickVoiceTierSlot({ textModelId: "eliza-1-1_7b", deviceTier: "GOOD" }),
		).toBe("desktop-2b");
	});

	it("falls through to desktop-0_8b for small / unknown ids", () => {
		expect(
			pickVoiceTierSlot({ textModelId: "eliza-1-0_8b", deviceTier: "OKAY" }),
		).toBe("desktop-0_8b");
		expect(
			pickVoiceTierSlot({ textModelId: "unknown", deviceTier: "MAX" }),
		).toBe("desktop-0_8b");
	});
});

describe("assessVoiceBundleFits", () => {
	it("fits when host RAM >> peakMb", () => {
		const decision = assessVoiceBundleFits({
			tierSlot: "desktop-0_8b",
			deviceTier: "GOOD",
			hostRamMb: 32 * 1024,
		});
		expect(decision.level).toBe("fits");
		expect(decision.fits).toBe(true);
	});

	it("tight when host fits steady-state but not peak", () => {
		const ensemble = VOICE_ENSEMBLE_BUDGETS["desktop-0_8b"];
		// reserveMb=0 makes the math trivial: usableMb === hostRamMb
		const tightHostMb = Math.ceil(ensemble.steadyStateMb + 50);
		const decision = assessVoiceBundleFits({
			tierSlot: "desktop-0_8b",
			deviceTier: "GOOD",
			hostRamMb: tightHostMb,
			reserveMb: 0,
		});
		expect(decision.level).toBe("tight");
		expect(decision.fits).toBe(true);
	});

	it("wontfit for the 27B bundle on an 8 GB box (R9 §3.2)", () => {
		const decision = assessVoiceBundleFits({
			tierSlot: "workstation-27b",
			deviceTier: "POOR",
			hostRamMb: 8 * 1024,
		});
		expect(decision.level).toBe("wontfit");
		expect(decision.fits).toBe(false);
	});
});
