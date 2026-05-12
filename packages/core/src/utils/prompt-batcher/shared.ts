import type { Memory } from "../../types/memory";
import type {
	BatcherResult,
	PromptSection,
	ResolvedSection,
} from "../../types/prompt-batcher";
import type { IAgentRuntime } from "../../types/runtime";
import type { SchemaRow, State } from "../../types/state";
import { toMultilineText } from "../text-normalize";

export type Deferred<T> = {
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

export type CacheEntry = {
	fields: Record<string, unknown>;
	expiresAt: number;
};

/** Tracks a section's promise. resolved guards so we never resolve and reject the same deferred. */
export type PendingResult = {
	deferred: Deferred<BatcherResult | null>;
	resolved: boolean;
};

export type DispatchCallMeta = {
	model: "small" | "large";
	sectionIds: string[];
	estimatedTokens: number;
	durationMs: number;
	success: boolean;
	retried: boolean;
	fallbackUsed: string[];
};

export type DispatchOutcome = {
	results: Map<string, Record<string, unknown>>;
	calls: DispatchCallMeta[];
};

export type CallPlan = {
	sections: ResolvedSection[];
	model: "small" | "large";
	totalEstimatedTokens: number;
	priority: "background" | "normal" | "immediate";
};

export type PromptDispatcherSettings = {
	packingDensity: number;
	maxTokensPerCall: number;
	maxParallelCalls: number;
	modelSeparation: number;
	maxSectionsPerCall: number;
};

export type PromptBatcherSettings = {
	batchSize: number;
	maxDrainIntervalMs: number;
	maxSectionsPerCall: number;
	packingDensity: number;
	maxTokensPerCall: number;
	maxParallelCalls: number;
	modelSeparation: number;
};

/**
 * Re-export so dispatcher keeps `import { Semaphore } from "./shared"`.
 * Single `Semaphore` implementation under `utils/batch-queue` (see `batch-queue.ts` header).
 */
export { Semaphore } from "../batch-queue/semaphore.js";

export function sanitizeIdentifier(value: string): string {
	const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_");
	if (/^[a-zA-Z_]/.test(normalized)) {
		return normalized;
	}
	return `section_${normalized}`;
}

export function clampRetryCount(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0;
	}
	return Math.max(0, Math.min(2, Math.floor(value)));
}

export function createMinimalState(context: string): State {
	return {
		text: context,
		values: {
			batcherContext: context,
		},
		data: {},
	};
}

export function buildCharacterContext(runtime: IAgentRuntime): string {
	const topics = toMultilineText(runtime.character.topics);
	const bio = toMultilineText(runtime.character.bio);
	const style = toMultilineText(runtime.character.style);
	const documents = toMultilineText(
		runtime.character.documents ?? runtime.character.knowledge,
	);

	return [
		`Agent Name: ${runtime.character.name ?? "Unknown"}`,
		bio ? `Bio:\n${bio}` : "",
		style ? `Style:\n${style}` : "",
		topics ? `Topics:\n${topics}` : "",
		documents ? `Documents:\n${documents}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

export function getSourceMessageId(message: Memory): string {
	const metadata = (message.metadata ?? {}) as Record<string, unknown>;
	const content = (message.content ?? {}) as Record<string, unknown>;

	const discordId = metadata.discordMessageId;
	if (typeof discordId === "string" && discordId) {
		return `discord:${discordId}`;
	}

	const telegramId = content.messageId;
	if (telegramId != null) {
		return `telegram:${String(telegramId)}`;
	}

	const slack = metadata.slack;
	if (
		slack &&
		typeof slack === "object" &&
		"messageTs" in (slack as Record<string, unknown>)
	) {
		return `slack:${String((slack as Record<string, unknown>).messageTs)}`;
	}

	return `internal:${message.id}`;
}

export function pickFields(
	fields: Record<string, unknown> | null | undefined,
	schema: SchemaRow[],
): Record<string, unknown> {
	const picked: Record<string, unknown> = {};
	if (!fields) {
		return picked;
	}

	for (const row of schema) {
		if (row.field in fields) {
			picked[row.field] = fields[row.field];
		}
	}

	return picked;
}

export function hasMeaningfulSectionDrift(
	existing: PromptSection,
	incoming: PromptSection,
): boolean {
	const comparableExisting = {
		frequency: existing.frequency,
		providers: existing.providers,
		preamble: existing.preamble,
		schema: existing.schema,
		priority: existing.priority,
		model: existing.model,
		affinityKey: existing.affinityKey,
	};
	const comparableIncoming = {
		frequency: incoming.frequency,
		providers: incoming.providers,
		preamble: incoming.preamble,
		schema: incoming.schema,
		priority: incoming.priority,
		model: incoming.model,
		affinityKey: incoming.affinityKey,
	};
	return (
		JSON.stringify(comparableExisting) !== JSON.stringify(comparableIncoming)
	);
}

export function rollingAverage(
	current: number,
	count: number,
	nextValue: number,
): number {
	if (count <= 1) {
		return nextValue;
	}

	return current + (nextValue - current) / count;
}
