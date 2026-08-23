/**
 * Verifies strict resolution of the documented prompt-batcher environment
 * settings at one boundary: explicit values must be finite decimals in the
 * domain their consumers require, absent or blank values retain defaults, and
 * invalid values throw a fatal ElizaError.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaError } from "../../errors";
import { resolvePromptBatcherSettings } from "./config";

const envRead = vi.fn();

vi.mock("../environment", () => ({
	getEnv: (...args: unknown[]) => envRead(...args),
}));

describe("resolvePromptBatcherSettings", () => {
	afterEach(() => {
		envRead.mockReset();
	});

	it("returns documented defaults when every variable is unset", () => {
		envRead.mockReturnValue(undefined);
		const { dispatcher, batcher } = resolvePromptBatcherSettings();

		expect(batcher.batchSize).toBe(8);
		expect(batcher.maxDrainIntervalMs).toBe(30_000);
		expect(batcher.maxSectionsPerCall).toBe(8);
		expect(batcher.packingDensity).toBe(0.85);
		expect(batcher.maxTokensPerCall).toBe(24_000);
		expect(batcher.maxParallelCalls).toBe(2);
		expect(batcher.modelSeparation).toBe(1);

		expect(dispatcher).toEqual({
			packingDensity: 0.85,
			maxTokensPerCall: 24_000,
			maxParallelCalls: 2,
			modelSeparation: 1,
			maxSectionsPerCall: 8,
		});
	});

	it("honors explicit valid integer settings", () => {
		envRead.mockImplementation((key: string) => {
			if (key === "PROMPT_BATCHER_BATCH_SIZE") return "16";
			if (key === "PROMPT_BATCHER_MAX_PARALLEL_CALLS") return "4";
			return undefined;
		});
		const { batcher } = resolvePromptBatcherSettings();
		expect(batcher.batchSize).toBe(16);
		expect(batcher.maxParallelCalls).toBe(4);
		expect(batcher.maxSectionsPerCall).toBe(8);
	});

	it("honors explicit unit-interval settings", () => {
		envRead.mockImplementation((key: string) => {
			if (key === "PROMPT_BATCHER_PACKING_DENSITY") return "0.5";
			if (key === "PROMPT_BATCHER_MODEL_SEPARATION") return "1";
			return undefined;
		});
		const { batcher } = resolvePromptBatcherSettings();
		expect(batcher.packingDensity).toBe(0.5);
		expect(batcher.modelSeparation).toBe(1);
	});

	it("trims surrounding whitespace before parsing", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_BATCH_SIZE" ? "  16  " : undefined,
		);
		expect(resolvePromptBatcherSettings().batcher.batchSize).toBe(16);
	});

	it("retains defaults for blank values", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_BATCH_SIZE" ? "   " : undefined,
		);
		expect(resolvePromptBatcherSettings().batcher.batchSize).toBe(8);
	});

	it("accepts scientific notation that lands on a valid integer", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_MAX_TOKENS_PER_CALL" ? "1e3" : undefined,
		);
		expect(resolvePromptBatcherSettings().batcher.maxTokensPerCall).toBe(1000);
	});

	it("rejects non-numeric garbage for a positive-integer setting", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_BATCH_SIZE" ? "abc" : undefined,
		);
		expect(() => resolvePromptBatcherSettings()).toThrow(ElizaError);
	});

	it("rejects zero and negative values for positive-integer settings", () => {
		for (const bad of ["0", "-3"]) {
			envRead.mockReset();
			envRead.mockImplementation((key: string) =>
				key === "PROMPT_BATCHER_BATCH_SIZE" ? bad : undefined,
			);
			expect(() => resolvePromptBatcherSettings()).toThrow(
				/PROMPT_BATCHER_BATCH_SIZE/,
			);
		}
	});

	it("rejects fractional values for positive-integer settings", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_BATCH_SIZE" ? "8.5" : undefined,
		);
		expect(() => resolvePromptBatcherSettings()).toThrow(ElizaError);
	});

	it("rejects values outside the unit interval", () => {
		for (const bad of ["1.5", "-0.1", "2"]) {
			envRead.mockReset();
			envRead.mockImplementation((key: string) =>
				key === "PROMPT_BATCHER_PACKING_DENSITY" ? bad : undefined,
			);
			expect(() => resolvePromptBatcherSettings()).toThrow(
				/PROMPT_BATCHER_PACKING_DENSITY/,
			);
		}
	});

	it("names the offending setting in the fatal error", () => {
		envRead.mockImplementation((key: string) =>
			key === "PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS" ? "soon" : undefined,
		);
		try {
			resolvePromptBatcherSettings();
			expect.unreachable("expected a throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("PROMPT_BATCHER_CONFIG_INVALID");
			expect((error as ElizaError).message).toContain(
				"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
			);
		}
	});
});
