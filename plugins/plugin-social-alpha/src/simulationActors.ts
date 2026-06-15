import fs from "node:fs/promises";

// Backward-compatible re-exports from the new location.

// Re-export specific types that benchmark tests expect
export type {
	SimulatedActorV2 as SimulatedActor,
	SimulatedCallV2 as SimulatedCall,
} from "./services/simulationActorsV2";
export * from "./services/simulationActorsV2";

// Import the actual types to extend
import type {
	ActorArchetypeV2,
	SimulatedActorV2,
} from "./services/simulationActorsV2";

interface LegacyTokenLike {
	address: string;
	symbol: string;
}

interface LegacyGeneratedCall {
	tokenAddress: string;
	timestamp: number;
	conviction: "HIGH" | "MEDIUM";
	sentiment: "positive" | "neutral";
	content: string;
}

type DiscordActorRecord = Record<string, unknown> & {
	messages?: unknown[];
};

const ACTOR_ARCHETYPES = new Set<ActorArchetypeV2>([
	"elite_analyst",
	"skilled_trader",
	"pump_chaser",
	"rug_promoter",
	"fomo_trader",
	"contrarian",
	"whale_watcher",
	"technical_analyst",
	"newbie",
	"bot_spammer",
]);

// Define the missing types and functions for backward compatibility
export type CallGenerationStrategy = (
	actor: SimulatedActorWithLegacy,
	token: LegacyTokenLike,
	currentStep: number,
	priceHistory: unknown[],
) => LegacyGeneratedCall | null;

// Extended type that includes the old properties
export interface SimulatedActorWithLegacy extends SimulatedActorV2 {
	expectedTrustScore?: number;
	callGenerationStrategy?: CallGenerationStrategy;
	actorSpecificData?: {
		calls?: unknown[];
	};
}

// Helper function to map old archetype names to new ones
function mapArchetype(archetype: string): ActorArchetypeV2 {
	const mapping: Record<string, ActorArchetypeV2> = {
		good_caller: "elite_analyst",
		bad_shiller: "rug_promoter",
		neutral_observer: "technical_analyst",
	};
	if (mapping[archetype]) return mapping[archetype];
	return ACTOR_ARCHETYPES.has(archetype as ActorArchetypeV2)
		? (archetype as ActorArchetypeV2)
		: "technical_analyst";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(
	record: Record<string, unknown>,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return null;
}

function actorFromRecord(
	record: Record<string, unknown>,
): SimulatedActorWithLegacy {
	const id =
		pickString(record, ["id", "userId", "authorId", "author_id"]) ??
		`actor-${Math.random().toString(36).slice(2)}`;
	const username =
		pickString(record, ["username", "name", "displayName", "author"]) ?? id;
	const archetype = mapArchetype(
		pickString(record, ["archetype", "type"]) ?? "technical_analyst",
	) as ActorArchetypeV2;
	const calls = Array.isArray(record.calls)
		? record.calls
		: Array.isArray(record.messages)
			? record.messages
			: [];

	return {
		id: id as SimulatedActorWithLegacy["id"],
		username,
		archetype,
		trustScore:
			typeof record.trustScore === "number" ? record.trustScore : undefined,
		expectedTrustScore:
			typeof record.expectedTrustScore === "number"
				? record.expectedTrustScore
				: undefined,
		callHistory: [],
		preferences: {
			callFrequency: "medium",
			timingBias: "random",
		},
		actorSpecificData: { calls },
	};
}

function actorRecordsFromDiscordData(data: unknown): DiscordActorRecord[] {
	if (Array.isArray(data)) {
		return data.filter(isRecord);
	}
	if (!isRecord(data)) {
		return [];
	}
	for (const key of ["actors", "users", "participants"]) {
		const value = data[key];
		if (Array.isArray(value)) {
			return value.filter(isRecord);
		}
	}
	if (Array.isArray(data.messages)) {
		const byUser = new Map<string, DiscordActorRecord>();
		for (const message of data.messages) {
			if (!isRecord(message)) continue;
			const id =
				pickString(message, ["userId", "authorId", "author_id"]) ??
				(isRecord(message.author)
					? pickString(message.author, ["id", "userId"])
					: null);
			if (!id) continue;
			const existing = byUser.get(id);
			if (existing) {
				if (!existing.messages) {
					existing.messages = [];
				}
				existing.messages.push(message);
				continue;
			}
			const author = isRecord(message.author) ? message.author : {};
			byUser.set(id, {
				id,
				username:
					pickString(message, ["username", "authorName"]) ??
					pickString(author, ["username", "name", "displayName"]) ??
					id,
				messages: [message],
			});
		}
		return Array.from(byUser.values());
	}
	return [];
}

// Deterministic strategy fixtures for benchmark tests
export const goodActorStrategy: CallGenerationStrategy = (
	_actor,
	token,
	currentStep,
	_priceHistory,
) => {
	// Simulate a good actor making a positive call
	if (Math.random() < 0.3) {
		return {
			tokenAddress: token.address,
			timestamp: Date.now() + currentStep * 86400000,
			conviction: "HIGH",
			sentiment: "positive",
			content: `$${token.symbol} looking strong!`,
		};
	}
	return null;
};

export const badActorStrategy: CallGenerationStrategy = (
	_actor,
	token,
	currentStep,
	_priceHistory,
) => {
	// Simulate a bad actor shilling
	if (Math.random() < 0.5) {
		return {
			tokenAddress: token.address,
			timestamp: Date.now() + currentStep * 86400000,
			conviction: "HIGH",
			sentiment: "positive",
			content: `🚀 $${token.symbol} TO THE MOON! 1000X!`,
		};
	}
	return null;
};

export const neutralObserverStrategy: CallGenerationStrategy = (
	_actor,
	token,
	currentStep,
	_priceHistory,
) => {
	// Simulate neutral observations
	if (Math.random() < 0.2) {
		return {
			tokenAddress: token.address,
			timestamp: Date.now() + currentStep * 86400000,
			conviction: "MEDIUM",
			sentiment: "neutral",
			content: `Watching $${token.symbol}`,
		};
	}
	return null;
};

export const dataDrivenShillStrategy: CallGenerationStrategy = badActorStrategy;

export async function parseDiscordDataToActors(
	filePath: string,
	_runtime: unknown,
): Promise<SimulatedActorWithLegacy[]> {
	const content = await fs.readFile(filePath, "utf8");
	const data = JSON.parse(content) as unknown;
	return actorRecordsFromDiscordData(data).map(actorFromRecord);
}

// Helper to create a legacy-compatible actor
export function createLegacyActor(params: {
	id: string;
	username: string;
	archetype: string;
	expectedTrustScore?: number;
	callGenerationStrategy?: CallGenerationStrategy;
}): SimulatedActorWithLegacy {
	return {
		id: params.id,
		username: params.username,
		archetype: mapArchetype(params.archetype),
		trustScore: params.expectedTrustScore,
		expectedTrustScore: params.expectedTrustScore,
		callGenerationStrategy: params.callGenerationStrategy,
		callHistory: [],
		preferences: {
			callFrequency: "medium",
			timingBias: "random",
		},
	};
}
