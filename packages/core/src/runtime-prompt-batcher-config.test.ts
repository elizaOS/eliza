/**
 * Exercises strict prompt-batcher numeric environment validation through the
 * real AgentRuntime constructor. The deterministic harness makes no model calls.
 */
import { afterEach, describe, expect, test } from "vitest";
import { ElizaError } from "./errors";
import { AgentRuntime } from "./runtime";
import type { Character } from "./types";
import { getEnvironment } from "./utils/environment";
import { resolvePromptBatcherSettings } from "./utils/prompt-batcher/config";

const INTEGER_SETTINGS = [
	"PROMPT_BATCHER_BATCH_SIZE",
	"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
	"PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
	"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
	"PROMPT_BATCHER_MAX_PARALLEL_CALLS",
] as const;

const RATIO_SETTINGS = [
	"PROMPT_BATCHER_PACKING_DENSITY",
	"PROMPT_BATCHER_MODEL_SEPARATION",
] as const;

const ALL_SETTINGS = [...INTEGER_SETTINGS, ...RATIO_SETTINGS] as const;
const originalValues = new Map(
	ALL_SETTINGS.map((key) => [key, process.env[key]] as const),
);

function clearEnvironmentCache(): void {
	getEnvironment().clearCache();
}

function createRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: { name: "prompt-batcher-config-test" } as Character,
		logLevel: "fatal",
	});
}

function setOnly(key: (typeof ALL_SETTINGS)[number], value: string): void {
	for (const setting of ALL_SETTINGS) {
		delete process.env[setting];
	}
	process.env[key] = value;
	clearEnvironmentCache();
}

function expectInvalid(
	key: (typeof ALL_SETTINGS)[number],
	value: string,
): void {
	setOnly(key, value);
	let thrown: unknown;
	try {
		createRuntime();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(ElizaError);
	expect(thrown).toMatchObject({
		code: "PROMPT_BATCHER_CONFIG_INVALID",
		severity: "fatal",
		context: { setting: key },
	});
	expect((thrown as Error).message).toContain(key);
	expect((thrown as ElizaError).context).not.toHaveProperty("value");
}

afterEach(() => {
	for (const key of ALL_SETTINGS) {
		const original = originalValues.get(key);
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
	clearEnvironmentCache();
});

describe("AgentRuntime prompt-batcher numeric configuration", () => {
	test("uses defaults when every setting is absent or blank", () => {
		for (const key of ALL_SETTINGS) {
			delete process.env[key];
		}
		clearEnvironmentCache();
		const absentRuntime = createRuntime();
		absentRuntime.promptBatcher.dispose();

		for (const key of ALL_SETTINGS) {
			process.env[key] = "   ";
		}
		clearEnvironmentCache();
		const blankRuntime = createRuntime();
		blankRuntime.promptBatcher.dispose();
	});

	test.each([
		[
			"PROMPT_BATCHER_BATCH_SIZE",
			" 4 ",
			() => resolvePromptBatcherSettings().batcher.batchSize,
		],
		[
			"PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
			"1500",
			() => resolvePromptBatcherSettings().batcher.maxDrainIntervalMs,
		],
		[
			"PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
			"12",
			() => resolvePromptBatcherSettings().batcher.maxSectionsPerCall,
		],
		[
			"PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
			"32000",
			() => resolvePromptBatcherSettings().dispatcher.maxTokensPerCall,
		],
		[
			"PROMPT_BATCHER_MAX_PARALLEL_CALLS",
			"3",
			() => resolvePromptBatcherSettings().dispatcher.maxParallelCalls,
		],
		[
			"PROMPT_BATCHER_PACKING_DENSITY",
			"0.5",
			() => resolvePromptBatcherSettings().dispatcher.packingDensity,
		],
		[
			"PROMPT_BATCHER_MODEL_SEPARATION",
			"0.25",
			() => resolvePromptBatcherSettings().dispatcher.modelSeparation,
		],
	] as const)("accepts valid %s=%s", (key, value, resolvedValue) => {
		setOnly(key, value);
		expect(resolvedValue()).toBe(Number(value));
		const runtime = createRuntime();
		runtime.promptBatcher.dispose();
	});

	test.each(INTEGER_SETTINGS)(
		"rejects invalid positive-integer values for %s",
		(key) => {
			for (const value of [
				"0",
				"-1",
				"1.5",
				"1ms",
				"NaN",
				"Infinity",
				"-Infinity",
				"1e309",
			]) {
				expectInvalid(key, value);
			}
		},
	);

	test.each(RATIO_SETTINGS)("rejects invalid ratio values for %s", (key) => {
		for (const value of [
			"-0.1",
			"1.1",
			"0.5x",
			"NaN",
			"Infinity",
			"-Infinity",
			"1e309",
		]) {
			expectInvalid(key, value);
		}
	});
});
