/**
 * Deterministic coverage for the prompt-batcher environment boundary in
 * config.ts, exercised through the real Environment/getEnv read path (no
 * mocks): absent and blank settings retain the documented defaults, decimal
 * syntax variants parse, overrides land in both the dispatcher and batcher
 * views, and malformed or out-of-domain values reject the whole resolution
 * with a fatal PROMPT_BATCHER_CONFIG_INVALID ElizaError naming the offending
 * key and expected domain.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElizaError } from "../../errors.ts";
import { getEnvironment } from "../environment.ts";
import { resolvePromptBatcherSettings } from "./config.ts";

const ENV_KEYS = [
	"PROMPT_BATCHER_BATCH_SIZE",
	"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
	"PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
	"PROMPT_BATCHER_PACKING_DENSITY",
	"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
	"PROMPT_BATCHER_MAX_PARALLEL_CALLS",
	"PROMPT_BATCHER_MODEL_SEPARATION",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

/** Documented default payload, duplicated here so drift in either direction fails. */
const DEFAULTS = {
	dispatcher: {
		packingDensity: 0.85,
		maxTokensPerCall: 24_000,
		maxParallelCalls: 2,
		modelSeparation: 1,
		maxSectionsPerCall: 8,
	},
	batcher: {
		batchSize: 8,
		maxDrainIntervalMs: 30_000,
		maxSectionsPerCall: 8,
		packingDensity: 0.85,
		maxTokensPerCall: 24_000,
		maxParallelCalls: 2,
		modelSeparation: 1,
	},
};

function setOnly(key: EnvKey, value: string): void {
	process.env[key] = value;
	getEnvironment().clearCache();
}

function setAll(values: Record<EnvKey, string>): void {
	for (const key of ENV_KEYS) {
		process.env[key] = values[key];
	}
	getEnvironment().clearCache();
}

function resolveInvalid(key: EnvKey, raw: string): ElizaError {
	setOnly(key, raw);
	try {
		resolvePromptBatcherSettings();
	} catch (error) {
		expect(error).toBeInstanceOf(ElizaError);
		return error as ElizaError;
	}
	throw new Error(
		`expected ${key}=${JSON.stringify(raw)} to be rejected, but resolution succeeded`,
	);
}

let saved: Record<EnvKey, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<EnvKey, string | undefined>;
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
	getEnvironment().clearCache();
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = saved[key];
		if (prior === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = prior;
		}
	}
	getEnvironment().clearCache();
});

describe("resolvePromptBatcherSettings defaults", () => {
	it("returns the documented defaults when every setting is absent", () => {
		expect(resolvePromptBatcherSettings()).toEqual(DEFAULTS);
	});

	it.each([
		["PROMPT_BATCHER_BATCH_SIZE", "batchSize", 8],
		["PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS", "maxDrainIntervalMs", 30_000],
		["PROMPT_BATCHER_MAX_SECTIONS_PER_CALL", "maxSectionsPerCall", 8],
		["PROMPT_BATCHER_PACKING_DENSITY", "packingDensity", 0.85],
		["PROMPT_BATCHER_MAX_TOKENS_PER_CALL", "maxTokensPerCall", 24_000],
		["PROMPT_BATCHER_MAX_PARALLEL_CALLS", "maxParallelCalls", 2],
		["PROMPT_BATCHER_MODEL_SEPARATION", "modelSeparation", 1],
	] as const)(
		"keeps the %s default when the value is blank",
		(key, field, fallback) => {
			setOnly(key, "   ");
			const resolved = resolvePromptBatcherSettings();
			expect(resolved.batcher[field]).toBe(fallback);
			expect(Object.keys(DEFAULTS.batcher)).toContain(field);
		},
	);
});

describe("resolvePromptBatcherSettings parses valid overrides", () => {
	it("propagates parsed overrides into both dispatcher and batcher views", () => {
		setAll({
			PROMPT_BATCHER_BATCH_SIZE: "12",
			PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS: "1500",
			PROMPT_BATCHER_MAX_SECTIONS_PER_CALL: "5",
			PROMPT_BATCHER_PACKING_DENSITY: ".5",
			PROMPT_BATCHER_MAX_TOKENS_PER_CALL: "+9000",
			PROMPT_BATCHER_MAX_PARALLEL_CALLS: "3",
			PROMPT_BATCHER_MODEL_SEPARATION: "0",
		});

		expect(resolvePromptBatcherSettings()).toEqual({
			batcher: {
				batchSize: 12,
				maxDrainIntervalMs: 1500,
				maxSectionsPerCall: 5,
				packingDensity: 0.5,
				maxTokensPerCall: 9000,
				maxParallelCalls: 3,
				modelSeparation: 0,
			},
			dispatcher: {
				packingDensity: 0.5,
				maxTokensPerCall: 9000,
				maxParallelCalls: 3,
				modelSeparation: 0,
				maxSectionsPerCall: 5,
			},
		});
	});

	it.each([
		["surrounding whitespace", " 12 ", 12],
		["trailing decimal point", "20.", 20],
		["scientific notation", "2e1", 20],
	])(
		"accepts %s as %i for a positive-integer setting",
		(_label, raw, value) => {
			setOnly("PROMPT_BATCHER_BATCH_SIZE", raw);
			expect(resolvePromptBatcherSettings().batcher.batchSize).toBe(value);
		},
	);

	it("accepts both unit-interval boundaries for packing density", () => {
		setOnly("PROMPT_BATCHER_PACKING_DENSITY", "1");
		expect(resolvePromptBatcherSettings().dispatcher.packingDensity).toBe(1);

		setOnly("PROMPT_BATCHER_PACKING_DENSITY", "0");
		expect(resolvePromptBatcherSettings().dispatcher.packingDensity).toBe(0);
	});

	it("treats model separation as a unit interval despite its integral default", () => {
		setOnly("PROMPT_BATCHER_MODEL_SEPARATION", "0.5");
		expect(resolvePromptBatcherSettings().batcher.modelSeparation).toBe(0.5);
	});
});

describe("resolvePromptBatcherSettings rejects invalid configuration", () => {
	it.each(["abc", "12px", "1,000", "--4", ".", "NaN", "0x10"])(
		"rejects non-decimal %j with a typed fatal error",
		(raw) => {
			const error = resolveInvalid("PROMPT_BATCHER_BATCH_SIZE", raw);
			expect(error.code).toBe("PROMPT_BATCHER_CONFIG_INVALID");
			expect(error.severity).toBe("fatal");
			expect(error.context?.setting).toBe("PROMPT_BATCHER_BATCH_SIZE");
			expect(error.context?.expected).toBe("a positive integer");
			expect(error.message).toContain("PROMPT_BATCHER_BATCH_SIZE");
		},
	);

	it.each(["0", "-4", "2.5"])(
		"rejects out-of-domain %j for a positive-integer setting",
		(raw) => {
			const error = resolveInvalid("PROMPT_BATCHER_MAX_PARALLEL_CALLS", raw);
			expect(error.code).toBe("PROMPT_BATCHER_CONFIG_INVALID");
			expect(error.context?.expected).toBe("a positive integer");
		},
	);

	it("rejects values overflowing finite doubles even in decimal syntax", () => {
		const error = resolveInvalid("PROMPT_BATCHER_BATCH_SIZE", "1e400");
		expect(error.code).toBe("PROMPT_BATCHER_CONFIG_INVALID");
		expect(error.context?.expected).toBe("a positive integer");
	});

	it.each(["-0.25", "1.01"])(
		"rejects out-of-domain %j for a unit-interval setting",
		(raw) => {
			const error = resolveInvalid("PROMPT_BATCHER_PACKING_DENSITY", raw);
			expect(error.code).toBe("PROMPT_BATCHER_CONFIG_INVALID");
			expect(error.context?.setting).toBe("PROMPT_BATCHER_PACKING_DENSITY");
			expect(error.context?.expected).toBe("a finite number from 0 through 1");
		},
	);

	it("fails the whole resolution on the first invalid setting in documented order", () => {
		process.env.PROMPT_BATCHER_BATCH_SIZE = "nope";
		process.env.PROMPT_BATCHER_MAX_TOKENS_PER_CALL = "also-nope";
		getEnvironment().clearCache();

		const error = resolveInvalid("PROMPT_BATCHER_BATCH_SIZE", "nope");
		expect(error.context?.setting).toBe("PROMPT_BATCHER_BATCH_SIZE");
		expect(error.context?.setting).not.toBe(
			"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
		);
	});
});
