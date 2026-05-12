// Stub file for backward compatibility
// Re-export from the new location

// Re-export specific types that benchmark tests expect
export type {
	SimulatedActorV2 as SimulatedActor,
	SimulatedCallV2 as SimulatedCall,
} from "./services/simulationActorsV2";
export * from "./services/simulationActorsV2";

// Import the actual types to extend
import type { SimulatedActorV2 } from "./services/simulationActorsV2";

// Define the missing types and functions for backward compatibility
export type CallGenerationStrategy = (
	actor: any,
	token: any,
	currentStep: number,
	priceHistory: any[],
) => any;

// Extended type that includes the old properties
export interface SimulatedActorWithLegacy extends SimulatedActorV2 {
	expectedTrustScore?: number;
	callGenerationStrategy?: CallGenerationStrategy;
	actorSpecificData?: {
		calls?: any[];
	};
}

// Helper function to map old archetype names to new ones
function mapArchetype(archetype: string): any {
	const mapping: Record<string, string> = {
		good_caller: "elite_analyst",
		bad_shiller: "rug_promoter",
		neutral_observer: "technical_analyst",
	};
	return mapping[archetype] || archetype;
}

// Placeholder strategies for benchmark tests
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

// Placeholder function for parsing Discord data
export async function parseDiscordDataToActors(
	_filePath: string,
	_runtime: any,
): Promise<SimulatedActorWithLegacy[]> {
	// This is a placeholder - the actual implementation would need to be updated
	// to work with the new actor system
	return [];
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
