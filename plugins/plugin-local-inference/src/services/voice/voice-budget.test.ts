import { describe, expect, it } from "vitest";
import { classifyDeviceTier } from "../device-tier";
import type { HardwareProbe } from "../types";
import {
	BudgetExhaustedError,
	createVoiceBudget,
	createVoiceBudgetForTest,
	priorityClassForRole,
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

const poorProbe: HardwareProbe = {
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
		expect(snap.map((s) => s.role)).toEqual([
			"emotion",
			"tts",
			"text-target",
		]);
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
