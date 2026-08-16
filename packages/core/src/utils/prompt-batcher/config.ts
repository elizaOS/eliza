/**
 * Resolves the runtime's documented prompt-batcher environment settings at one
 * strict boundary. Explicit values must be finite decimal numbers in the
 * domain required by their consumers; absent or blank values retain defaults.
 */
import { ElizaError } from "../../errors";
import { getEnv } from "../environment";
import type { PromptBatcherSettings, PromptDispatcherSettings } from "./shared";

type PromptBatcherNumericSetting = {
	key: string;
	defaultValue: number;
	domain: "positive-integer" | "unit-interval";
};

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

const SETTINGS = {
	batchSize: {
		key: "PROMPT_BATCHER_BATCH_SIZE",
		defaultValue: 8,
		domain: "positive-integer",
	},
	maxDrainIntervalMs: {
		key: "PROMPT_BATCHER_MAX_DRAIN_INTERVAL_MS",
		defaultValue: 30_000,
		domain: "positive-integer",
	},
	maxSectionsPerCall: {
		key: "PROMPT_BATCHER_MAX_SECTIONS_PER_CALL",
		defaultValue: 8,
		domain: "positive-integer",
	},
	packingDensity: {
		key: "PROMPT_BATCHER_PACKING_DENSITY",
		defaultValue: 0.85,
		domain: "unit-interval",
	},
	maxTokensPerCall: {
		key: "PROMPT_BATCHER_MAX_TOKENS_PER_CALL",
		defaultValue: 24_000,
		domain: "positive-integer",
	},
	maxParallelCalls: {
		key: "PROMPT_BATCHER_MAX_PARALLEL_CALLS",
		defaultValue: 2,
		domain: "positive-integer",
	},
	modelSeparation: {
		key: "PROMPT_BATCHER_MODEL_SEPARATION",
		defaultValue: 1,
		domain: "unit-interval",
	},
} as const satisfies Record<string, PromptBatcherNumericSetting>;

function expectedDomain(domain: PromptBatcherNumericSetting["domain"]): string {
	return domain === "positive-integer"
		? "a positive integer"
		: "a finite number from 0 through 1";
}

function invalidSetting(setting: PromptBatcherNumericSetting): ElizaError {
	const expected = expectedDomain(setting.domain);
	return new ElizaError(
		`Prompt batcher setting ${setting.key} must be ${expected}.`,
		{
			code: "PROMPT_BATCHER_CONFIG_INVALID",
			context: { setting: setting.key, expected },
			severity: "fatal",
		},
	);
}

function resolveNumber(setting: PromptBatcherNumericSetting): number {
	const raw = getEnv(setting.key);
	if (raw === undefined || raw.trim() === "") {
		return setting.defaultValue;
	}

	const normalized = raw.trim();
	if (!DECIMAL_NUMBER.test(normalized)) {
		throw invalidSetting(setting);
	}

	const value = Number(normalized);
	const valid =
		Number.isFinite(value) &&
		(setting.domain === "positive-integer"
			? Number.isInteger(value) && value > 0
			: value >= 0 && value <= 1);
	if (!valid) {
		throw invalidSetting(setting);
	}
	return value;
}

export function resolvePromptBatcherSettings(): {
	dispatcher: PromptDispatcherSettings;
	batcher: PromptBatcherSettings;
} {
	const batchSize = resolveNumber(SETTINGS.batchSize);
	const maxDrainIntervalMs = resolveNumber(SETTINGS.maxDrainIntervalMs);
	const maxSectionsPerCall = resolveNumber(SETTINGS.maxSectionsPerCall);
	const packingDensity = resolveNumber(SETTINGS.packingDensity);
	const maxTokensPerCall = resolveNumber(SETTINGS.maxTokensPerCall);
	const maxParallelCalls = resolveNumber(SETTINGS.maxParallelCalls);
	const modelSeparation = resolveNumber(SETTINGS.modelSeparation);

	return {
		dispatcher: {
			packingDensity,
			maxTokensPerCall,
			maxParallelCalls,
			modelSeparation,
			maxSectionsPerCall,
		},
		batcher: {
			batchSize,
			maxDrainIntervalMs,
			maxSectionsPerCall,
			packingDensity,
			maxTokensPerCall,
			maxParallelCalls,
			modelSeparation,
		},
	};
}
